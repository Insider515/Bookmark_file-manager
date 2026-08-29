/**
 * Turning an archive entry's name into a path it is safe to write.
 *
 * This is the single most important function in the archive code. An archive
 * is untrusted input whose entries are *filenames*, and the classic attack —
 * "zip slip" — is simply an entry called `../../etc/cron.d/root`. Every
 * extractor that has ever been wrong here was wrong by trusting the name.
 *
 * The rule taken is refuse, not repair. A name that has to be rewritten to be
 * safe is a name whose archive is either broken or hostile, and quietly
 * writing it somewhere else hides both cases.
 */

/** Longest path depth an entry may have. */
export const MAX_ENTRY_DEPTH = 64;

/** Longest single segment, matching the limit on names created directly. */
const MAX_SEGMENT = 255;

/** Windows-reserved and control characters, same set the rest of the code uses. */
const ILLEGAL_SEGMENT = /[\\:*?"<>|\u0000-\u001F]/;

const RESERVED_WINDOWS = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/**
 * Validate one entry name.
 *
 * @param {string} raw the name exactly as the archive stores it
 * @returns {{ok: true, segments: string[], path: string} | {ok: false, reason: string}}
 */
export function safeEntryPath(raw) {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { ok: false, reason: 'empty name' };
  }
  if (raw.includes('\0')) {
    return { ok: false, reason: 'NUL byte in the name' };
  }

  // Both separators, because an archive written on Windows uses backslashes
  // and a POSIX extractor that ignores them treats the whole path as one name.
  const normalized = raw.replace(/\\/g, '/');

  if (normalized.startsWith('/')) {
    return { ok: false, reason: 'absolute path' };
  }
  // "C:/x" and "\\\\server\\share" — absolute in their own way.
  if (/^[a-zA-Z]:/.test(normalized)) {
    return { ok: false, reason: 'path with a drive letter' };
  }

  const segments = [];
  for (const segment of normalized.split('/')) {
    if (segment === '' || segment === '.') continue; // "./a" and "a//b" are fine
    if (segment === '..') {
      return { ok: false, reason: 'escapes the directory (“..”)' };
    }
    if (segment.length > MAX_SEGMENT) {
      return { ok: false, reason: 'path segment too long' };
    }
    if (ILLEGAL_SEGMENT.test(segment)) {
      return { ok: false, reason: 'illegal characters in the name' };
    }
    // A trailing dot or space is dropped by Windows, which would make the name
    // on disk differ from the name in the archive.
    if (/[. ]$/.test(segment)) {
      return { ok: false, reason: 'name ends with a dot or a space' };
    }
    if (RESERVED_WINDOWS.has(segment.split('.')[0].toLowerCase())) {
      return { ok: false, reason: 'reserved system name' };
    }
    segments.push(segment);
  }

  if (segments.length === 0) {
    return { ok: false, reason: 'empty path' };
  }
  if (segments.length > MAX_ENTRY_DEPTH) {
    return { ok: false, reason: 'nested too deeply' };
  }

  return { ok: true, segments, path: segments.join('/') };
}
