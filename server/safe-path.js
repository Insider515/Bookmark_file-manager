import path from 'node:path';
import fs from 'node:fs/promises';

/** Thrown for any client-fixable problem; carries an HTTP status. */
export class FsError extends Error {
  /**
   * @param {number} status HTTP status
   * @param {string} code stable machine-readable code
   * @param {string} message English text, shown as-is when the client has no
   *   translation for `code`
   * @param {object} [params] the values interpolated into `message` — a path,
   *   a name, a limit. Sent alongside the code so a client in another language
   *   can build its own sentence instead of showing this English one.
   */
  constructor(status, code, message, params = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.params = params;
  }
}

/**
 * Characters illegal in a single path segment. Includes the Windows reserved
 * set and control characters, so trees stay portable across platforms.
 * Spaces and hyphens are legal and deliberately absent.
 */
/**
 * Characters a name may not be *created* with.
 *
 * Wider than the filesystem requires, on purpose: `: * ? " < > |` are legal on
 * Linux and macOS but illegal on Windows, and a file created here with one of
 * them cannot be copied to a Windows machine. This is a portability rule, and
 * it applies only to names the client asks to create — never to names that are
 * already on disk.
 */
const ILLEGAL_SEGMENT = /[/\\:*?"<>|\u0000-\u001F]/;

/**
 * The one character a path may never contain, however it got here.
 *
 * NUL terminates a string inside every filesystem syscall, so a path with one
 * in it opens something other than what any check written in JavaScript saw.
 */
const NUL = /\u0000/;

/**
 * Traversal, under either separator convention.
 *
 * Checked against the raw string rather than the split segments because a
 * backslash is a separator on Windows and an ordinary character on POSIX:
 * `a\..\b` is one legal filename here and a climb out of the directory
 * there. Refusing it either way costs nothing and takes the platform out of
 * the question.
 */
const TRAVERSAL = /(^|[/\\])\.\.([/\\]|$)/;

const RESERVED_WINDOWS = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/**
 * Validate a single file or folder name supplied by the client.
 * Returns the name unchanged, or throws FsError.
 */
export function assertValidName(name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new FsError(400, 'INVALID_NAME', 'The name cannot be empty');
  }
  if (name.length > 255) {
    throw new FsError(400, 'INVALID_NAME', 'The name is longer than 255 characters');
  }
  if (name === '.' || name === '..') {
    throw new FsError(400, 'INVALID_NAME', 'Invalid name');
  }
  if (ILLEGAL_SEGMENT.test(name)) {
    throw new FsError(400, 'INVALID_NAME', 'The name contains illegal characters: / \\ : * ? " < > |');
  }
  // A trailing dot or space is silently stripped by Windows; reject it so the
  // name the client sees always matches the name on disk.
  if (/[. ]$/.test(name)) {
    throw new FsError(400, 'INVALID_NAME', 'The name cannot end with a dot or a space');
  }
  if (RESERVED_WINDOWS.has(name.split('.')[0].toLowerCase())) {
    throw new FsError(400, 'INVALID_NAME', `“${name}” is a reserved system name`);
  }
  return name;
}

/**
 * Normalise a virtual path to a canonical form: always a leading slash, no
 * trailing slash, no empty or dot segments. "" and "/" both become "/".
 *
 * This *addresses* a path; it does not judge whether the name is a good one.
 * The distinction matters more than it looks. `? " : * < > |` are all legal
 * filename characters on Linux and macOS, and this function runs over paths
 * built from the filesystem as well as over paths sent by a client — so
 * refusing them here made a single file called `звіт?.txt` turn its whole
 * directory into a 400. Names being *created* are held to the stricter,
 * portable rule by assertValidName; names already on disk have to be
 * addressable exactly as they are.
 *
 * Only two things are refused: a NUL byte, and traversal.
 */
