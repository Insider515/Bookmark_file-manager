import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';
import os from 'node:os';
import { pipeline } from 'node:stream/promises';

import {
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
import { ArchiveService, FORMATS, strippedName } from './archive/index.js';
import { probeHeifSupport, viewCapabilities } from './thumbnail.js';
import { SheetService, isSheetName, sheetFormatOf } from './sheet/index.js';
import { DocumentService, isDocumentName } from './doc/index.js';
import { DEFAULT_SEARCH_LIMITS, normaliseSearchOptions } from './search.js';
import { DEFAULT_TEXT_LIMITS, readTextFile, serializeText } from './text.js';
import {
  PERMISSION_MASK,
  formatModeText,
  formatOctalMode,
  isExecutable,
  withExecutable,
} from './mode.js';

/** Operations that can be granted or withheld individually. */
export const PERMISSION_KEYS = [
  'create', 'upload', 'move', 'copy', 'rename', 'remove', 'download', 'chmod',
  'archive', 'extract', 'edit',
];

/**
 * Permissions that are withheld unless asked for, against the grain of the
 * rest.
 *
 * `chmod` is the odd one out on purpose. Every other operation here is
 * something a file manager obviously does, and defaulting it to allowed costs
 * an existing deployment nothing. Setting the execute bit is not that: it
 * turns an upload directory into a place where uploads can be run, and a
 * deployment that upgraded this package would have acquired that ability
 * without anyone deciding to grant it. Opt-in is the only default that cannot
 * surprise someone.
 */
const DEFAULT_WITHHELD = new Set(['chmod']);

/**
 * Permissions whose default is another permission's value rather than a fixed
 * one.
 *
 * Packing writes a new file; unpacking writes many. Both are "create files
 * here" wearing different hats, so neither should be available where creating
 * is not. Tying the default to `create` means a deployment that had withheld
 * every write does not quietly regain the ability to write on upgrade — the
 * same objection that keeps `chmod` opt-in — while a normal deployment gets
 * the feature working without having to know it exists.
 */
const DEFAULT_FOLLOWS = { archive: 'create', extract: 'create', edit: 'create' };

/** Human-readable names, used in the refusal message. */
const PERMISSION_LABELS = {
  archive: 'archiving',
  chmod: 'changing permissions',
  create: 'creating',
  edit: 'editing',
  extract: 'extracting',
  upload: 'uploading',
  move: 'moving',
  copy: 'copying',
  rename: 'renaming',
  remove: 'deleting',
  download: 'downloading',
};

/** Everything except download counts as a write. */
const WRITE_PERMISSIONS = PERMISSION_KEYS.filter((key) => key !== 'download');

/**
 * Prefix for the temporary file an upload streams into. It is distinctive on
 * purpose: listings filter it out by this exact prefix, so an in-progress
 * upload never shows up as a half-written file, and no name a user could
 * plausibly choose is hidden by accident.
 */
export const TEMP_UPLOAD_PREFIX = '.fsfm-upload-';

const isTempUpload = (name) => name.startsWith(TEMP_UPLOAD_PREFIX);

/**
 * One reusable collator for every name comparison.
 *
 * `a.localeCompare(b, …, opts)` builds a fresh collator on each call, which
 * dominates the cost of sorting a large directory. Hoisting it is the same
 * comparison, several times cheaper.
 */
const NAME_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const byName = (a, b) => NAME_COLLATOR.compare(a.name, b.name);

/** Guard against a symlink cycle turning a recursive copy into an infinite one. */
const MAX_COPY_DEPTH = 128;

/**
 * Run `fn` over `items` with at most `limit` in flight.
 *
 * Directory listings are dominated by per-entry `stat` latency, not by CPU, so
 * issuing them sequentially wastes most of the wall clock — badly so on a
 * network filesystem. The cap keeps a huge directory from opening thousands of
 * file descriptors at once.
 */
async function mapConcurrent(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Normalise a caller-supplied permission set. Unknown keys are ignored;
 * `readOnly` forces every write off, so it cannot be re-enabled by accident.
 */
export function resolvePermissions(permissions, readOnly = false) {
  const resolved = {};
  for (const key of PERMISSION_KEYS) {
    if (key in DEFAULT_FOLLOWS) continue; // resolved below, once its source is known
    const value = permissions?.[key];
    resolved[key] = value === undefined ? !DEFAULT_WITHHELD.has(key) : !!value;
  }
  for (const [key, source] of Object.entries(DEFAULT_FOLLOWS)) {
    const value = permissions?.[key];
    resolved[key] = value === undefined ? resolved[source] : !!value;
  }
  if (readOnly) {
    for (const key of WRITE_PERMISSIONS) resolved[key] = false;
  }
  return resolved;
}

/**
 * Filesystem operations for one root directory. Every method takes and
 * returns *virtual* paths ("/Documents/a.txt"); absolute paths never leave
 * this module, so nothing downstream can leak the server's directory layout.
 */
export class FsOps {
  /**
   * @param {object} options
   * @param {string} options.root directory to expose; created if missing
   * @param {boolean} [options.readOnly] reject every mutating operation
   * @param {Partial<Record<'create'|'upload'|'move'|'copy'|'rename'|'remove'|'download', boolean>>} [options.permissions]
   *   per-operation switches; anything omitted defaults to allowed. These are
   *   enforced here, on the server — the widget only mirrors them in its UI.
   * @param {number} [options.maxUploadSize] bytes per uploaded file
   * @param {number} [options.minFreeSpace] refuse uploads when the filesystem
   *   has less than this many bytes free. 0 disables the check.
   * @param {number} [options.maxListEntries] cap on entries returned by list();
   *   the listing reports `truncated: true` when it bites. 0 disables the cap.
   * @param {number} [options.maxTreeChildren] cap on child directories per tree node
   * @param {number} [options.concurrency] parallel stat/readdir calls per request
   * @param {boolean} [options.archiveTools=true] allow external compressors
   *   (bzip2, xz, zstd, bsdtar) to be used for the formats Node cannot do
   *   alone. With this off, only zip, tar, tar.gz and gz remain available.
   * @param {object} [options.archiveLimits] see DEFAULT_LIMITS in ./archive
   * @param {object} [options.sheetLimits] see DEFAULT_LIMITS in ./sheet
   * @param {object} [options.documentLimits] see DEFAULT_DOC_LIMITS in ./doc
   * @param {object} [options.searchLimits] see DEFAULT_SEARCH_LIMITS in ./search.js
   * @param {object} [options.textLimits] see DEFAULT_TEXT_LIMITS in ./text
   * @param {(message: string, detail?: any) => void} [options.onWarning]
   */
  constructor({
    root,
    readOnly = false,
    permissions,
    maxUploadSize = 100 * 1024 * 1024,
    minFreeSpace = 64 * 1024 * 1024,
    maxListEntries = 50000,
    maxTreeChildren = 2000,
    concurrency = 32,
    archiveTools = true,
    archiveLimits = {},
    sheetLimits = {},
    documentLimits = {},
    searchLimits = {},
    textLimits = {},
    onWarning,
  }) {
    if (!root) throw new Error('FsOps requires a root directory');
    this.rootInput = path.resolve(root);
    this.root = null; // resolved in init()
    this.permissions = resolvePermissions(permissions, readOnly);
    // Windows has no POSIX mode bits — fs.chmod there only toggles the
    // read-only attribute. Advertising the operation would promise something
    // the platform cannot deliver, so it is reported as unavailable instead of
    // silently doing something else.
    this.chmodSupported = process.platform !== 'win32';
    if (!this.chmodSupported) this.permissions.chmod = false;
    // readOnly stays a derived truth rather than a stored flag, so it cannot
    // drift out of step with the permission set.
    this.readOnly = WRITE_PERMISSIONS.every((key) => !this.permissions[key]);
    this.maxUploadSize = maxUploadSize;
    this.minFreeSpace = Math.max(0, minFreeSpace);
    this.maxListEntries = Math.max(0, maxListEntries);
    this.maxTreeChildren = Math.max(1, maxTreeChildren);
    this.concurrency = Math.max(1, concurrency);
    this.archiveTools = archiveTools;
    this.archives = new ArchiveService({ limits: archiveLimits, onWarning });
    this.sheets = new SheetService({ limits: sheetLimits });
    this.documents = new DocumentService({ limits: documentLimits });
    this.searchLimits = { ...DEFAULT_SEARCH_LIMITS, ...searchLimits };
    this.textLimits = { ...DEFAULT_TEXT_LIMITS, ...textLimits };
  }

  /** True when the named operation is permitted. */
  can(action) {
    return this.permissions[action] !== false;
  }

  /** Create the root if needed and resolve it through symlinks. Idempotent. */
  async init() {
    if (this.root) return this;
    await fs.mkdir(this.rootInput, { recursive: true });
    // realpath once, up front: every later containment check compares against
    // this value, so it must already be symlink-free.
    this.root = await fs.realpath(this.rootInput);
    // Probing for external compressors is a handful of process spawns; doing
    // it once here keeps it off the request path entirely.
    await this.archives.init({ tools: this.archiveTools });
    // One decode at startup settles whether HEIC can be shown at all, so the
    // capability report is a fact rather than a hope.
    await probeHeifSupport();
    return this;
  }

  /**
   * Refuse an operation the caller is not allowed to perform. When every write
   * is off the message says so plainly; when only this one is off it names it,
   * because "read-only" would be misleading.
   */
  #assertAllowed(action) {
    if (this.can(action)) return;
    if (this.readOnly) {
      throw new FsError(403, 'READ_ONLY', 'The manager is open in read-only mode');
    }
    throw new FsError(
      403,
      'PERMISSION_DENIED',
      `The “${PERMISSION_LABELS[action] ?? action}” operation is not allowed`,
      { permission: action }
    );
  }

  #resolve(virtual, opts) {
    if (!this.root) throw new Error('FsOps.init() must be awaited before use');
    return resolveSafe(this.root, virtual, opts);
  }

  /** True when a symlink at `absolute` resolves to something inside the root. */
  async #linkStaysInside(absolute) {
    try {
      return isInsideRoot(this.root, await fs.realpath(absolute));
    } catch {
      return false;
    }
  }

  /** Map a raw fs error onto a client-facing one. */
  static #wrap(err, virtual) {
    if (err instanceof FsError) return err;
    switch (err.code) {
      case 'ENOENT':
        return new FsError(404, 'NOT_FOUND', `Not found: ${virtual}`, { path: virtual });
      case 'EEXIST':
        return new FsError(409, 'EXISTS', `Already exists: ${virtual}`, { path: virtual });
      case 'ENOTEMPTY':
        return new FsError(409, 'NOT_EMPTY', `Directory not empty: ${virtual}`, { path: virtual });
      case 'EACCES':
      case 'EPERM':
        return new FsError(403, 'DENIED', `Access denied: ${virtual}`, { path: virtual });
      case 'ENOTDIR':
        return new FsError(400, 'NOT_A_DIRECTORY', `Not a directory: ${virtual}`, { path: virtual });
      case 'EISDIR':
        return new FsError(400, 'IS_A_DIRECTORY', `Is a directory: ${virtual}`, { path: virtual });
      case 'ENOSPC':
        return new FsError(507, 'NO_SPACE', 'No space left on the device');
      default:
        return err;
    }
  }

  /**
   * Build the client-facing entry object for one directory child.
   *
   * `mode` and `executable` ride along because the listing is where the UI
   * decides what to offer: without them the context menu could not know
   * whether to say "make executable" or "remove executable" without a request
   * per entry.
   */
  static #entry(virtualPath, stats, isDirectory) {
    const mode = stats.mode & PERMISSION_MASK;
    return {
      name: baseName(virtualPath),
      path: virtualPath,
      isDirectory,
      size: isDirectory ? null : stats.size,
      modified: stats.mtime.toISOString(),
      mode,
      modeOctal: formatOctalMode(mode),
      executable: !isDirectory && isExecutable(mode),
    };
  }

  /**
   * List one directory. Directories sort before files, then by name using the
   * host locale so "Ялинка" and "elephant" land where a user expects.
   *
   * The per-entry stats are gathered in parallel: they are latency-bound, and
   * doing them one at a time made a large directory scale with round trips
   * rather than with the filesystem's own throughput.
   */
  async list(virtual) {
    const target = await this.#resolve(virtual);
    let dirents;
    try {
      dirents = await fs.readdir(target.absolute, { withFileTypes: true });
    } catch (err) {
      throw FsOps.#wrap(err, target.virtual);
    }

    // An upload in flight is not a file the user has; hide its scratch name.
    const candidates = dirents.filter((dirent) => !isTempUpload(dirent.name));
    const truncated = this.maxListEntries > 0 && candidates.length > this.maxListEntries;
    const considered = truncated ? candidates.slice(0, this.maxListEntries) : candidates;

    const described = await mapConcurrent(considered, this.concurrency, async (dirent) => {
      const childAbs = path.join(target.absolute, dirent.name);
      let stats;
      try {
        // stat (not lstat) so a symlink reports its target's kind; a link that
        // escapes the root is filtered out below rather than shown as broken.
        stats = await fs.stat(childAbs);
      } catch {
        // Broken symlink, or the entry vanished mid-listing. Skip it — one bad
        // entry must not fail the whole directory.
        return null;
      }
      // Keep symlinks that stay inside the root; hide the rest so the tree
      // can never present an out-of-root file as browsable.
      if (dirent.isSymbolicLink() && !(await this.#linkStaysInside(childAbs))) return null;
      const isDirectory = stats.isDirectory();
      if (!isDirectory && !stats.isFile()) return null; // sockets, fifos, devices
      return FsOps.#entry(joinVirtual(target.virtual, dirent.name), stats, isDirectory);
    });

    const items = described.filter(Boolean);

    items.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return NAME_COLLATOR.compare(a.name, b.name);
    });

    return {
      path: target.virtual,
      name: target.virtual === '/' ? '' : baseName(target.virtual),
      parent: target.virtual === '/' ? null : parentVirtual(target.virtual),
      items,
      // Present only when it happened, so a normal listing carries no noise.
      ...(truncated ? { truncated: true, total: candidates.length } : {}),
    };
  }

  /**
   * Read the child *directories* of one directory, in display order.
   * Symlinks are followed only while they stay inside the root.
   */
  async #childDirectories(absolute) {
    let dirents;
    try {
      dirents = await fs.readdir(absolute, { withFileTypes: true });
    } catch {
      return []; // unreadable directory still shows, just without children
    }

    const candidates = dirents.filter((dirent) => !isTempUpload(dirent.name));
    const resolved = await mapConcurrent(candidates, this.concurrency, async (dirent) => {
      const childAbs = path.join(absolute, dirent.name);
      if (dirent.isSymbolicLink()) {
        if (!(await this.#linkStaysInside(childAbs))) return null;
        try {
          if (!(await fs.stat(childAbs)).isDirectory()) return null;
        } catch {
          return null;
        }
        return { name: dirent.name, absolute: childAbs };
      }
      return dirent.isDirectory() ? { name: dirent.name, absolute: childAbs } : null;
    });

    const children = resolved.filter(Boolean);
    children.sort(byName);
    return children.length > this.maxTreeChildren
      ? children.slice(0, this.maxTreeChildren)
      : children;
  }

  /**
   * Directory-only tree for the left pane.
   *
   * Walked breadth-first, one level at a time, with the whole level read in
   * parallel: a wide tree then costs one round of latency per level instead of
   * one per directory. Each level reads one step deeper than it materialises,
   * which is what fills in `hasChildren` for the leaves.
   *
   * @param {string} virtual subtree root
   * @param {number} depth levels below `virtual` to include
   */
  async tree(virtual, depth = 2) {
    const target = await this.#resolve(virtual);
    const maxDepth = Math.max(0, Math.min(depth, 12));

    const makeNode = (virtualPath) => ({
      name: virtualPath === '/' ? '/' : baseName(virtualPath),
      path: virtualPath,
      isDirectory: true,
      hasChildren: false,
      children: null,
    });

    const rootNode = makeNode(target.virtual);
    let level = [{ node: rootNode, absolute: target.absolute, virtual: target.virtual }];

    for (let currentDepth = 0; currentDepth <= maxDepth && level.length > 0; currentDepth += 1) {
      const childLists = await mapConcurrent(level, this.concurrency, (item) =>
        this.#childDirectories(item.absolute)
      );

      const next = [];
      level.forEach((item, index) => {
        const children = childLists[index];
        item.node.hasChildren = children.length > 0;
        if (currentDepth === maxDepth) return; // deepest level: hint only
        item.node.children = children.map((child) => {
          const childVirtual = joinVirtual(item.virtual, child.name);
          const node = makeNode(childVirtual);
          next.push({ node, absolute: child.absolute, virtual: childVirtual });
          return node;
        });
      });
      level = next;
    }

    return rootNode;
  }

  /**
   * Everything the properties dialog shows for one entry.
   *
   * Kept apart from stat() rather than folded into it: stat() is called once
   * per entry on every listing, and the extra lstat, readlink and owner lookup
   * here would be paid thousands of times over for information the list never
   * displays.
   */
  async properties(virtual, { computeSize = false, sizeLimit = 200000 } = {}) {
    const target = await this.#resolve(virtual);
    // resolveSafe hands back the *resolved* path, so lstat-ing it would
    // describe whatever a symlink points at and never the link itself. The
    // unresolved path is what has to be lstat'ed — safe to rebuild here
    // because resolveSafe already proved both forms sit inside the root.
    const unresolved = path.resolve(this.root, `.${target.virtual}`);
    let stats;
    let linkStats;
    try {
      stats = await fs.stat(target.absolute);
      linkStats = await fs.lstat(unresolved);
    } catch (err) {
      throw FsOps.#wrap(err, target.virtual);
    }

    const isDirectory = stats.isDirectory();
    const mode = stats.mode & PERMISSION_MASK;

    const details = {
      name: baseName(target.virtual) || '/',
      path: target.virtual,
      isDirectory,
      isSymbolicLink: linkStats.isSymbolicLink(),
      linkTarget: null,
      size: isDirectory ? null : stats.size,
      // Sparse and compressed files occupy less than their length; block count
      // is the only honest answer to "how much disk is this using".
      blocks: stats.blocks * 512,
      created: stats.birthtime.toISOString(),
      modified: stats.mtime.toISOString(),
      accessed: stats.atime.toISOString(),
      changed: stats.ctime.toISOString(),
      links: stats.nlink,
      mode,
      modeOctal: formatOctalMode(mode),
      modeText: formatModeText(mode),
      executable: !isDirectory && isExecutable(mode),
      modeEditable: this.chmodSupported && this.can('chmod'),
      uid: stats.uid,
      gid: stats.gid,
      owner: FsOps.#ownerName(stats.uid),
      itemCount: null,
      totalSize: null,
      totalSizePartial: false,
    };

    if (details.isSymbolicLink) {
      // Only ever reported as a virtual path: an absolute one would describe
      // the server's layout, which nothing here is allowed to disclose. A link
      // leaving the root reports null rather than where it went.
      const real = target.absolute; // already realpath'd and confined
      const relative = path.relative(this.root, real).split(path.sep).join('/');
      details.linkTarget = isInsideRoot(this.root, real) ? `/${relative}` : null;
    }

    if (isDirectory) {
      try {
        const dirents = await fs.readdir(target.absolute, { withFileTypes: true });
        details.itemCount = dirents.filter((dirent) => !isTempUpload(dirent.name)).length;
      } catch {
        details.itemCount = null;
      }
      if (computeSize) {
        const walked = await this.#directorySize(target.absolute, sizeLimit);
        details.totalSize = walked.bytes;
        details.totalSizePartial = walked.partial;
      }
    }

    return details;
  }

  /**
   * Add up a directory tree.
   *
   * Bounded by entry count, and says so when it stops: a folder can hold more
   * files than the walk should spend a request on, and reporting a number that
   * quietly excludes half of them would be worse than admitting the limit.
   */
  async #directorySize(absoluteDir, limit) {
    let bytes = 0;
    let seen = 0;
    let partial = false;

    const walk = async (dir, depth) => {
      if (partial || depth > MAX_COPY_DEPTH) return;
      let dirents;
      try {
        dirents = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const dirent of dirents) {
        if (partial) return;
        if (isTempUpload(dirent.name)) continue;
        seen += 1;
        if (seen > limit) {
          partial = true;
          return;
        }
        const childAbs = path.join(dir, dirent.name);
        if (dirent.isSymbolicLink()) continue; // counted where it really lives
        try {
          const childStats = await fs.lstat(childAbs);
          if (childStats.isDirectory()) await walk(childAbs, depth + 1);
          else if (childStats.isFile()) bytes += childStats.size;
        } catch {
          // vanished mid-walk
        }
      }
    };

    await walk(absoluteDir, 0);
    return { bytes, partial };
  }

  /** The current user's name when the uid matches, else null. */
  static #ownerName(uid) {
    try {
      const info = os.userInfo();
      return info.uid === uid ? info.username : null;
    } catch {
      return null;
    }
  }

  /**
   * Change permission bits.
   *
   * @param {string[]} paths virtual paths
   * @param {{mode?: number, executable?: boolean, recursive?: boolean}} options
   *   `mode` sets the bits outright; `executable` adds or removes the execute
   *   bits relative to what is already there. Exactly one of the two.
   * @returns {Promise<object[]>} the entries, with their new mode
   */
  async chmod(paths, options = {}) {
    this.#assertAllowed('chmod');
    if (!this.chmodSupported) {
      throw new FsError(501, 'CHMOD_UNSUPPORTED', 'Changing permissions is not supported on this platform');
    }
    const { mode, executable, recursive = false } = options;
    if (mode === undefined && executable === undefined) {
      throw new FsError(400, 'INVALID_MODE', 'Give either mode or executable');
    }

    const results = [];
    for (const virtual of paths) {
      const target = await this.#resolve(virtual);
      if (target.virtual === '/') {
        throw new FsError(400, 'ROOT_IMMUTABLE', 'The permissions of the root directory cannot be changed');
      }

      let stats;
      try {
        stats = await fs.stat(target.absolute);
      } catch (err) {
        throw FsOps.#wrap(err, target.virtual);
      }

      const next =
        mode !== undefined
          ? mode & PERMISSION_MASK
          : withExecutable(stats.mode & PERMISSION_MASK, executable);

      try {
        await fs.chmod(target.absolute, next);
        if (recursive && stats.isDirectory()) {
          await this.#chmodRecursive(target.absolute, { mode, executable }, 0);
        }
      } catch (err) {
        throw FsOps.#wrap(err, target.virtual);
      }
      results.push(await this.properties(target.virtual));
    }
    return results;
  }

  /**
   * Apply the same change through a directory tree.
   *
   * Symlinks are skipped rather than followed. fs.chmod() follows them, so
   * walking into one would change the permissions of whatever it points at —
   * and a link is the one thing in the tree whose target the walk has not
   * confined to the root.
   *
   * A relative change (`executable`) is read per entry, so a tree of 644 files
   * and 755 directories keeps that distinction instead of being flattened.
   */
  async #chmodRecursive(absoluteDir, change, depth) {
    if (depth > MAX_COPY_DEPTH) return;
    let dirents;
    try {
      dirents = await fs.readdir(absoluteDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      if (isTempUpload(dirent.name)) continue;
      if (dirent.isSymbolicLink()) continue;
      const childAbs = path.join(absoluteDir, dirent.name);
      let childStats;
      try {
        childStats = await fs.lstat(childAbs);
      } catch {
        continue;
      }
      const next =
        change.mode !== undefined
          ? change.mode & PERMISSION_MASK
          : withExecutable(childStats.mode & PERMISSION_MASK, change.executable);
      try {
        await fs.chmod(childAbs, next);
      } catch {
        continue; // one unwritable entry must not abort the whole tree
      }
      if (childStats.isDirectory()) {
        await this.#chmodRecursive(childAbs, change, depth + 1);
      }
    }
  }

  /** Stat one entry, for the details bar and pre-flight checks. */
  async stat(virtual) {
    const target = await this.#resolve(virtual);
    try {
      const stats = await fs.stat(target.absolute);
      return FsOps.#entry(target.virtual, stats, stats.isDirectory());
    } catch (err) {
      throw FsOps.#wrap(err, target.virtual);
    }
  }

  /**
   * Pick a name that does not collide in `dirAbsolute`, appending " (2)",
   * " (3)", … before the extension. Used by copy/move/upload on conflict.
   */
  async #uniqueName(dirAbsolute, name) {
    const ext = path.extname(name);
    const stem = ext ? name.slice(0, -ext.length) : name;
    for (let n = 1; n < 1000; n += 1) {
      const candidate = n === 1 ? name : `${stem} (${n})${ext}`;
      try {
        await fs.lstat(path.join(dirAbsolute, candidate));
      } catch (err) {
        if (err.code === 'ENOENT') return candidate;
        throw err;
      }
    }
    throw new FsError(409, 'EXISTS', `Could not find a free name for “${name}”`);
  }

  /**
   * Claim a free name by atomically creating an empty placeholder for it.
   *
   * #uniqueName alone only reports what was free a moment ago; two uploads of
   * the same filename racing each other would both pick it and one would
   * silently overwrite the other. Creating the file with `wx` makes the claim
   * and the check the same operation, so the loser sees EEXIST and moves on.
   */
  async #reserveName(dirAbsolute, name) {
    let candidate = name;
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      candidate = await this.#uniqueName(dirAbsolute, candidate);
      try {
        const handle = await fs.open(path.join(dirAbsolute, candidate), 'wx');
        await handle.close();
        return candidate;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        // Somebody took it between the check and the claim; try the next one.
      }
    }
    throw new FsError(409, 'EXISTS', `Could not find a free name for “${name}”`);
  }

  async createDirectory(parentPath, name) {
    this.#assertAllowed('create');
    assertValidName(name);
    const parent = await this.#resolve(parentPath);
    const targetAbs = path.join(parent.absolute, name);
    try {
      await fs.mkdir(targetAbs);
    } catch (err) {
      throw FsOps.#wrap(err, joinVirtual(parent.virtual, name));
    }
    return this.stat(joinVirtual(parent.virtual, name));
  }

  /** Create an empty file. Fails if something with that name already exists. */
  async createFile(parentPath, name, content = '') {
    this.#assertAllowed('create');
    assertValidName(name);
    const parent = await this.#resolve(parentPath);
    const targetAbs = path.join(parent.absolute, name);
    try {
      // wx: fail rather than truncate an existing file.
      await fs.writeFile(targetAbs, content, { flag: 'wx' });
    } catch (err) {
      throw FsOps.#wrap(err, joinVirtual(parent.virtual, name));
    }
    return this.stat(joinVirtual(parent.virtual, name));
  }

  async rename(virtual, newName) {
    this.#assertAllowed('rename');
    assertValidName(newName);
    const target = await this.#resolve(virtual);
    if (target.virtual === '/') {
      throw new FsError(400, 'ROOT_IMMUTABLE', 'The root directory cannot be renamed');
    }
    const parentAbs = path.dirname(target.absolute);
    const destAbs = path.join(parentAbs, newName);
    if (destAbs === target.absolute) return this.stat(target.virtual);

    try {
      // Refuse rather than clobber: rename() would silently replace the
      // destination on POSIX.
      await fs.lstat(destAbs);
      throw new FsError(409, 'EXISTS', `“${newName}” already exists`, { path: newName });
    } catch (err) {
      if (err instanceof FsError) throw err;
      if (err.code !== 'ENOENT') throw FsOps.#wrap(err, target.virtual);
    }

    try {
      await fs.rename(target.absolute, destAbs);
    } catch (err) {
      throw FsOps.#wrap(err, target.virtual);
    }
    return this.stat(joinVirtual(parentVirtual(target.virtual), newName));
  }

  /**
   * Move entries into `destinationDir`.
   * @param {string[]} paths virtual paths to move
   * @param {string} destinationDir virtual directory path
   * @param {{overwrite?: boolean, onSkip?: (info: object) => void}} [opts]
   *   overwrite: replace a colliding destination instead of auto-renaming.
   *   onSkip: called for anything a cross-device copy refused to carry over.
   */
  async move(paths, destinationDir, opts = {}) {
    this.#assertAllowed('move');
    const destination = await this.#resolve(destinationDir);
    await this.#assertDirectory(destination);
    const results = [];

    for (const virtual of paths) {
      const source = await this.#resolve(virtual);
      if (source.virtual === '/') {
        throw new FsError(400, 'ROOT_IMMUTABLE', 'The root directory cannot be moved');
      }
      // Moving a directory into itself or its own descendant would detach the
      // subtree; rename() reports EINVAL, but the message would be opaque.
      if (isSameOrInside(source.virtual, destination.virtual)) {
        throw new FsError(
          400,
          'INTO_SELF',
          `“${baseName(source.virtual)}” cannot be moved inside itself`,
          { name: baseName(source.virtual) }
        );
      }
      if (parentVirtual(source.virtual) === destination.virtual) {
        results.push(await this.stat(source.virtual)); // already there; no-op
        continue;
      }

      const name = baseName(source.virtual);
      const finalName = opts.overwrite ? name : await this.#uniqueName(destination.absolute, name);
      const destAbs = path.join(destination.absolute, finalName);

      try {
        if (opts.overwrite) await fs.rm(destAbs, { recursive: true, force: true });
        await fs.rename(source.absolute, destAbs);
      } catch (err) {
        if (err.code === 'EXDEV') {
          // Different device: rename() cannot work, so copy then remove.
          await this.#copyRecursive(source.absolute, destAbs, { onSkip: opts.onSkip });
          await fs.rm(source.absolute, { recursive: true, force: true });
        } else {
          throw FsOps.#wrap(err, source.virtual);
        }
      }
      results.push(await this.stat(joinVirtual(destination.virtual, finalName)));
    }
    return results;
  }

  /** Copy entries into `destinationDir`. Same options as move(). */
  async copy(paths, destinationDir, opts = {}) {
    this.#assertAllowed('copy');
    const destination = await this.#resolve(destinationDir);
    await this.#assertDirectory(destination);
    const results = [];

    for (const virtual of paths) {
      const source = await this.#resolve(virtual);
      if (isSameOrInside(source.virtual, destination.virtual)) {
        throw new FsError(
          400,
          'INTO_SELF',
          `“${baseName(source.virtual)}” cannot be copied inside itself`,
          { name: baseName(source.virtual) }
        );
      }
      const name = baseName(source.virtual) || 'root';
      const finalName = opts.overwrite ? name : await this.#uniqueName(destination.absolute, name);
      const destAbs = path.join(destination.absolute, finalName);
      try {
        if (opts.overwrite) await fs.rm(destAbs, { recursive: true, force: true });
        await this.#copyRecursive(source.absolute, destAbs, { onSkip: opts.onSkip });
      } catch (err) {
        throw FsOps.#wrap(err, source.virtual);
      }
      results.push(await this.stat(joinVirtual(destination.virtual, finalName)));
    }
    return results;
  }

  /**
   * Recursive copy that cannot import anything from outside the root.
   *
   * fs.cp({dereference: true}) was the obvious way to write this and it is the
   * wrong one: it happily follows a symlink pointing out of the root and lands
   * the external file inside it as a real file, where the manager will then
   * list and serve it. Listings hide such links precisely so that cannot
   * happen, and a copy has to honour the same rule. So each entry is inspected
   * with lstat, links are followed only while they stay inside the root, and
   * anything else is skipped and reported.
   *
   * The depth cap, the visited set and the destination exclusion all exist for
   * the same reason: a link back to an ancestor is legal on disk. Without the
   * visited set such a link recurses forever; without the exclusion the walk
   * re-enters the root, finds the copy it is *currently writing*, and starts
   * copying that too.
   */
  async #copyRecursive(sourceAbs, destAbs, opts = {}, depth = 0, visited = new Set()) {
    if (depth > MAX_COPY_DEPTH) {
      throw new FsError(400, 'TOO_DEEP', 'The directories are nested too deeply');
    }
    // The top-level destination is off limits as a source, at any depth.
    const destRoot = opts.destRoot ?? destAbs;
    if (depth > 0 && isInsideRoot(destRoot, sourceAbs)) {
      opts.onSkip?.({ reason: 'DESTINATION', name: path.basename(sourceAbs) });
      return;
    }
    const nested = opts.destRoot === undefined ? { ...opts, destRoot } : opts;

    let stats;
    try {
      stats = await fs.lstat(sourceAbs);
    } catch (err) {
      if (err.code === 'ENOENT') return; // vanished mid-copy
      throw err;
    }

    if (stats.isSymbolicLink()) {
      let real;
      try {
        real = await fs.realpath(sourceAbs);
      } catch {
        nested.onSkip?.({ reason: 'BROKEN_LINK', name: path.basename(sourceAbs) });
        return;
      }
      if (!isInsideRoot(this.root, real)) {
        nested.onSkip?.({ reason: 'OUTSIDE_ROOT', name: path.basename(sourceAbs) });
        return;
      }
      return this.#copyRecursive(real, destAbs, nested, depth + 1, visited);
    }

    if (stats.isDirectory()) {
      const key = `${stats.dev}:${stats.ino}`;
      if (visited.has(key)) {
        nested.onSkip?.({ reason: 'LINK_CYCLE', name: path.basename(sourceAbs) });
        return;
      }
      visited.add(key);

      await fs.mkdir(destAbs);
      const dirents = await fs.readdir(sourceAbs, { withFileTypes: true });
      for (const dirent of dirents) {
        if (isTempUpload(dirent.name)) continue; // someone else's upload in flight
        await this.#copyRecursive(
          path.join(sourceAbs, dirent.name),
          path.join(destAbs, dirent.name),
          nested,
          depth + 1,
          visited
        );
      }
      visited.delete(key);
      await fs.utimes(destAbs, stats.atime, stats.mtime).catch(() => {});
      return;
    }

    if (stats.isFile()) {
      // COPYFILE_EXCL: never clobber; the caller cleared the destination first
      // if that is what it wanted.
      await fs.copyFile(sourceAbs, destAbs, fs.constants.COPYFILE_EXCL);
      await fs.utimes(destAbs, stats.atime, stats.mtime).catch(() => {});
      return;
    }

    nested.onSkip?.({ reason: 'NOT_REGULAR', name: path.basename(sourceAbs) });
  }

  async #assertDirectory(resolved) {
    const stats = await fs.stat(resolved.absolute).catch((err) => {
      throw FsOps.#wrap(err, resolved.virtual);
    });
    if (!stats.isDirectory()) {
      throw new FsError(400, 'NOT_A_DIRECTORY', `Not a directory: ${resolved.virtual}`, {
        path: resolved.virtual,
      });
    }
  }

  /** Delete entries recursively. Returns the paths actually removed. */
  async remove(paths) {
    this.#assertAllowed('remove');
    const removed = [];
    for (const virtual of paths) {
      const target = await this.#resolve(virtual);
      if (target.virtual === '/') {
        throw new FsError(400, 'ROOT_IMMUTABLE', 'The root directory cannot be deleted');
      }
      try {
        await fs.rm(target.absolute, { recursive: true, force: false });
      } catch (err) {
        throw FsOps.#wrap(err, target.virtual);
      }
      removed.push(target.virtual);
    }
    return removed;
  }

  /** Bytes free on the filesystem holding the root, or null if unsupported. */
  async #freeBytes() {
    try {
      const info = await fs.statfs(this.root);
      return info.bavail * info.bsize;
    } catch {
      return null;
    }
  }

  /**
   * Stream one uploaded file into `parentPath`.
   * @param {string} parentPath destination directory
   * @param {string} name client-supplied filename
   * @param {import('node:stream').Readable} stream file contents
   * @param {{overwrite?: boolean}} [opts]
   * @returns {Promise<object>} the created entry
   */
  async writeUpload(parentPath, name, stream, opts = {}) {
    this.#assertAllowed('upload');
    // Browsers may send a path in the filename (directory upload); keep only
    // the last segment so an upload can never write outside the target dir.
    const safeName = assertValidName(path.basename(String(name).replace(/\\/g, '/')));
    if (isTempUpload(safeName)) {
      throw new FsError(400, 'INVALID_NAME', 'Invalid file name');
    }
    const parent = await this.#resolve(parentPath);
    await this.#assertDirectory(parent);

    // Refuse before writing anything rather than filling the disk to zero and
    // taking the host application down with it.
    if (this.minFreeSpace > 0) {
      const free = await this.#freeBytes();
      if (free !== null && free < this.minFreeSpace) {
        throw new FsError(507, 'NO_SPACE', 'Not enough free space on the device');
      }
    }

    // Claim the destination name atomically, so two uploads racing on the same
    // filename get two files rather than one overwriting the other.
    const finalName = opts.overwrite
      ? safeName
      : await this.#reserveName(parent.absolute, safeName);
    const reserved = !opts.overwrite;
    const destAbs = path.join(parent.absolute, finalName);

    // Write to a temp name first so a failed or oversized upload never leaves
    // a truncated file under the real name.
    const tempAbs = path.join(
      parent.absolute,
      `${TEMP_UPLOAD_PREFIX}${crypto.randomBytes(8).toString('hex')}`
    );
    let written = 0;
    let tooLarge = false;

    const cleanup = async () => {
      await fs.rm(tempAbs, { force: true }).catch(() => {});
      // Only drop the placeholder we created ourselves; in overwrite mode the
      // destination is a pre-existing file that must survive a failed upload.
      if (reserved) await fs.rm(destAbs, { force: true }).catch(() => {});
    };

    // Open the temp file up front instead of letting createWriteStream open it
    // lazily. When the size limit trips on the very first chunk, the cleanup
    // below can otherwise run while that open() is still in flight — the file
    // then lands on disk *after* the unlink and is left behind.
    let handle;
    try {
      handle = await fs.open(tempAbs, 'wx');
    } catch (err) {
      await cleanup();
      throw FsOps.#wrap(err, joinVirtual(parent.virtual, finalName));
    }

    try {
      await pipeline(
        stream,
        async function* (source) {
          for await (const chunk of source) {
            written += chunk.length;
            if (written > this.maxUploadSize) {
              tooLarge = true;
              throw new FsError(
                413,
                'TOO_LARGE',
                `The file is over the ${Math.floor(this.maxUploadSize / 1024 / 1024)} MB limit`
              );
            }
            yield chunk;
          }
        }.bind(this),
        // autoClose defaults to true, so the stream owns the handle and closes
        // it on both success and destroy; nothing here closes it twice.
        handle.createWriteStream()
      );
      // Replaces our own zero-byte placeholder, or the existing file when the
      // caller asked for that.
      await fs.rename(tempAbs, destAbs);
    } catch (err) {
      // The file provably exists by now, so this cannot race its creation.
      await cleanup();
      if (tooLarge || err instanceof FsError) throw err;
      throw FsOps.#wrap(err, joinVirtual(parent.virtual, finalName));
    }

    return this.stat(joinVirtual(parent.virtual, finalName));
  }

  /**
   * Resolve a path for download and report what it is, so the router can
   * choose between streaming a file and zipping a directory.
   */
  async resolveForDownload(virtual) {
    const target = await this.#resolve(virtual);
    const stats = await fs.stat(target.absolute).catch((err) => {
      throw FsOps.#wrap(err, target.virtual);
    });
    return {
      absolute: target.absolute,
      virtual: target.virtual,
      name: baseName(target.virtual) || 'archive',
      isDirectory: stats.isDirectory(),
      size: stats.size,
      modified: stats.mtime,
      // Enough to tell one version of a file from another without reading it,
      // which is all a validator has to do.
      etag: `W/"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`,
    };
  }

  /**
   * Walk a directory yielding every regular file inside it, as
   * {absolute, relative} pairs. Used to build a zip.
   */
  async *walkFiles(absoluteDir, relativePrefix = '', depth = 0) {
    if (depth > MAX_COPY_DEPTH) return;
    const dirents = await fs.readdir(absoluteDir, { withFileTypes: true });
    for (const dirent of dirents) {
      if (isTempUpload(dirent.name)) continue;
      const childAbs = path.join(absoluteDir, dirent.name);
      const childRel = relativePrefix ? `${relativePrefix}/${dirent.name}` : dirent.name;
      let stats;
      try {
        stats = await fs.stat(childAbs);
      } catch {
        continue; // broken link or a race with a concurrent delete
      }
      if (dirent.isSymbolicLink() && !(await this.#linkStaysInside(childAbs))) continue;
      if (stats.isDirectory()) {
        yield* this.walkFiles(childAbs, childRel, depth + 1);
      } else if (stats.isFile()) {
        yield { absolute: childAbs, relative: childRel, size: stats.size, modified: stats.mtime };
      }
    }
  }

  // ------------------------------------------------------------- archives

  /** Which formats this deployment can read and write. */
  archiveCapabilities() {
    return this.archives.capabilities();
  }

  /** Which image formats the viewer can show, and which need converting. */
  imageCapabilities() {
    return viewCapabilities();
  }

  /**
   * Read a file as text, for the code editor.
   *
   * Gated on `edit` for the same reason the spreadsheet route is: one route
   * serves both viewing and editing, and a deployment that withholds editing
   * means to withhold the feature rather than offer a read-only pane.
   */
  async readText(virtual) {
    this.#assertAllowed('edit');
    const target = await this.#resolve(virtual);
    try {
      const result = await readTextFile(target.absolute, { limits: this.textLimits });
      return { path: target.virtual, name: baseName(target.virtual), ...result };
    } catch (err) {
      if (err?.status && err?.code) throw new FsError(err.status, err.code, err.message);
      throw FsOps.#wrap(err, target.virtual);
    }
  }

  /**
   * Save text back over its file.
   *
   * Through a temporary name and a rename, like every other write here: an
   * interrupted save must not leave half a source file under the real name.
   *
   * @param {string} virtual
   * @param {string} text
   * @param {{encoding?: string, bom?: boolean, newline?: string}} [options]
   */
  async writeText(virtual, text, options = {}) {
    this.#assertAllowed('edit');
    if (typeof text !== 'string') {
      throw new FsError(400, 'INVALID_TEXT', 'A string was expected');
    }
    const byteLength = Buffer.byteLength(text, 'utf8');
    if (byteLength > this.textLimits.maxBytes) {
      throw new FsError(413, 'TEXT_TOO_LARGE', 'The text is over the size limit');
    }

    const target = await this.#resolve(virtual, { allowMissing: true });
    const parentAbs = path.dirname(target.absolute);
    const tempAbs = path.join(
      parentAbs,
      `${TEMP_UPLOAD_PREFIX}t${crypto.randomBytes(6).toString('hex')}`
    );

    const { buffer, rewritten } = serializeText(text, options);
    try {
      await fs.writeFile(tempAbs, buffer);
      await fs.rename(tempAbs, target.absolute);
    } catch (err) {
      await fs.rm(tempAbs, { force: true }).catch(() => {});
      throw FsOps.#wrap(err, target.virtual);
    }

    const warnings = rewritten
      ? [`The file was in ${options.encoding}; it was saved as ${rewritten}, because Node cannot write that encoding.`]
      : [];
    return { path: target.virtual, warnings, entry: await this.stat(target.virtual) };
  }

  /** Which spreadsheet formats can be opened and saved. */
  sheetCapabilities() {
    return this.sheets.capabilities();
  }

  /**
   * Open a spreadsheet as a workbook.
   *
   * Gated on `edit` even though nothing is written: the same route serves the
   * viewer and the editor, and a deployment that withholds editing generally
   * means to withhold the whole feature rather than offer a read-only grid.
   */
  async readSheet(virtual) {
    this.#assertAllowed('edit');
    const target = await this.#resolve(virtual);
    const name = baseName(target.virtual);
    try {
      const workbook = await this.sheets.read(target.absolute, name);
      return { path: target.virtual, name, ...workbook };
    } catch (err) {
      if (err?.status && err?.code) throw new FsError(err.status, err.code, err.message);
      throw FsOps.#wrap(err, target.virtual);
    }
  }

  /**
   * Save a workbook back over its file.
   *
   * Written to a temporary name in the same directory and renamed into place,
   * so an interrupted save cannot leave a half-written spreadsheet under the
   * real name — the same rule uploads follow.
   *
   * @param {string} virtual
   * @param {object} workbook
   * @param {{format?: string}} [options]
   */
  async writeSheet(virtual, workbook, { format } = {}) {
    this.#assertAllowed('edit');
    const target = await this.#resolve(virtual, { allowMissing: true });
    const name = baseName(target.virtual);
    if (!format && !isSheetName(name)) {
      throw new FsError(415, 'NOT_A_SHEET', `Not a spreadsheet: ${name}`, { name });
    }

    const parentAbs = path.dirname(target.absolute);
    const tempAbs = path.join(
      parentAbs,
      `${TEMP_UPLOAD_PREFIX}s${crypto.randomBytes(6).toString('hex')}`
    );

    let result;
    try {
      result = await this.sheets.write(tempAbs, name, workbook, { format });
      await fs.rename(tempAbs, target.absolute);
    } catch (err) {
      await fs.rm(tempAbs, { force: true }).catch(() => {});
      if (err instanceof FsError) throw err;
      if (err?.status && err?.code) throw new FsError(err.status, err.code, err.message);
      throw FsOps.#wrap(err, target.virtual);
    }

    return { path: target.virtual, ...result, entry: await this.stat(target.virtual) };
  }

  /** Searches running right now; each one holds a thread. */
  #searchesInFlight = 0;

  /**
   * What a client may ask a search to do here.
   *
   * `content` is reported separately because it is a different permission: a
   * deployment can let people find a file by name while refusing to grep what
   * is inside it.
   */
  searchCapabilities() {
    return {
      modes: ['substring', 'glob', 'regex'],
      types: ['all', 'file', 'directory'],
      content: this.can('download'),
      maxResults: this.searchLimits.maxResults,
      maxDepth: this.searchLimits.maxDepth,
      timeout: this.searchLimits.timeout,
    };
  }

  /**
   * Search the tree below a path.
   *
   * Runs in a worker thread, and that is the point rather than an optimisation.
   * The query can be a regular expression, and a backtracking engine handed
   * `(a+)+b` will not return this century; nothing cooperative can interrupt
   * it, so the only remedy is a thread that can be terminated. The soft
   * deadline inside the worker handles ordinary slowness and reports it as
   * `timedOut`; the hard one here handles a wedged pattern.
   *
   * Searching *inside* files needs `download`: being allowed to see that a
   * file exists is not the same as being allowed to read it, and a content
   * search that ignored that would be a way to read files one page at a time.
   *
   * @param {string} virtual where to start; defaults to the root
   * @param {object} raw see normaliseSearchOptions
   */
  async search(virtual, raw = {}) {
    // Validated before anything is started, so a broken pattern costs nothing.
    let options;
    try {
      options = normaliseSearchOptions(raw, this.searchLimits);
    } catch (err) {
      // A rejected query is the user's mistake, and they need to be told which
      // one: an unterminated group must not surface as a server error.
      if (err?.status && err?.code) throw new FsError(err.status, err.code, err.message);
      throw err;
    }
    if (options.scope !== 'name') this.#assertAllowed('download');

    const target = await this.#resolve(virtual || '/');
    let stats;
    try {
      stats = await fs.stat(target.absolute);
    } catch (err) {
      throw FsOps.#wrap(err, target.virtual);
    }
    if (!stats.isDirectory()) {
      throw new FsError(400, 'NOT_A_DIRECTORY', `Not a directory: ${target.virtual}`, {
        path: target.virtual,
      });
    }

    if (this.#searchesInFlight >= this.searchLimits.maxConcurrent) {
      throw new FsError(
        429,
        'BUSY',
        'Too many searches at once — wait for the current ones to finish'
      );
    }

    this.#searchesInFlight += 1;
    try {
      const result = await this.#runSearchWorker({
        root: this.root,
        baseAbsolute: target.absolute,
        baseVirtual: target.virtual,
        options,
        limits: this.searchLimits,
        tempPrefix: TEMP_UPLOAD_PREFIX,
      });

      // Directories first and then by path, so the answer reads like the tree
      // it came from rather than like the order the disk happened to give.
      result.matches.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return NAME_COLLATOR.compare(a.path, b.path);
      });

      return { path: target.virtual, query: options.query, ...result };
    } finally {
      this.#searchesInFlight -= 1;
    }
  }

  /** Start the worker, collect what it streams back, and stop it if it hangs. */
  #runSearchWorker(payload) {
    return new Promise((resolve, reject) => {
      let worker;
      try {
        worker = new Worker(new URL('./search-worker.js', import.meta.url), {
          workerData: payload,
        });
      } catch (err) {
        reject(new FsError(500, 'SEARCH_FAILED', `Could not start the search: ${err.message}`));
        return;
      }

      const matches = [];
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        worker.terminate().catch(() => {});
        fn(value);
      };

      // Longer than the worker's own deadline, so a search that merely ran out
      // of time still returns its summary and only a stuck one is killed.
      const timer = setTimeout(
        () => finish(resolve, { matches, scanned: 0, truncated: true, timedOut: true, elapsed: payload.limits.timeout }),
        payload.limits.timeout + 2000
      );

      worker.on('message', (message) => {
        if (message.type === 'matches') matches.push(...message.batch);
        else if (message.type === 'done') finish(resolve, { ...message.summary, matches });
        else if (message.type === 'error') {
          finish(reject, new FsError(message.status, message.code, message.message));
        }
      });
      worker.on('error', (err) => {
        finish(reject, new FsError(500, 'SEARCH_FAILED', `The search failed: ${err.message}`));
      });
      worker.on('exit', () => {
        // Exited without saying it was done: report what did arrive.
        finish(resolve, { matches, scanned: matches.length, truncated: true, timedOut: false, elapsed: 0 });
      });
    });
  }

  /** Which document formats can be opened, saved and paged through. */
  documentCapabilities() {
    return this.documents.capabilities();
  }

  /**
   * Open a document.
   *
   * Gated on `edit` for the same reason the spreadsheet route is: one route
   * serves both the viewer and the editor, and a deployment that withholds
   * editing means to withhold the feature rather than offer a read-only pane.
   */
  async readDocument(virtual) {
    this.#assertAllowed('edit');
    const target = await this.#resolve(virtual);
    const name = baseName(target.virtual);
    try {
      const document = await this.documents.read(target.absolute, name);
      return { path: target.virtual, name, ...document };
    } catch (err) {
      if (err?.status && err?.code) throw new FsError(err.status, err.code, err.message);
      throw FsOps.#wrap(err, target.virtual);
    }
  }

  /**
   * Save a document back over its file.
   *
   * The original is passed to the writer rather than only its blocks, because
   * for docx and odt saving means rewriting one part of a package and copying
   * the rest across untouched. Written to a temporary name and renamed into
   * place, so an interrupted save cannot destroy the file it was editing —
   * which for this feature is the whole risk.
   *
   * @param {string} virtual
   * @param {object} document
   * @param {{format?: string}} [options]
   */
  async writeDocument(virtual, document, { format } = {}) {
    this.#assertAllowed('edit');
    const target = await this.#resolve(virtual, { allowMissing: true });
    const name = baseName(target.virtual);
    if (!format && !isDocumentName(name)) {
      throw new FsError(415, 'NOT_A_DOCUMENT', `Not a document: ${name}`, { name });
    }

    // Only an existing file can be used as the package to preserve.
    let source = null;
    try {
      const stat = await fs.stat(target.absolute);
      if (stat.isFile()) source = target.absolute;
    } catch {
      /* a new file: written from nothing */
    }

    const parentAbs = path.dirname(target.absolute);
    const tempAbs = path.join(
      parentAbs,
      `${TEMP_UPLOAD_PREFIX}d${crypto.randomBytes(6).toString('hex')}`
    );

    let result;
    try {
      result = await this.documents.write(tempAbs, name, document, { format, source });
      await fs.rename(tempAbs, target.absolute);
    } catch (err) {
      await fs.rm(tempAbs, { force: true }).catch(() => {});
      if (err instanceof FsError) throw err;
      if (err?.status && err?.code) throw new FsError(err.status, err.code, err.message);
      throw FsOps.#wrap(err, target.virtual);
    }

    return { path: target.virtual, ...result, entry: await this.stat(target.virtual) };
  }

  /**
   * Delete, reorder, rotate, split or merge the pages of a PDF.
   *
   * All five are the same write: the plan names the pages to keep, in order,
   * and where each came from. Extra sources are resolved through the same
   * containment check as everything else, so a merge cannot pull in a file
   * from outside the root.
   *
   * @param {string} virtual the PDF the plan indexes as source 0
   * @param {Array<{source?: number, page: number, rotate?: number}>} plan
   * @param {{sources?: string[], target?: string}} [options]
   */
  async writeDocumentPages(virtual, plan, { sources = [], target: targetPath } = {}) {
    this.#assertAllowed('edit');
    if (!Array.isArray(plan) || plan.length === 0) {
      throw new FsError(400, 'PDF_NO_PAGES_SELECTED', 'No pages were selected');
    }

    const primary = await this.#resolve(virtual);
    const extra = [];
    for (const source of sources) {
      extra.push((await this.#resolve(source)).absolute);
    }

    const destination = targetPath ? await this.#resolve(targetPath, { allowMissing: true }) : primary;
    // Writing the result somewhere new is creating a file, not editing one.
    if (destination.virtual !== primary.virtual) this.#assertAllowed('create');

    const parentAbs = path.dirname(destination.absolute);
    const tempAbs = path.join(
      parentAbs,
      `${TEMP_UPLOAD_PREFIX}p${crypto.randomBytes(6).toString('hex')}`
    );

    let result;
    try {
      result = await this.documents.pages([primary.absolute, ...extra], plan, tempAbs);
      await fs.rename(tempAbs, destination.absolute);
    } catch (err) {
      await fs.rm(tempAbs, { force: true }).catch(() => {});
      if (err instanceof FsError) throw err;
      if (err?.status && err?.code) throw new FsError(err.status, err.code, err.message);
      throw FsOps.#wrap(err, destination.virtual);
    }

    return { path: destination.virtual, ...result, entry: await this.stat(destination.virtual) };
  }

  /**
   * Every file and directory below a selection, as archive entries.
   *
   * A single directory is stored without its own name on top, so unpacking it
   * gives back the directory rather than one wrapped in another. A multiple
   * selection keeps each name, because there is nothing else to hang the
   * entries off.
   */
  async *#archiveEntries(resolved, excludeAbsolute) {
    for (const item of resolved) {
      // Packing a folder into itself, or the root into the root, otherwise
      // walks straight into the archive being written: it appears inside
      // itself, at whatever length it had reached when the walk got there.
      if (excludeAbsolute && item.absolute === excludeAbsolute) continue;
      const stats = await fs.stat(item.absolute);
      if (stats.isDirectory()) {
        yield {
          absolute: item.absolute,
          relative: item.name,
          isDirectory: true,
          size: 0,
          modified: stats.mtime,
          mode: stats.mode & PERMISSION_MASK,
        };
        yield* this.#walkForArchive(item.absolute, item.name, 0, excludeAbsolute);
      } else {
        yield {
          absolute: item.absolute,
          relative: item.name,
          size: stats.size,
          modified: stats.mtime,
          mode: stats.mode & PERMISSION_MASK,
        };
      }
    }
  }

  /** Like walkFiles, but yields directories too so empty ones survive. */
  async *#walkForArchive(absoluteDir, prefix, depth = 0, excludeAbsolute = null) {
    if (depth > MAX_COPY_DEPTH) return;
    let dirents;
    try {
      dirents = await fs.readdir(absoluteDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      if (isTempUpload(dirent.name)) continue;
      const childAbs = path.join(absoluteDir, dirent.name);
      if (childAbs === excludeAbsolute) continue; // the archive being written
      const childRel = prefix ? `${prefix}/${dirent.name}` : dirent.name;
      // A link out of the root must not be followed into the archive; that is
      // the same escape the copy path refuses, wearing a different hat.
      if (dirent.isSymbolicLink() && !(await this.#linkStaysInside(childAbs))) continue;
      let stats;
      try {
        stats = await fs.stat(childAbs);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        yield {
          absolute: childAbs,
          relative: childRel,
          isDirectory: true,
          size: 0,
          modified: stats.mtime,
          mode: stats.mode & PERMISSION_MASK,
        };
        yield* this.#walkForArchive(childAbs, childRel, depth + 1, excludeAbsolute);
      } else if (stats.isFile()) {
        yield {
          absolute: childAbs,
          relative: childRel,
          size: stats.size,
          modified: stats.mtime,
          mode: stats.mode & PERMISSION_MASK,
        };
      }
    }
  }

  /**
   * Pack a selection into a new archive.
   *
   * @param {string[]} paths virtual paths to include
   * @param {object} options
   * @param {string} options.format one of FORMATS' ids
   * @param {string} [options.destination] directory for the archive; defaults
   *   to the parent of the first item
   * @param {string} [options.name] archive filename; derived when omitted
   * @returns {Promise<object>} the new archive's entry
   */
  async createArchive(paths, { format: formatId, destination, name } = {}) {
    this.#assertAllowed('archive');
    const format = FORMATS[formatId];
    if (!format) {
      throw new FsError(400, 'UNKNOWN_FORMAT', `Unknown archive format: ${formatId}`, {
        format: formatId,
      });
    }

    const resolved = [];
    for (const virtual of paths) {
      const target = await this.#resolve(virtual);
      const stats = await fs.stat(target.absolute).catch((err) => {
        throw FsOps.#wrap(err, target.virtual);
      });
      resolved.push({
        absolute: target.absolute,
        virtual: target.virtual,
        name: baseName(target.virtual) || 'root',
        isDirectory: stats.isDirectory(),
        size: stats.size,
      });
    }
    if (resolved.length === 0) {
      throw new FsError(400, 'NO_SELECTION', 'Nothing was selected');
    }

    const parentDir = destination ?? parentVirtual(resolved[0].virtual);
    const parent = await this.#resolve(parentDir);
    await this.#assertDirectory(parent);

    const base =
      name ??
      `${resolved.length === 1 ? resolved[0].name.replace(/\.[^.]+$/, '') || resolved[0].name : baseName(parent.virtual) || 'archive'}.${format.extensions[0]}`;
    const safeName = assertValidName(path.basename(base));
    const finalName = await this.#reserveName(parent.absolute, safeName);
    const destinationAbs = path.join(parent.absolute, finalName);

    try {
      if (format.kind === 'filter') {
        // One file, no names inside: only a single regular file can go in.
        if (resolved.length !== 1 || resolved[0].isDirectory) {
          throw new FsError(
            400,
            'FORMAT_SINGLE_FILE',
            `${format.label} stores exactly one file — for several items use tar.${format.filter}`
          );
        }
        await this.archives.pack({
          entries: [],
          destination: destinationAbs,
          format,
          singleFile: { absolute: resolved[0].absolute, name: resolved[0].name },
        });
      } else {
        // Entries always carry their own top-level name, the way every other
        // archiver writes them: opening the file elsewhere then gives a folder
        // rather than its contents spilled into the current directory.
        await this.archives.pack({
          entries: this.#archiveEntries(resolved, destinationAbs),
          destination: destinationAbs,
          format,
        });
      }
    } catch (err) {
      // A half-written archive is worse than none: it looks openable. The
      // placeholder #reserveName created has to go with it, or a failed pack
      // leaves an empty file sitting under the name it never managed to fill.
      await fs.rm(destinationAbs, { force: true }).catch(() => {});
      if (err instanceof FsError) throw err;
      if (err?.status && err?.code) throw new FsError(err.status, err.code, err.message);
      throw FsOps.#wrap(err, joinVirtual(parent.virtual, finalName));
    }

    // An archive that came out empty means the walk found nothing worth
    // storing; the reserved name should not survive as a stub either.
    const created = await this.stat(joinVirtual(parent.virtual, finalName));
    return created;
  }

  /** What is inside an archive, without writing anything. */
  async listArchive(virtual) {
    this.#assertAllowed('extract');
    const target = await this.#resolve(virtual);
    try {
      return await this.archives.list(target.absolute, baseName(target.virtual));
    } catch (err) {
      if (err?.status && err?.code) throw new FsError(err.status, err.code, err.message);
      throw FsOps.#wrap(err, target.virtual);
    }
  }

  /**
   * Unpack an archive beside itself.
   *
   * Never straight into the current folder: that is how a careless archive
   * scatters forty files across someone's documents, and undoing it by hand is
   * miserable. But an archive that already holds a single top-level folder —
   * which is how this code and most others write them — must not gain a second
   * wrapper either, or `Documents.zip` unpacks to `Documents/Documents`.
   *
   * Both are settled the same way: extract into a staging directory, then look
   * at what came out. One folder and nothing else is moved out as it is;
   * anything else keeps a wrapper named after the archive. Deciding afterwards
   * works for a tar stream, where the shape is not knowable in advance.
   */
  async extractArchive(virtual, { destination } = {}) {
    this.#assertAllowed('extract');
    const target = await this.#resolve(virtual);
    const archiveName = baseName(target.virtual);

    const parentDir = destination ?? parentVirtual(target.virtual);
    const parent = await this.#resolve(parentDir);
    await this.#assertDirectory(parent);

    const format = await this.archives.detect(target.absolute, archiveName);
    if (!format) {
      throw new FsError(400, 'NOT_AN_ARCHIVE', `Does not look like an archive: ${archiveName}`, {
        name: archiveName,
      });
    }

    if (format.kind === 'filter') {
      const outName = await this.#reserveName(
        parent.absolute,
        assertValidName(strippedName(archiveName, format))
      );
      const outAbs = path.join(parent.absolute, outName);
      // A staging directory keeps the reserved placeholder from being counted
      // as the result if the decompression fails halfway.
      const stageAbs = path.join(parent.absolute, `${TEMP_UPLOAD_PREFIX}x${crypto.randomBytes(6).toString('hex')}`);
      await fs.mkdir(stageAbs);
      try {
        const result = await this.archives.unpack({
          absolute: target.absolute,
          name: archiveName,
          destination: stageAbs,
        });
        const produced = await fs.readdir(stageAbs);
        if (produced.length !== 1) {
          throw new FsError(422, 'ARCHIVE_UNREADABLE', 'The archive does not hold exactly one file');
        }
        await fs.rm(outAbs, { force: true });
        await fs.rename(path.join(stageAbs, produced[0]), outAbs);
        return {
          path: joinVirtual(parent.virtual, outName),
          format: result.format,
          written: result.written,
          bytes: result.bytes,
          skipped: result.skipped,
          entry: await this.stat(joinVirtual(parent.virtual, outName)),
        };
      } catch (err) {
        await fs.rm(outAbs, { force: true }).catch(() => {});
        if (err instanceof FsError) throw err;
        if (err?.status && err?.code) throw new FsError(err.status, err.code, err.message);
        throw FsOps.#wrap(err, target.virtual);
      } finally {
        await fs.rm(stageAbs, { recursive: true, force: true }).catch(() => {});
      }
    }

    // Containers: extract into staging, then decide what to keep.
    const stageAbs = path.join(
      parent.absolute,
      `${TEMP_UPLOAD_PREFIX}x${crypto.randomBytes(6).toString('hex')}`
    );
    await fs.mkdir(stageAbs);

    try {
      const result = await this.archives.unpack({
        absolute: target.absolute,
        name: archiveName,
        destination: stageAbs,
      });

      const produced = await fs.readdir(stageAbs, { withFileTypes: true });
      const singleFolder =
        produced.length === 1 && produced[0].isDirectory() ? produced[0].name : null;

      const wanted = singleFolder
        ?? (archiveName.replace(
          new RegExp(`\\.(${format.extensions.map((e) => e.replace(/\./g, '\\.')).join('|')})$`, 'i'),
          ''
        ) || archiveName);

      const finalName = await this.#uniqueName(parent.absolute, assertValidName(wanted));
      const finalAbs = path.join(parent.absolute, finalName);
      await fs.rename(singleFolder ? path.join(stageAbs, singleFolder) : stageAbs, finalAbs);

      return {
        path: joinVirtual(parent.virtual, finalName),
        format: result.format,
        written: result.written,
        bytes: result.bytes,
        skipped: result.skipped,
        entry: await this.stat(joinVirtual(parent.virtual, finalName)),
      };
    } catch (err) {
      if (err instanceof FsError) throw err;
      if (err?.status && err?.code) throw new FsError(err.status, err.code, err.message);
      throw FsOps.#wrap(err, target.virtual);
    } finally {
      // Nothing but this call ever wrote here, so removing what is left cannot
      // destroy anything the user had — including after a failure mid-extract.
      await fs.rm(stageAbs, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** Free/used space for the status bar. Returns null if unsupported. */
  async usage() {
    try {
      const info = await fs.statfs(this.root);
      return {
        total: info.blocks * info.bsize,
        free: info.bavail * info.bsize,
      };
    } catch {
      return null;
    }
  }
}

export { FsError, normalizeVirtual, joinVirtual, parentVirtual, baseName };
