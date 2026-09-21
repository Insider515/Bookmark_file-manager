import busboy from 'busboy';
import { createReadStream } from 'node:fs';
import { createRouter, parseSize } from './http.js';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import { FsOps } from './fs-ops.js';
import { FsError, baseName, parentVirtual } from './safe-path.js';
import { parseOctalMode } from './mode.js';
import { createZipStream, zipFileName } from './zip.js';
import {
  DEFAULT_PIXEL_LIMIT,
  RASTER_THUMBNAIL,
  RENDER_WIDTHS,
  VIEWABLE,
  canThumbnail,
  loadSharp,
  rawThumbnailType,
  renderForView,
  renderThumbnail,
} from './thumbnail.js';

/**
 * Routes for every operation, over plain node request and response objects.
 *
 * There is no web framework here on purpose. The handler this builds has the
 * `(req, res, next)` shape, which Express takes as middleware and which any
 * Node framework can hand its raw objects to — so the same build mounts in
 * Express, AdonisJS, Fastify, Nest or bare `node:http`.
 */

/**
 * Content types for inline preview. Anything absent is sent as a download with
 * application/octet-stream, so an unrecognised upload can never be served back
 * as something the browser will execute in the page's origin.
 */
const PREVIEWABLE = new Map(Object.entries({
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.csv': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/vnd.microsoft.icon',
  '.bmp': 'image/bmp',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
}));

/** RFC 5987 filename, so non-ASCII names survive Content-Disposition. */
function contentDisposition(type, filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(filename);
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** Wrap an async handler so rejections reach the error middleware. */
const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

/**
 * The message a client is allowed to see.
 *
 * FsError messages are written for end users and name nothing but the virtual
 * path. Anything else is a raw node error whose `message` embeds the absolute
 * path it failed on ("EMFILE … open '/srv/app/storage/x'"), so it is replaced
 * wholesale and logged server-side instead.
 */
function publicMessage(err, fallback) {
  return err instanceof FsError ? err.message : fallback;
}

/** The origin this request was actually sent to, per its own Host header. */
function selfOrigin(req) {
  const host = req.get('host');
  return host ? `${req.protocol}://${host}` : null;
}

/**
 * Reject a state-changing request that a foreign page sent on the user's behalf.
 *
 * JSON routes are shielded by CORS already — `application/json` is not a
 * simple request, so a cross-origin POST is preflighted and never arrives.
 * `/upload` is not: `multipart/form-data` *is* a simple request, so a plain
 * <form> on any site could post files into the user's storage under their
 * session cookie. Checking Origin closes that, and closes it for every
 * mutating route rather than just the one that happens to be exposed.
 *
 * A request with no Origin and no Sec-Fetch-Site is not from a browser form,
 * so it is allowed: that is curl, a server-to-server call, or a test.
 */
function assertSameOrigin(req, allowedOrigins) {
  if (allowedOrigins === false) return; // host opted out; it has its own scheme
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;

  const site = req.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') {
    throw new FsError(403, 'CROSS_ORIGIN', 'Cross-origin request rejected');
  }

  const origin = req.get('origin');
  if (!origin) return; // no browser context to protect against

  const allowed =
    typeof allowedOrigins === 'function'
      ? allowedOrigins(origin, req)
      : Array.isArray(allowedOrigins)
        ? allowedOrigins.includes(origin)
        : origin === selfOrigin(req);

  if (!allowed) {
    // "null" arrives from sandboxed iframes and some redirect chains; it is
    // not same-origin and must not be treated as absent.
    throw new FsError(403, 'CROSS_ORIGIN', 'Cross-origin request rejected');
  }
}

/**
 * Read ahead of the consumer by at most `size` items.
 *
 * Walking a directory and compressing it are both slow and neither needs the
 * other to pause: without a buffer between them the zip writer stops on every
 * `stat` and the walk stops on every deflate, which costs more wall clock than
 * doing them one after the other did. The bound is what keeps this a pipeline
 * rather than a rebuilt in-memory list — the whole point of streaming.
 *
 * The consumer leaving early (a cancelled download) stops the walk instead of
 * letting it run to completion for nobody.
 */
async function* prefetch(source, size = 256) {
  const buffer = [];
  let done = false;
  let failure = null;
  let stopped = false;
  let onItem = null;
  let onSpace = null;

  const release = (slot) => {
    if (slot === 'item' && onItem) {
      const resolve = onItem;
      onItem = null;
      resolve();
    } else if (slot === 'space' && onSpace) {
      const resolve = onSpace;
      onSpace = null;
      resolve();
    }
  };

  const pump = (async () => {
    try {
      for await (const item of source) {
        if (stopped) break; // breaking closes the source generator
        buffer.push(item);
        release('item');
        if (buffer.length >= size && !stopped) {
          await new Promise((resolve) => {
            onSpace = resolve;
          });
        }
      }
    } catch (err) {
      failure = err;
    } finally {
      done = true;
      release('item');
    }
  })();

  try {
    for (;;) {
      if (buffer.length === 0) {
        if (done) break;
        await new Promise((resolve) => {
          onItem = resolve;
        });
        continue;
      }
      const item = buffer.shift();
      if (buffer.length < size) release('space');
      yield item;
    }
    if (failure) throw failure;
  } finally {
    stopped = true;
    release('space');
    await pump.catch(() => {});
  }
}