export function normalizeVirtual(virtual) {
  if (virtual === undefined || virtual === null || virtual === '') return '/';
  if (typeof virtual !== 'string') {
    throw new FsError(400, 'INVALID_PATH', 'The path must be a string');
  }
  if (NUL.test(virtual)) {
    throw new FsError(400, 'INVALID_PATH', 'The path contains a NUL byte');
  }
  if (TRAVERSAL.test(virtual)) {
    // Refused rather than popped: a client that sends ".." is either buggy or
    // probing, and silently resolving it hides both cases.
    throw new FsError(400, 'INVALID_PATH', 'The path cannot contain ".."');
  }

  const segments = [];
  // Split on "/" alone. A backslash is an ordinary character in a POSIX
  // filename, and treating it as a separator turned `а\б.txt` into the path
  // `/а/б.txt` — a name the client could be shown but could never open.
  for (const raw of virtual.split('/')) {
    if (raw === '' || raw === '.') continue;
    segments.push(raw);
  }
  return '/' + segments.join('/');
}

/** Join a virtual directory path and a name into a virtual path. */
export function joinVirtual(dir, name) {
  const base = normalizeVirtual(dir);
  return base === '/' ? `/${name}` : `${base}/${name}`;
}

/** The virtual path of the parent directory. Root's parent is root. */
export function parentVirtual(virtual) {
  const norm = normalizeVirtual(virtual);
  if (norm === '/') return '/';
  const cut = norm.lastIndexOf('/');
  return cut <= 0 ? '/' : norm.slice(0, cut);
}

/** The last segment of a virtual path, or '' for the root. */
export function baseName(virtual) {
  const norm = normalizeVirtual(virtual);
  return norm === '/' ? '' : norm.slice(norm.lastIndexOf('/') + 1);
}

/**
 * True when an absolute path is the root itself or sits underneath it.
 * Both arguments must already be realpath'd for this to mean anything.
 */
export function isInsideRoot(root, absolute) {
  return absolute === root || absolute.startsWith(root + path.sep);
}

/**
 * Resolve a virtual path against the root into an absolute filesystem path,
 * refusing anything that escapes the root.
 *
 * Two checks are needed and neither is sufficient alone: the lexical check
 * catches traversal in the requested path, and the realpath check catches a
 * symlink inside the root that points outside it.
 *
 * @param {string} root absolute, already-realpath'd root directory
 * @param {string} virtual client-supplied virtual path
 * @param {{allowMissing?: boolean}} [opts] allowMissing: the leaf need not
 *   exist yet (create/upload targets); its parent still must resolve inside
 *   the root.
 */
export async function resolveSafe(root, virtual, opts = {}) {
  const norm = normalizeVirtual(virtual);
  const absolute = path.resolve(root, '.' + norm);

  // Lexical containment: absolute must be the root itself or sit under root + sep.
  if (!isInsideRoot(root, absolute)) {
    throw new FsError(403, 'OUTSIDE_ROOT', 'The path leaves the root directory');
  }

  try {
    const real = await fs.realpath(absolute);
    if (!isInsideRoot(root, real)) {
      throw new FsError(403, 'OUTSIDE_ROOT', 'The path leads outside the root directory (symbolic link)');
    }
    return { absolute: real, virtual: norm, exists: true };
  } catch (err) {
    if (err instanceof FsError) throw err;
    if (err.code !== 'ENOENT') throw err;

    if (!opts.allowMissing) {
      throw new FsError(404, 'NOT_FOUND', `Not found: ${norm}`, { path: norm });
    }
    // The leaf may be missing, but the parent must exist and be inside the
    // root — otherwise a symlinked parent could still redirect the write.
    const parentAbs = path.dirname(absolute);
    let realParent;
    try {
      realParent = await fs.realpath(parentAbs);
    } catch (parentErr) {
      if (parentErr.code === 'ENOENT') {
        throw new FsError(
          404,
          'NOT_FOUND',
          `Parent directory not found: ${parentVirtual(norm)}`,
          { path: parentVirtual(norm) }
        );
      }
      throw parentErr;
    }
    if (!isInsideRoot(root, realParent)) {
      throw new FsError(403, 'OUTSIDE_ROOT', 'The parent directory is outside the root');
    }
    return { absolute: path.join(realParent, path.basename(absolute)), virtual: norm, exists: false };
  }
}

/** True when `child` is `parent` or sits underneath it (virtual paths). */
export function isSameOrInside(parent, child) {
  const p = normalizeVirtual(parent);
  const c = normalizeVirtual(child);
  if (p === '/') return true;
  return c === p || c.startsWith(p + '/');
}
