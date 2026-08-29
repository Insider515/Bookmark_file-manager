/** Lowercase extension without the dot, or '' when there is none. */
export function extensionOf(name) {
  const dot = String(name).lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

const UNIT_KEYS = ['unit.b', 'unit.kb', 'unit.mb', 'unit.gb', 'unit.tb', 'unit.pb'];
/**
 * Used when no translator is passed. This module is also loaded by the
 * terminal's command language, which has no widget around it, so it must
 * produce something sensible on its own rather than depend on one.
 */
const UNITS_EN = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

/**
 * Human-readable size. Binary units, because that is what file managers show.
 *
 * @param {number|null|undefined} bytes
 * @param {(key: string) => string} [t] translator; English when omitted
 */
export function formatBytes(bytes, t) {
  if (bytes === null || bytes === undefined) return '';
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return '';
  const unitName = (index) => (t ? t(UNIT_KEYS[index]) : UNITS_EN[index]);
  if (value < 1024) return `${value} ${unitName(0)}`;
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < UNIT_KEYS.length - 1) {
    size /= 1024;
    unit += 1;
  }
  // One decimal below 10 keeps "1.4 MB" informative without noisy precision.
  return `${size < 10 ? size.toFixed(1) : Math.round(size)} ${unitName(unit)}`;
}

const DATE_OPTIONS = {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
};

// Building an Intl.DateTimeFormat is not cheap and a listing formats one date
// per row, so they are kept per language tag. `undefined` means "whatever the
// browser is set to", which is the right answer when the host picked no
// language: the date then matches the rest of the user's system.
const dateFormatters = new Map();

function formatterFor(tag) {
  if (!dateFormatters.has(tag)) {
    let formatter;
    try {
      formatter = new Intl.DateTimeFormat(tag || undefined, DATE_OPTIONS);
    } catch {
      // An unknown or malformed tag must not stop a folder from listing.
      formatter = new Intl.DateTimeFormat(undefined, DATE_OPTIONS);
    }
    dateFormatters.set(tag, formatter);
  }
  return dateFormatters.get(tag);
}

/**
 * Locale date/time, or '' for a missing or unparsable value.
 *
 * @param {string|number|Date|null|undefined} value
 * @param {string} [tag] BCP-47 tag; the browser's own setting when omitted
 */
export function formatDate(value, tag) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return formatterFor(tag).format(date);
}

/** Split a virtual path into breadcrumb segments, root first. */
export function pathSegments(virtualPath, rootLabel = 'Files') {
  const crumbs = [{ name: rootLabel, path: '/' }];
  const normalized = String(virtualPath || '/').replace(/^\/+|\/+$/g, '');
  if (!normalized) return crumbs;
  let accumulated = '';
  for (const segment of normalized.split('/')) {
    accumulated += `/${segment}`;
    crumbs.push({ name: segment, path: accumulated });
  }
  return crumbs;
}

/** Parent of a virtual path; root's parent is root. */
export function parentPath(virtualPath) {
  const normalized = String(virtualPath || '/');
  if (normalized === '/' || normalized === '') return '/';
  const cut = normalized.replace(/\/+$/, '').lastIndexOf('/');
  return cut <= 0 ? '/' : normalized.slice(0, cut);
}

/** Last segment of a virtual path. */
export function baseName(virtualPath) {
  const normalized = String(virtualPath || '/').replace(/\/+$/, '');
  if (normalized === '' || normalized === '/') return '';
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

/**
 * Slavic plural agreement: 1 файл, 2 файли, 5 файлів.
 *
 * The widget itself no longer calls this — plural forms live in the language
 * dictionaries now — but it stays exported because it was part of the public
 * API and is still the right tool for a host formatting its own Slavic text.
 */
export function pluralize(count, one, few, many) {
  const mod100 = Math.abs(count) % 100;
  const mod10 = mod100 % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

/**
 * Resolve a path the way a shell would: relative to where you are.
 *
 * `~` is the root of the manager, not a home directory — there is no home
 * here, and the root is the thing people mean by "the top".
 */
export function resolvePath(cwd, input) {
  const raw = String(input ?? '');
  if (raw === '' || raw === '.') return normalise(cwd);

  let base;
  let rest;
  if (raw === '~') return '/';
  if (raw.startsWith('/')) {
    base = '';
    rest = raw;
  } else if (raw.startsWith('~/')) {
    base = '';
    rest = raw.slice(1);
  } else {
    base = normalise(cwd);
    rest = raw;
  }

  const parts = [];
  for (const part of `${base}/${rest}`.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `/${parts.join('/')}`;
}

const normalise = (path) => {
  const parts = String(path ?? '/').split('/').filter((part) => part && part !== '.');
  return `/${parts.join('/')}`;
};