/** Accept `paths` as either a JSON array or a single string. */
function readPaths(body, limit) {
  const raw = body?.paths ?? body?.path;
  const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  if (list.length === 0) {
    throw new FsError(400, 'NO_SELECTION', 'Nothing was selected');
  }
  if (list.length > limit) {
    throw new FsError(400, 'TOO_MANY', `At most ${limit} items can be handled at once`, { limit });
  }
  for (const item of list) {
    if (typeof item !== 'string') {
      throw new FsError(400, 'INVALID_PATH', 'The path must be a string');
    }
  }
  return list;
}

/** Normalise `?paths=a&paths=b` (or a single `?path=`) into an array. */
function readQueryPaths(query, limit) {
  const raw = query.paths ?? query.path;
  const list = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).map(String);
  if (list.length === 0) {
    throw new FsError(400, 'NO_SELECTION', 'Nothing was selected');
  }
  if (list.length > limit) {
    throw new FsError(400, 'TOO_MANY', `At most ${limit} items can be downloaded at once`, {
      limit,
    });
  }
  return list;
}

/**
 * What the request is about, in the vocabulary the host's `authorize` hook
 * thinks in: which entries, and where they are going. Without this the hook
 * only ever saw "POST /delete" and could not make a per-path decision.
 */
function describeRequest(req) {
  const route = req.path;
  const asList = (value) =>
    value === undefined || value === null
      ? []
      : (Array.isArray(value) ? value : [value]).filter((item) => typeof item === 'string');

  switch (route) {
    case '/list':
    case '/tree':
    case '/stat':
    case '/thumbnail':
    case '/properties':
    case '/archive/list':
    case '/render':
    case '/sheet':
    case '/text':
    case '/document':
    case '/search':
      return { paths: asList(req.query.path), destination: null, name: null };
    case '/download':
      return { paths: asList(req.query.paths ?? req.query.path), destination: null, name: null };
    case '/directory':
    case '/file':
      return { paths: asList(req.body?.path), destination: asList(req.body?.path)[0] ?? null, name: req.body?.name ?? null };
    case '/rename':
      return { paths: asList(req.body?.path), destination: null, name: req.body?.name ?? null };
    case '/move':
    case '/copy':
      return {
        paths: asList(req.body?.paths ?? req.body?.path),
        destination: typeof req.body?.destination === 'string' ? req.body.destination : null,
        name: null,
      };
    case '/delete':
    case '/chmod':
      return { paths: asList(req.body?.paths ?? req.body?.path), destination: null, name: null };
    case '/archive':
      return {
        paths: asList(req.body?.paths ?? req.body?.path),
        destination: typeof req.body?.destination === 'string' ? req.body.destination : null,
        name: req.body?.name ?? null,
      };
    case '/sheet/save':
    case '/text/save':
    case '/document/save':
      return { paths: asList(req.body?.path), destination: null, name: null };
    case '/document/pages':
      return {
        // A merge reads from several files and may write to a new one, so all
        // of them have to reach the audit hook, not just the one being edited.
        paths: [...asList(req.body?.path), ...asList(req.body?.sources)],
        destination: typeof req.body?.target === 'string' ? req.body.target : null,
        name: null,
      };
    case '/extract':
      return {
        paths: asList(req.body?.path),
        destination: typeof req.body?.destination === 'string' ? req.body.destination : null,
        name: null,
      };
    case '/upload':
      // The destination is not known until the body is parsed; the upload
      // handler asks again once it is.
      return { paths: [], destination: null, name: null, pending: true };
    default:
      return { paths: [], destination: null, name: null };
  }
}

/**
 * Build an Express router exposing one directory as a file-manager API.
 * Mount it anywhere in a host application:
 *
 *   app.use('/api/files', createFileManagerRouter({ root: './storage' }))
 *
 * @param {object} options
 * @param {string} options.root directory to expose (created if missing)
 * @param {boolean} [options.readOnly=false] reject every mutating route
 * @param {object} [options.permissions] per-operation switches
 * @param {number} [options.maxUploadSize] bytes per uploaded file
 * @param {number} [options.maxUploadFiles=50] files per upload request
 * @param {number} [options.maxRequestSize] bytes per upload request, all files together
 * @param {number} [options.maxConcurrentUploads=8] upload requests in flight at once
 * @param {number} [options.maxBatchPaths=1000] entries per move/copy/delete/download
 * @param {number} [options.minFreeSpace] refuse uploads below this much free disk
 * @param {boolean} [options.exposeUsage=false] include filesystem total/free in /config
 * @param {string} [options.basePath] prefix to strip from the URL when the host
 *   mounts at one without rewriting `req.url` (Express rewrites it; AdonisJS
 *   and bare node:http do not)
 * @param {string[]|((origin: string, req: object) => boolean)|false} [options.allowedOrigins]
 *   origins allowed to make mutating requests; defaults to same-origin only,
 *   `false` disables the check
 * @param {(req: object, action: string, context: object) => (boolean|Promise<boolean>)} [options.authorize]
 *   called before every operation; return false to reject with 403. `context`
 *   carries `{route, paths, destination, name}`. For `/upload` it is called
 *   twice: once before the body is parsed (`destination: null`) and once more
 *   with the resolved destination before anything is written.
 * @param {(message: string, detail?: any) => void} [options.onWarning]
 * @returns {(req: object, res: object, next?: Function) => Promise<boolean>} a
 *   handler that answers the request, or returns false when the path is not
 *   one of its own
 */
