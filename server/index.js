/**
 * Server entry point for `bookmark-file-manager/server`.
 *
 * One handler, no framework. `createFileManagerHandler` returns a plain
 * `(req, res)` function over node's own request and response, so it mounts
 * wherever those are reachable:
 *
 *   // Express — `createFileManagerRouter` is the same thing under its old name
 *   app.use('/api/files', createFileManagerRouter({ root: './storage' }));
 *
 *   // AdonisJS
 *   const files = createFileManagerHandler({ root: app.makePath('public'),
 *                                            basePath: '/api/files' });
 *   router.any('/api/files/*', ({ request, response }) =>
 *     files(request.request, response.response));
 *
 *   // Fastify
 *   fastify.all('/api/files/*', (req, reply) => files(req.raw, reply.raw));
 *
 *   // bare node:http
 *   http.createServer(files).listen(3000);
 *
 * `basePath` is the prefix to strip when the host does not rewrite `req.url`
 * itself; Express does rewrite it, so there it can be left out.
 *
 * The handler owns no global state, so several roots can be mounted at once.
 */
export { createFileManagerHandler, createFileManagerRouter, default } from './router.js';
export { createRouter, parseQuery, parseSize } from './http.js';
export { FsOps, PERMISSION_KEYS, TEMP_UPLOAD_PREFIX, resolvePermissions } from './fs-ops.js';
export { createZipStream, zipFileName } from './zip.js';
export {
  PERMISSION_MASK,
  SPECIAL_MASK,
  formatModeText,
  formatOctalMode,
  isExecutable,
  parseOctalMode,
  withExecutable,
} from './mode.js';
export {
  ArchiveService,
  DEFAULT_LIMITS as ARCHIVE_LIMITS,
  FORMATS as ARCHIVE_FORMATS,
  FORMAT_IDS as ARCHIVE_FORMAT_IDS,
  formatFromName,
  isArchiveName,
  resolveFormat,
  safeEntryPath,
  strippedName,
} from './archive/index.js';
export { createTarStream, readTar } from './archive/tar.js';
export {
  DEFAULT_TEXT_LIMITS,
  detectNewline,
  looksBinary,
  readTextFile,
  serializeText,
} from './text.js';
export {
  SheetService,
  SHEET_FORMATS,
  SHEET_FORMAT_IDS,
  isSheetName,
  sheetFormatOf,
} from './sheet/index.js';
export { ZipArchive } from './archive/zip-read.js';
export {
  BROWSER_NATIVE,
  NEEDS_RENDER,
  RENDER_WIDTHS,
  VIEWABLE,
  heifSupported,
  probeHeifSupport,
  renderForView,
  viewCapabilities,
  DEFAULT_PIXEL_LIMIT,
  RASTER_THUMBNAIL,
  RAW_THUMBNAIL,
  THUMBNAILABLE,
  canThumbnail,
  loadSharp,
  rawThumbnailType,
  renderThumbnail,
} from './thumbnail.js';
export {
  FsError,
  assertValidName,
  baseName,
  isInsideRoot,
  isSameOrInside,
  joinVirtual,
  normalizeVirtual,
  parentVirtual,
  resolveSafe,
} from './safe-path.js';
