/**
 * Client-side view of POSIX permission bits.
 *
 * A deliberate duplicate of the formatting in server/mode.js. The widget must
 * render a mode without a round trip — the permissions dialog updates its
 * preview on every checkbox — and the alternative, importing server code into
 * a browser bundle, would drag node built-ins along with it. The server stays
 * the only place that *parses* and enforces; this only draws.
 */

export const PERMISSION_MASK = 0o777;

/**
 * The three classes, in the order chmod writes them.
 *
 * The label is a translation key rather than text: this table is a constant,
 * shared by every widget on the page, and two widgets may be showing two
 * different languages.
 */
export const MODE_CLASSES = [
  { key: 'owner', labelKey: 'common.owner', shift: 6 },
  { key: 'group', labelKey: 'common.group', shift: 3 },
  { key: 'other', labelKey: 'common.others', shift: 0 },
];

/** The three bits, in the order chmod writes them. */
export const MODE_BITS = [
  { key: 'read', labelKey: 'common.read', value: 4, letter: 'r' },
  { key: 'write', labelKey: 'common.write', value: 2, letter: 'w' },
  { key: 'execute', labelKey: 'common.execute', value: 1, letter: 'x' },
];

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

/** "755" -> 0o755, or null when it is not three or four octal digits. */
export function parseOctalMode(value) {
  if (typeof value !== 'string' || !/^[0-7]{3,4}$/.test(value.trim())) return null;
  return Number.parseInt(value.trim(), 8) & PERMISSION_MASK;
}

export function isExecutable(mode) {
  return (mode & 0o111) !== 0;
}

/** What `chmod +x` / `-x` would produce; execute follows read, never widens it. */
export function withExecutable(mode, executable) {
  const base = mode & PERMISSION_MASK;
  if (!executable) return base & ~0o111;
  return base | (((base & 0o444) >> 2) & 0o111);
}

/** True when the class/bit pair is set in the mode. */
export function hasBit(mode, shift, value) {
  return ((mode >> shift) & 7 & value) !== 0;
}

/** Set or clear one class/bit pair. */
export function setBit(mode, shift, value, on) {
  const bit = value << shift;
  return on ? mode | bit : mode & ~bit;
}