export function createFileManagerHandler(options = {}) {
  const ops = new FsOps({
    root: options.root,
    readOnly: options.readOnly ?? false,
    permissions: options.permissions,
    maxUploadSize: options.maxUploadSize ?? 100 * 1024 * 1024,
    minFreeSpace: options.minFreeSpace,
    maxListEntries: options.maxListEntries,
    maxTreeChildren: options.maxTreeChildren,
    concurrency: options.concurrency,
    archiveTools: options.archiveTools ?? true,
    archiveLimits: options.archiveLimits,
    sheetLimits: options.sheetLimits,
    documentLimits: options.documentLimits,
    searchLimits: options.searchLimits,
    textLimits: options.textLimits,
    onWarning: options.onWarning,
  });
  const maxUploadFiles = options.maxUploadFiles ?? 50;
  const maxRequestSize = options.maxRequestSize ?? 1024 * 1024 * 1024;
  const maxConcurrentUploads = Math.max(1, options.maxConcurrentUploads ?? 8);
  const maxBatchPaths = Math.max(1, options.maxBatchPaths ?? 1000);
  const maxSizeWalkEntries = Math.max(1, options.maxSizeWalkEntries ?? 200000);
  const maxSheetBody = options.maxSheetBody ?? '16mb';
  /**
   * Shared by /thumbnail and /render: both are the same CPU.
   *
   * A queue rather than a flat refusal. Rejecting the overflow looked safe and
   * was not: a grid of a dozen images fires its requests at once, four get
   * through and the rest fall back to a generic icon — the user sees a folder
   * of photos rendered as blank sheets, with nothing to say why. Waiting a
   * moment for a slot is the right trade; only a queue that is itself absurdly
   * long still turns anyone away.
   */
  const renderQueue = { active: 0, waiting: [] };

  const acquireRender = () => {
    if (renderQueue.active < maxConcurrentThumbnails) {
      renderQueue.active += 1;
      return Promise.resolve(true);
    }
    if (renderQueue.waiting.length >= maxQueuedThumbnails) return Promise.resolve(false);
    return new Promise((resolve) => renderQueue.waiting.push(resolve));
  };

  const releaseRender = () => {
    const next = renderQueue.waiting.shift();
    if (next) next(true);
    else renderQueue.active -= 1;
  };
  const exposeUsage = options.exposeUsage ?? false;
  const thumbnails = options.thumbnails ?? true;
  const thumbnailSizes = options.thumbnailSizes ?? [64, 128, 256];
  const maxRawThumbnailSize = options.maxRawThumbnailSize ?? 512 * 1024;
  const thumbnailPixelLimit = options.thumbnailPixelLimit ?? DEFAULT_PIXEL_LIMIT;
  const maxConcurrentThumbnails = Math.max(1, options.maxConcurrentThumbnails ?? 4);
  const maxQueuedThumbnails = Math.max(1, options.maxQueuedThumbnails ?? 64);
  const allowedOrigins = options.allowedOrigins;
  const authorize = options.authorize;
  const warn = (message, detail) => options.onWarning?.(message, detail);

  /** Ask the host's hook about one operation. No hook means "allowed". */
  const checkAuthorized = async (req, context) => {
    if (!authorize) return;
    const action = `${req.method} ${req.path}`;
    const allowed = await authorize(req, action, { route: req.path, ...context });
    if (!allowed) throw new FsError(403, 'FORBIDDEN', 'The operation is not allowed');
  };

  /**
   * How large a JSON body this route may have.
   *
   * The editors post whole documents, so their save routes allow far more than
   * everything else. This is a function of the request rather than one global
   * number because a single limit could only be wrong in one direction: small
   * enough to reject a spreadsheet, or large enough to let any route be used
   * to buffer a gigabyte.
   */
  const BIG_BODY_ROUTES = new Set(['/text/save', '/sheet/save', '/document/save']);
  const smallBodyLimit = parseSize('1mb');
  const largeBodyLimit = parseSize(maxSheetBody, parseSize('16mb'));
  const jsonLimit = (req) =>
    BIG_BODY_ROUTES.has(req.path) ? largeBodyLimit : smallBodyLimit;

  const router = createRouter({ basePath: options.basePath ?? '', jsonLimit });

  // A single init promise shared by every request: the first one performs the
  // mkdir/realpath, the rest await the same result.
  const ready = ops.init();
  router.use(wrap(async (req, _res, next) => {
    await ready;
    assertSameOrigin(req, allowedOrigins);
    await checkAuthorized(req, describeRequest(req));
    next();
  }));

  router.get('/config', wrap(async (_req, res) => {
    res.json({
      readOnly: ops.readOnly,
      // The widget mirrors these in its toolbar. They are advisory to the UI
      // only — every route below enforces them again.
      permissions: ops.permissions,
      maxUploadSize: ops.maxUploadSize,
      maxUploadFiles,
      maxRequestSize,
      // The widget only asks for a thumbnail when the server says it serves
      // them, and only at a size the server accepts.
      thumbnails,
      thumbnailSizes,
      // Distinct from permissions.chmod: that says whether it is allowed, this
      // says whether the platform has the concept. The widget hides the
      // controls entirely when the answer is no.
      chmodSupported: ops.chmodSupported,
      // Computed from the Node version and the programs actually installed, so
      // the widget only ever offers a format that will work here.
      archiveFormats: ops.archiveCapabilities(),
      // Which image formats the viewer may open, and which of them this server
      // has to convert first. Computed, so the widget never promises a format
      // that would arrive broken.
      imageView: ops.imageCapabilities(),
      // All four are always available: none of them needs an external tool.
      sheetFormats: ops.sheetCapabilities(),
      // docx, odt and doc are read and written; PDF is read, and edited by
      // the page rather than by the word. `preserves` says whether saving
      // keeps the parts of a file the editor does not model.
      documentFormats: ops.documentCapabilities(),
      // What a search may do here. `content` is separate because grepping
      // inside files needs `download`, not merely the right to list them.
      search: ops.searchCapabilities(),
      // Off by default: free/total bytes describe the server's disk, not the
      // user's files, and every authenticated user would otherwise see them.
      usage: exposeUsage ? await ops.usage() : null,
    });
  }));

  router.get('/list', wrap(async (req, res) => {
    res.json(await ops.list(req.query.path));
  }));

  router.get('/tree', wrap(async (req, res) => {
    const depth = req.query.depth === undefined ? 1 : Number(req.query.depth);
    if (!Number.isFinite(depth) || depth < 0) {
      throw new FsError(400, 'INVALID_DEPTH', 'depth must be a non-negative number');
    }
    res.json(await ops.tree(req.query.path, depth));
  }));

  router.get('/stat', wrap(async (req, res) => {
    res.json(await ops.stat(req.query.path));
  }));

  router.get('/properties', wrap(async (req, res) => {
    // Computing a directory's total size walks its whole tree, so it happens
    // only when the client asks: the dialog opens immediately and fills that
    // one field in on demand.
    res.json(
      await ops.properties(req.query.path, {
        computeSize: req.query.size === '1',
        sizeLimit: maxSizeWalkEntries,
      })
    );
  }));

  /**
   * Change permission bits. Either `mode` ("755") or `executable` (true/false),
   * optionally `recursive` for a directory.
   */
  router.post('/chmod', wrap(async (req, res) => {
    const paths = readPaths(req.body, maxBatchPaths);
    const hasMode = req.body?.mode !== undefined;
    const hasExecutable = req.body?.executable !== undefined;
    if (hasMode === hasExecutable) {
      throw new FsError(
        400,
        'INVALID_MODE',
        'Give exactly one: mode (“755”) or executable (true/false)'
      );
    }
    res.json(
      await ops.chmod(paths, {
        mode: hasMode ? parseOctalMode(req.body.mode) : undefined,
        executable: hasExecutable ? !!req.body.executable : undefined,
        recursive: !!req.body?.recursive,
      })
    );
  }));

  router.post('/directory', wrap(async (req, res) => {
    res.status(201).json(await ops.createDirectory(req.body?.path, req.body?.name));
  }));

  router.post('/file', wrap(async (req, res) => {
    const content = typeof req.body?.content === 'string' ? req.body.content : '';
    res.status(201).json(await ops.createFile(req.body?.path, req.body?.name, content));
  }));

  router.post('/rename', wrap(async (req, res) => {
    res.json(await ops.rename(req.body?.path, req.body?.name));
  }));

  router.post('/move', wrap(async (req, res) => {
    const paths = readPaths(req.body, maxBatchPaths);
    const skipped = [];
    const moved = await ops.move(paths, req.body?.destination, {
      overwrite: !!req.body?.overwrite,
      onSkip: (info) => skipped.push(info),
    });
    if (skipped.length) warn('Entries skipped while moving', skipped);
    res.json(moved);
  }));

  router.post('/copy', wrap(async (req, res) => {
    const paths = readPaths(req.body, maxBatchPaths);
    const skipped = [];
    const copied = await ops.copy(paths, req.body?.destination, {
      overwrite: !!req.body?.overwrite,
      onSkip: (info) => skipped.push(info),
    });
    if (skipped.length) warn('Entries skipped while copying', skipped);
    res.json(copied);
  }));

  router.post('/delete', wrap(async (req, res) => {
    const paths = readPaths(req.body, maxBatchPaths);
    res.json({ removed: await ops.remove(paths) });
  }));

  /** Read a file as text for the code editor. */
  router.get('/text', wrap(async (req, res) => {
    res.json(await ops.readText(req.query.path));
  }));

  /**
   * Save edited text. `{ path, text, encoding?, bom?, newline? }`
   *
   * Shares the wider body limit with the spreadsheet route: a source file
   * passes the JSON parser's 1 MB default easily.
   */
  router.post('/text/save', wrap(async (req, res) => {
    if (typeof req.body?.path !== 'string') {
      throw new FsError(400, 'INVALID_PATH', 'Give the path to the file');
    }
    res.json(
      await ops.writeText(req.body.path, req.body.text, {
        encoding: req.body.encoding,
        bom: req.body.bom,
        newline: req.body.newline,
      })
    );
  }));

  /** Open a spreadsheet as a workbook the editor can render. */
  router.get('/sheet', wrap(async (req, res) => {
    res.json(await ops.readSheet(req.query.path));
  }));

  /**
   * Save an edited workbook. `{ path, workbook, format? }`
   *
   * The body carries a whole workbook, which is larger than the 1 MB the JSON
   * parser allows by default — a few thousand cells of text passes it easily —
   * so this route gets its own, wider limit.
   */
  router.post('/sheet/save', wrap(async (req, res) => {
    if (typeof req.body?.path !== 'string') {
      throw new FsError(400, 'INVALID_PATH', 'Give the path to the spreadsheet');
    }
    if (!req.body?.workbook || !Array.isArray(req.body.workbook.sheets)) {
      throw new FsError(400, 'INVALID_WORKBOOK', 'The request body carries no workbook');
    }
    res.json(
      await ops.writeSheet(req.body.path, req.body.workbook, { format: req.body.format })
    );
  }));

  /**
   * Search the tree. `?path=&query=&mode=&type=&scope=&extensions=&…`
   *
   * A GET because it reads and returns; the parameters are short enough for a
   * query string and it keeps the route cacheable by anything in front of it.
   */
  router.get('/search', wrap(async (req, res) => {
    res.json(
      await ops.search(req.query.path, {
        query: req.query.query,
        mode: req.query.mode,
        type: req.query.type,
        scope: req.query.scope,
        extensions: req.query.extensions,
        // Absent means off, which is the safer default for both of these.
        caseSensitive: req.query.caseSensitive === '1' || req.query.caseSensitive === 'true',
        maxDepth: req.query.maxDepth,
        limit: req.query.limit,
      })
    );
  }));

  /** Open a document: rich text for docx/odt/doc, pages for PDF. */
  router.get('/document', wrap(async (req, res) => {
    res.json(await ops.readDocument(req.query.path));
  }));

  /**
   * Save an edited document. `{ path, document, format? }`
   *
   * Shares the wider body limit with the spreadsheet route, for the same
   * reason: a document's blocks are far past the 1 MB default.
   */
  router.post('/document/save', wrap(async (req, res) => {
    if (typeof req.body?.path !== 'string') {
      throw new FsError(400, 'INVALID_PATH', 'Give the path to the document');
    }
    if (!req.body?.document || !Array.isArray(req.body.document.blocks)) {
      throw new FsError(400, 'INVALID_DOCUMENT', 'The request body carries no document');
    }
    res.json(
      await ops.writeDocument(req.body.path, req.body.document, { format: req.body.format })
    );
  }));

  /**
   * Rearrange the pages of a PDF. `{ path, plan[], sources?[], target? }`
   *
   * Deleting, reordering, rotating, splitting and merging all arrive here:
   * the plan lists the pages to keep, in order, and where each came from.
   */
  router.post('/document/pages', wrap(async (req, res) => {
    if (typeof req.body?.path !== 'string') {
      throw new FsError(400, 'INVALID_PATH', 'Give the path to the PDF');
    }
    if (!Array.isArray(req.body?.plan)) {
      throw new FsError(400, 'INVALID_PLAN', 'The request body carries no page plan');
    }
    // Empty is the normal case: only a merge names extra files, and readPaths
    // treats an empty selection as a mistake.
    const extra = req.body.sources ?? [];
    const sources = Array.isArray(extra) && extra.length === 0
      ? []
      : readPaths({ paths: extra }, maxBatchPaths);
    res.json(
      await ops.writeDocumentPages(req.body.path, req.body.plan, {
        sources,
        target: typeof req.body.target === 'string' ? req.body.target : undefined,
      })
    );
  }));

  /** What is inside an archive, without writing anything to disk. */
  router.get('/archive/list', wrap(async (req, res) => {
    res.json(await ops.listArchive(req.query.path));
  }));

  /** Pack a selection. `{ paths[], format, destination?, name? }` */
  router.post('/archive', wrap(async (req, res) => {
    const paths = readPaths(req.body, maxBatchPaths);
    res.status(201).json(
      await ops.createArchive(paths, {
        format: req.body?.format,
        destination: req.body?.destination,
        name: req.body?.name,
      })
    );
  }));

  /** Unpack one archive. `{ path, destination? }` */
  router.post('/extract', wrap(async (req, res) => {
    if (typeof req.body?.path !== 'string') {
      throw new FsError(400, 'INVALID_PATH', 'Give the path to the archive');
    }
    res.status(201).json(
      await ops.extractArchive(req.body.path, { destination: req.body?.destination })
    );
  }));

  /**
   * A viewable rendition of one image.
   *
   * Separate from /thumbnail, which fits a square tile, and from /download,
   * which hands over the file untouched. This is for the formats no browser
   * will draw — TIFF and HEIC — converted to WebP and bounded so a
   * hundred-megapixel scan does not arrive at full size.
   */
  router.get('/render', wrap(async (req, res) => {
    if (!ops.can('download')) {
      throw new FsError(403, 'PERMISSION_DENIED', 'The “downloading” operation is not allowed', {
        permission: 'download',
      });
    }

    const width = req.query.width === undefined ? RENDER_WIDTHS[2] : Number(req.query.width);
    if (!RENDER_WIDTHS.includes(width)) {
      throw new FsError(400, 'INVALID_SIZE', `Allowed sizes: ${RENDER_WIDTHS.join(', ')}`);
    }

    const file = await ops.resolveForDownload(req.query.path);
    if (file.isDirectory) {
      throw new FsError(400, 'IS_A_DIRECTORY', `Is a directory: ${file.virtual}`, {
        path: file.virtual,
      });
    }
    const extension = path.extname(file.name).slice(1).toLowerCase();
    if (!VIEWABLE.has(extension)) {
      throw new FsError(415, 'NOT_VIEWABLE', 'This file type is not displayed');
    }
    if (!RASTER_THUMBNAIL.has(extension) || !loadSharp()) {
      // Browser-native formats belong on /download?inline=1, byte for byte.
      throw new FsError(415, 'NO_RENDER', 'Conversion is unnecessary or unavailable for this format');
    }

    const etag =
      `W/"v${width}-${file.size.toString(16)}-${Math.floor(file.modified.getTime()).toString(16)}"`;
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'private, no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Last-Modified', file.modified.toUTCString());

    const ifNoneMatch = req.get('if-none-match');
    if (
      ifNoneMatch &&
      ifNoneMatch.split(',').map((tag) => tag.trim()).some((tag) => tag === etag || tag === '*')
    ) {
      return res.status(304).end();
    }

    if (!(await acquireRender())) {
      res.setHeader('Retry-After', '1');
      throw new FsError(503, 'BUSY', 'The server is busy processing images');
    }

    let rendered = null;
    try {
      rendered = await renderForView(file.absolute, extension, {
        width,
        pixelLimit: thumbnailPixelLimit,
      });
    } catch (err) {
      warn(`Could not render the image: ${file.virtual}`, err);
      throw new FsError(415, 'NO_RENDER', 'Could not convert the image');
    } finally {
      releaseRender();
    }

    if (!rendered) {
      throw new FsError(415, 'NO_RENDER', 'Could not convert the image');
    }

    // The original dimensions travel in a header so the viewer can report what
    // the file really is, not what it was shrunk to for display.
    if (rendered.width) res.setHeader('X-Image-Width', String(rendered.width));
    if (rendered.height) res.setHeader('X-Image-Height', String(rendered.height));
    res.setHeader('Content-Type', rendered.contentType);
    res.setHeader('Content-Length', rendered.buffer.length);
    return res.end(rendered.buffer);
  }));

  /**
   * Thumbnail for one image.
   *
   * Separate from /download on purpose. A grid of tiles that pointed at
   * /download would make the browser pull every original at full size to draw
   * a 128px square — for a folder of photos that is hundreds of megabytes for
   * something the user may never look at.
   */
  router.get('/thumbnail', wrap(async (req, res) => {
    if (!thumbnails) {
      throw new FsError(404, 'NO_THUMBNAILS', 'Thumbnails are turned off');
    }
    // A thumbnail is the file's content, just smaller; it belongs behind the
    // same permission as reading the file itself.
    if (!ops.can('download')) {
      throw new FsError(403, 'PERMISSION_DENIED', 'The “downloading” operation is not allowed', {
        permission: 'download',
      });
    }

    const size = req.query.size === undefined ? thumbnailSizes[0] : Number(req.query.size);
    if (!thumbnailSizes.includes(size)) {
      // An open-ended size parameter is an invitation to fill the CPU with
      // one-off renders that no cache will ever be asked for twice.
      throw new FsError(400, 'INVALID_SIZE', `Allowed sizes: ${thumbnailSizes.join(', ')}`);
    }

    const file = await ops.resolveForDownload(req.query.path);
    if (file.isDirectory) {
      throw new FsError(400, 'IS_A_DIRECTORY', `Is a directory: ${file.virtual}`, {
        path: file.virtual,
      });
    }
    const extension = path.extname(file.name).slice(1).toLowerCase();
    if (!canThumbnail(extension)) {
      throw new FsError(415, 'NO_THUMBNAIL', 'No thumbnail is built for this file type');
    }

    // Same inputs as /download's validator, plus everything that would change
    // the bytes produced: the requested size and how they were produced.
    const viaSharp = RASTER_THUMBNAIL.has(extension) && loadSharp() !== null;
    const etag =
      `W/"t${size}-${viaSharp ? 'webp' : extension}-` +
      `${file.size.toString(16)}-${Math.floor(file.modified.getTime()).toString(16)}"`;
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'private, no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Last-Modified', file.modified.toUTCString());

    const ifNoneMatch = req.get('if-none-match');
    if (
      ifNoneMatch &&
      ifNoneMatch.split(',').map((tag) => tag.trim()).some((tag) => tag === etag || tag === '*')
    ) {
      return res.status(304).end();
    }

    // Pass-through: formats libvips cannot read, and everything when sharp is
    // not installed. Bounded by size, so this never becomes a way to pull a
    // huge original through an endpoint meant for small ones.
    const streamOriginal = () => {
      if (file.size > maxRawThumbnailSize) {
        throw new FsError(415, 'NO_THUMBNAIL', 'The file is too large for an unprocessed thumbnail');
      }
      const type = rawThumbnailType(extension) ?? PREVIEWABLE.get(`.${extension}`) ?? 'application/octet-stream';
      res.setHeader('Content-Type', type);
      res.setHeader('Content-Length', file.size);
      return pipeline(createReadStream(file.absolute), res);
    };

    // Nothing to render: .ico, .svg, or no sharp installed. Streaming costs no
    // CPU, so it must not queue behind the renders.
    if (!viaSharp) return streamOriginal();

    if (!(await acquireRender())) {
      res.setHeader('Retry-After', '1');
      throw new FsError(503, 'BUSY', 'The server is busy building thumbnails');
    }

    let rendered = null;
    try {
      rendered = await renderThumbnail(file.absolute, extension, {
        size,
        pixelLimit: thumbnailPixelLimit,
      });
    } catch (err) {
      // A corrupt or hostile image must not take the route down; the client
      // falls back to the drawn icon on any non-200.
      warn(`Could not build the thumbnail: ${file.virtual}`, err);
      throw new FsError(415, 'NO_THUMBNAIL', 'Could not build the thumbnail');
    } finally {
      releaseRender();
    }

    if (!rendered) return streamOriginal();

    res.setHeader('Content-Type', rendered.contentType);
    res.setHeader('Content-Length', rendered.buffer.length);
    return res.end(rendered.buffer);
  }));

  /**
   * Download. One file streams as-is (with range support so media can seek);
   * a directory, or any multi-selection, streams as a zip built on the fly.
   * `paths` may repeat: /download?paths=/a.txt&paths=/b.txt
   */
  router.get('/download', wrap(async (req, res) => {
    if (!ops.can('download')) {
      throw new FsError(403, 'PERMISSION_DENIED', 'The “downloading” operation is not allowed', {
        permission: 'download',
      });
    }
    const list = readQueryPaths(req.query, maxBatchPaths);

    const resolved = [];
    for (const virtual of list) {
      resolved.push(await ops.resolveForDownload(virtual));
    }

    // Single regular file: stream it directly.
    if (resolved.length === 1 && !resolved[0].isDirectory) {
      const file = resolved[0];
      const ext = path.extname(file.name).toLowerCase();
      const preview = PREVIEWABLE.get(ext);
      const inline = preview && req.query.inline === '1';

      res.setHeader('Content-Type', inline ? preview : 'application/octet-stream');
      res.setHeader('Content-Disposition', contentDisposition(inline ? 'inline' : 'attachment', file.name));
      res.setHeader('Last-Modified', file.modified.toUTCString());
      res.setHeader('ETag', file.etag);
      // These files are private to the user; let the browser keep a copy but
      // make it revalidate, which is what makes the ETag worth sending.
      res.setHeader('Cache-Control', 'private, no-cache');
      res.setHeader('Accept-Ranges', 'bytes');
      // Nothing here is a trusted document; block sniffing and framing so a
      // stored .html or .svg cannot be used against the host application.
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");

      // An unchanged file costs one round trip instead of its whole body.
      const ifNoneMatch = req.get('if-none-match');
      const ifModifiedSince = req.get('if-modified-since');
      const etagMatches =
        ifNoneMatch !== undefined &&
        ifNoneMatch
          .split(',')
          .map((tag) => tag.trim())
          .some((tag) => tag === file.etag || tag === '*');
      const notModifiedSince =
        ifNoneMatch === undefined &&
        ifModifiedSince !== undefined &&
        Number.isFinite(Date.parse(ifModifiedSince)) &&
        Math.floor(file.modified.getTime() / 1000) <= Math.floor(Date.parse(ifModifiedSince) / 1000);
      if (etagMatches || notModifiedSince) {
        return res.status(304).end();
      }

      const range = req.headers.range;
      const match = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (match && file.size > 0) {
        let start = match[1] === '' ? null : Number(match[1]);
        let end = match[2] === '' ? null : Number(match[2]);
        if (start === null && end !== null) {
          // Suffix range: the last N bytes.
          start = Math.max(0, file.size - end);
          end = file.size - 1;
        } else {
          start = start ?? 0;
          end = end === null ? file.size - 1 : Math.min(end, file.size - 1);
        }
        if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= file.size) {
          res.status(416).setHeader('Content-Range', `bytes */${file.size}`);
          return res.end();
        }
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${file.size}`);
        res.setHeader('Content-Length', end - start + 1);
        return pipeline(createReadStream(file.absolute, { start, end }), res);
      }

      res.setHeader('Content-Length', file.size);
      return pipeline(createReadStream(file.absolute), res);
    }

    // Directory or multi-selection: build a zip. Its size is unknown up front,
    // so the response is chunked rather than Content-Length'd.
    const archiveBase =
      resolved.length === 1 ? resolved[0].name : baseName(parentVirtual(resolved[0].virtual)) || 'files';

    /**
     * Yielded lazily, so the archive starts streaming during the walk instead
     * of after it. A directory with a million files then costs a constant
     * amount of memory rather than a list of a million entries.
     */
    async function* entries() {
      for (const item of resolved) {
        if (item.isDirectory) {
          // Prefix with the folder's own name so the archive unpacks into a
          // folder instead of scattering its contents.
          const prefix = resolved.length === 1 ? '' : item.name;
          yield* ops.walkFiles(item.absolute, prefix);
        } else {
          yield {
            absolute: item.absolute,
            relative: item.name,
            size: item.size,
            modified: item.modified,
          };
        }
      }
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', contentDisposition('attachment', zipFileName(archiveBase)));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');

    const skipped = [];
    const archive = createZipStream(prefetch(entries(), 1024), {
      onError: (err, file) => skipped.push({ file: file.relative, message: err.message }),
    });
    await pipeline(archive, res);
    if (skipped.length) {
      // The response is already sent; surface it in the server log instead.
      warn(`Files skipped while archiving: ${skipped.length}`, skipped);
    }
  }));

  /**
   * Upload. Multipart; the destination directory travels either as the `path`
   * query parameter or as a `path` field ordered before the files.
   */
  let uploadsInFlight = 0;
  router.post('/upload', wrap(async (req, res) => {
    if (!ops.can('upload')) {
      // Checked before parsing the body, so a forbidden upload is refused
      // without streaming megabytes to a server that will reject them.
      throw new FsError(
        403,
        ops.readOnly ? 'READ_ONLY' : 'PERMISSION_DENIED',
        ops.readOnly
          ? 'The manager is open in read-only mode'
          : 'The “uploading” operation is not allowed',
        ops.readOnly ? null : { permission: 'upload' }
      );
    }
    if (!/^multipart\/form-data/i.test(req.headers['content-type'] || '')) {
      throw new FsError(400, 'NOT_MULTIPART', 'multipart/form-data was expected');
    }
    if (uploadsInFlight >= maxConcurrentUploads) {
      res.setHeader('Retry-After', '1');
      throw new FsError(503, 'BUSY', 'The server is busy with other uploads, try again');
    }

    uploadsInFlight += 1;
    try {
      const uploaded = [];
      const failures = [];
      let destination = typeof req.query.path === 'string' ? req.query.path : '/';
      const overwrite = req.query.overwrite === '1';

      // Whichever destination is finally used has to pass the host's hook. The
      // middleware could not check it: for multipart the body is still on the
      // wire at that point, and the `path` field may override the query
      // parameter — so a hook that only saw `req.query.path` was checking a
      // value the upload need not honour.
      let approvedDestination = null;
      const approveDestination = async (candidate) => {
        if (approvedDestination === candidate) return;
        await checkAuthorized(req, { paths: [candidate], destination: candidate, name: null });
        approvedDestination = candidate;
      };

      await new Promise((resolve, reject) => {
        let pending = 0;
        let finished = false;
        let settled = false;
        let fileCount = 0;
        let sawFile = false;
        let receivedBytes = 0;
        /** Parts still being read, so an abort can put an end to them. */
        const live = new Set();

        const bb = busboy({
          headers: req.headers,
          limits: { fileSize: ops.maxUploadSize, files: maxUploadFiles },
          // Browsers put raw UTF-8 bytes in the `filename` parameter, but
          // busboy defaults to latin1 — without this, "звіт.pdf" lands on disk
          // as "Ð¾Ñ‚Ñ‡Ñ‘Ñ‚.pdf".
          defParamCharset: 'utf8',
        });

        const settle = (err) => {
          if (settled) return;
          settled = true;
          if (err) {
            // A request that dies mid-part leaves busboy silent: the part
            // stream gets no 'end', no 'error' and no 'close'. Whoever is
            // writing it then waits for ever, and its two half-finished files
            // — the temp copy and the reserved destination name — are never
            // cleaned up. Three cancelled uploads left three empty
            // `report.pdf`s in the user's folder. Ending the part here is what
            // lets writeUpload fail and clean up after itself.
            for (const part of live) part.destroy(err);
            live.clear();
            reject(err);
          } else {
            resolve();
          }
        };

        const maybeDone = () => {
          if (finished && pending === 0) settle();
        };

        // busboy caps each file; nothing caps their sum, so a request with
        // fifty files just under the per-file limit could still be enormous.
        req.on('data', (chunk) => {
          receivedBytes += chunk.length;
          if (receivedBytes > maxRequestSize) {
            req.unpipe(bb);
            req.destroy();
            settle(new FsError(413, 'TOO_LARGE', 'The request is over the size limit'));
          }
        });

        bb.on('field', (name, value) => {
          if (name !== 'path' || typeof value !== 'string') return;
          if (sawFile) {
            // Files already went to the previous destination; honouring this
            // now would split one request across two directories.
            failures.push({ name: '', message: 'The “path” field must come before the files' });
            return;
          }
          destination = value;
        });

        bb.on('file', (_field, stream, info) => {
          sawFile = true;
          fileCount += 1;
          if (fileCount > maxUploadFiles) {
            stream.resume();
            return;
          }
          pending += 1;
          live.add(stream);
          stream.once('close', () => live.delete(stream));
          // busboy truncates at the size limit rather than erroring; catch that
          // so the client is told the file was rejected instead of silently
          // receiving a partial upload.
          let truncated = false;
          stream.on('limit', () => {
            truncated = true;
          });

          approveDestination(destination)
            .then(() => ops.writeUpload(destination, info.filename, stream, { overwrite }))
            .then((entry) => {
              if (truncated) {
                failures.push({
                  name: info.filename,
                  message: `The file is over the ${Math.floor(ops.maxUploadSize / 1024 / 1024)} MB limit`,
                });
                return ops.remove([entry.path]).catch(() => {});
              }
              uploaded.push(entry);
              return undefined;
            })
            .catch((err) => {
              if (!(err instanceof FsError)) warn('Error while storing the uploaded file', err);
              failures.push({
                name: info.filename,
                message: publicMessage(err, 'Could not save the file'),
              });
              stream.resume();
            })
            .finally(() => {
              pending -= 1;
              maybeDone();
            });
        });

        bb.on('filesLimit', () => {
          failures.push({ name: '', message: `At most ${maxUploadFiles} files can be uploaded at once` });
        });
        bb.on('error', settle);
        bb.on('close', () => {
          finished = true;
          maybeDone();
        });

        req.on('aborted', () => settle(new FsError(400, 'ABORTED', 'The upload was aborted')));
        req.pipe(bb);
      });

      if (uploaded.length === 0 && failures.length > 0) {
        return res.status(400).json({ error: failures[0].message, code: 'UPLOAD_FAILED', uploaded, failures });
      }
      res.status(201).json({ uploaded, failures });
    } finally {
      uploadsInFlight -= 1;
    }
  }));

  // Error middleware. Keeps FsError messages (they are written for end users)
  // and hides everything else behind a generic message.
  router.use((err, _req, res, _next) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (err instanceof FsError) {
      res.status(err.status).json({
        error: err.message,
        code: err.code,
        // Only the substituted values, never anything from the filesystem
        // that the message itself did not already contain.
        ...(err.params ? { params: err.params } : {}),
      });
      return;
    }
    if (err?.type === 'entity.too.large') {
      res.status(413).json({ error: 'The request is too large', code: 'TOO_LARGE' });
      return;
    }
    warn('Unhandled file manager error', err);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL' });
  });

  router.fsOps = ops;
  return router;
}

/**
 * The same handler, under the name Express users already call.
 *
 * `app.use('/api/files', createFileManagerRouter({ root }))` keeps working:
 * Express accepts any `(req, res, next)` function as middleware, and that is
 * exactly what this is. Express is no longer needed for it to exist.
 */
export const createFileManagerRouter = createFileManagerHandler;

export default createFileManagerHandler;
