/**
 * POSIX permission bits: parsing, formatting, and the rules about which of
 * them this router will touch.
 */

import { FsError } from './safe-path.js';

/** Everything below this is owner/group/other rwx; everything above is not. */
export const PERMISSION_MASK = 0o777;

/**
 * setuid, setgid and the sticky bit.
 *
 * Refused outright rather than exposed behind another switch. A file manager
 * reachable over HTTP has no legitimate reason to hand out setuid, and the
 * consequence of getting it wrong is not "wrong permissions" but a local
 * privilege escalation primitive sitting in a directory the same manager
 * accepts uploads into.
 */
export const SPECIAL_MASK = 0o7000;

/** "755" -> 0o755. Accepts an optional leading zero. */
export function parseOctalMode(value) {
  if (typeof value !== 'string') {
    // Deliberately not accepting numbers. `mode: 755` reads as octal to a
    // human and is decimal 755 (0o1363) to JSON — a difference nobody notices
    // until a file ends up world-writable.
    throw new FsError(400, 'INVALID_MODE', 'The mode must be a string of octal digits, for example "755"');
  }
  const trimmed = value.trim();
  if (!/^[0-7]{3,4}$/.test(trimmed)) {
    throw new FsError(400, 'INVALID_MODE', '3 or 4 octal digits were expected, for example "755"');
  }
  const parsed = Number.parseInt(trimmed, 8);
  if ((parsed & SPECIAL_MASK) !== 0) {
    throw new FsError(
      400,
      'SPECIAL_BITS_REFUSED',
      'The setuid, setgid and sticky bits cannot be set'
    );
  }
  return parsed & PERMISSION_MASK;
}

/** 0o755 -> "755". */
export function formatOctalMode(mode) {
  return (mode & PERMISSION_MASK).toString(8).padStart(3, '0');
}

/** 0o755 -> "rwxr-xr-x". */
export function formatModeText(mode) {
  const triad = (bits) =>
    (bits & 4 ? 'r' : '-') + (bits & 2 ? 'w' : '-') + (bits & 1 ? 'x' : '-');
  return triad((mode >> 6) & 7) + triad((mode >> 3) & 7) + triad(mode & 7);
}

/** True when any of the three execute bits is set. */
export function isExecutable(mode) {
  return (mode & 0o111) !== 0;
}

/**
 * The mode `chmod +x` / `chmod -x` would produce.
 *
 * Adding follows the read bits rather than setting all three blindly: a file
 * at 640 becomes 750, not 751, so "make executable" never widens who can reach
 * the file — only what they may do with it.
 */
export function withExecutable(mode, executable) {
  const base = mode & PERMISSION_MASK;
  if (!executable) return base & ~0o111;
  const fromRead = ((base & 0o444) >> 2) & 0o111;
  return base | fromRead;
}
