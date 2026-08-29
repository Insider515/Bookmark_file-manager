import fs from 'node:fs/promises';
import path from 'node:path';

import { decodeText } from './sheet/csv.js';
import { isInsideRoot, joinVirtual } from './safe-path.js';
import { looksBinary } from './text.js';

/**
 * Recursive search over the tree.
 *
 * The walk itself is unremarkable; what needs care is everything around it.
 *
 * A search is the one place where a user hands the server a *program* — a
 * regular expression — and asks it to run it over arbitrary input. JavaScript's
 * regex engine backtracks, so a pattern like `(a+)+b` against a long line does
 * not take longer, it takes forever, and no amount of checking the clock
 * between files helps because the whole request is stuck inside one call to
 * `exec`. That is why this module is written to be run in a worker thread that
 * the caller can terminate outright (see search-worker.js). Everything here is
 * arranged for that: results are streamed out in batches as they are found, so
 * killing a search that overran still returns what it had.
 *
 * The second concern is the walk not being a way to read files the user cannot
 * otherwise read. Symlinks are followed only while they stay inside the root,
 * exactly as the listing does, and searching *inside* files is gated on the
 * `download` permission by the caller — being able to see a filename is not
 * the same as being able to read its contents.
 */

export const SEARCH_MODES = ['substring', 'glob', 'regex'];
export const SEARCH_TYPES = ['all', 'file', 'directory'];
export const SEARCH_SCOPES = ['name', 'content', 'both'];

export const DEFAULT_SEARCH_LIMITS = {
  /** Matches returned. Past this the answer is "narrow your search". */
  maxResults: 500,
  /** Entries looked at, match or not. */
  maxEntries: 200000,
  /** Directory levels below the starting point. */
  maxDepth: 32,
  /** Milliseconds the walk gives itself before stopping and saying so. */
  timeout: 10000,
  /** Files larger than this are not read for content. */
  maxContentBytes: 2 * 1024 * 1024,
  /** Matching lines reported per file. */
  maxMatchesPerFile: 5,
  /** Characters of a line kept in the reported excerpt. */
  excerptLength: 240,
  /** Searches allowed to run at once; each one is a thread. */
  maxConcurrent: 4,
};

export function searchError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

/**
 * Repeated from fs-ops rather than imported: this module runs in a worker, and
 * importing fs-ops would pull the archive, spreadsheet and document services
 * into every thread a search starts. FsOps passes its own value through, so
 * the two cannot drift where it matters.
 */
export const DEFAULT_TEMP_PREFIX = '.fsfm-upload-';

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Turn a shell-style mask into an expression.
 *
 * `*` stops at a slash and `**` crosses them, which is what makes
 * `src/**\/*.test.js` mean what people expect. `{a,b}` and `[a-z]` are here
 * because a mask without them is not really a mask.
 */
export function globToRegExp(pattern, { caseSensitive = false } = {}) {
  let out = '';
  let depth = 0;

  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];

    if (char === '*') {
      if (pattern[i + 1] === '*') {
        i += 1;
        // `**/` also matches no directory at all, so `**/x` finds `/x`.
        if (pattern[i + 1] === '/') {
          out += '(?:.*/)?';
          i += 1;
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
      continue;
    }
    if (char === '?') {
      out += '[^/]';
      continue;
    }
    if (char === '[') {
      let end = i + 1;
      if (pattern[end] === '!' || pattern[end] === '^') end += 1;
      if (pattern[end] === ']') end += 1; // a `]` first in the set is literal
      while (end < pattern.length && pattern[end] !== ']') end += 1;
      if (end >= pattern.length) {
        out += '\\['; // unterminated: it is just a bracket
        continue;
      }
      let body = pattern.slice(i + 1, end);
      const negated = body.startsWith('!') || body.startsWith('^');
      if (negated) body = body.slice(1);
      // `-` is left alone so ranges keep working; the rest cannot be trusted.
      out += `[${negated ? '^' : ''}${body.replace(/[\\\]^]/g, '\\$&')}]`;
      i = end;
      continue;
    }
    if (char === '{') {
      depth += 1;
      out += '(?:';
      continue;
    }
    if (char === '}' && depth > 0) {
      depth -= 1;
      out += ')';
      continue;
    }
    if (char === ',' && depth > 0) {
      out += '|';
      continue;
    }
    out += escapeRegExp(char);
  }

  // An unclosed brace is a literal one, not a syntax error worth refusing over.
  while (depth > 0) {
    out += ')';
    depth -= 1;
  }
  return new RegExp(`^${out}$`, caseSensitive ? '' : 'i');
}

/**
 * How one string is tested against the query.
 *
 * Returns where the match is, not just whether there is one: a content hit is
 * useless without the position to build the excerpt around.
 */
export function compileMatcher({ query, mode, caseSensitive }) {
  if (mode === 'regex') {
    let expression;
    try {
      expression = new RegExp(query, caseSensitive ? '' : 'i');
    } catch (err) {
      throw searchError(400, 'INVALID_REGEX', `Invalid regular expression: ${err.message}`);
    }
    return {
      find(text) {
        const found = expression.exec(text);
        // A zero-width match is real but has nothing to highlight.
        return found ? { index: found.index, length: found[0].length || 1 } : null;
      },
    };
  }

  if (mode === 'glob') {
    const expression = globToRegExp(query, { caseSensitive });
    return {
      // A mask is anchored: it describes the whole name, not a part of it.
      find(text) {
        return expression.test(text) ? { index: 0, length: text.length } : null;
      },
    };
  }

  const needle = caseSensitive ? query : query.toLowerCase();
  return {
    find(text) {
      const haystack = caseSensitive ? text : text.toLowerCase();
      const index = haystack.indexOf(needle);
      return index === -1 ? null : { index, length: needle.length };
    },
  };
}

/** Validate and fill in what the client asked for. Throws on bad input. */
export function normaliseSearchOptions(raw = {}, limits = DEFAULT_SEARCH_LIMITS) {
  const query = typeof raw.query === 'string' ? raw.query : '';
  const mode = SEARCH_MODES.includes(raw.mode) ? raw.mode : 'substring';
  const type = SEARCH_TYPES.includes(raw.type) ? raw.type : 'all';
  const scope = SEARCH_SCOPES.includes(raw.scope) ? raw.scope : 'name';

  const extensions = (Array.isArray(raw.extensions)
    ? raw.extensions
    : String(raw.extensions ?? '').split(/[,\s]+/)
  )
    .map((item) => String(item).trim().replace(/^[.*]+/, '').toLowerCase())
    .filter(Boolean);

  if (query.length > 1024) {
    throw searchError(400, 'QUERY_TOO_LONG', 'The query is too long');
  }
  if (extensions.length > 64) {
    throw searchError(400, 'TOO_MANY_EXTENSIONS', 'Too many extensions in the filter');
  }
  // A search with nothing to match on would walk the whole tree and return its
  // first N entries, which is a listing pretending to be a search.
  if (!query && extensions.length === 0) {
    throw searchError(400, 'EMPTY_QUERY', 'Say what to search for: a string, a mask or an extension');
  }
  if (scope !== 'name' && !query) {
    throw searchError(400, 'EMPTY_QUERY', 'Searching contents needs a query string');
  }
  if (scope !== 'name' && type === 'directory') {
    throw searchError(
      400,
      'CONTENT_NEEDS_FILES',
      'Searching contents cannot be combined with searching folders only'
    );
  }

  const number = (value, fallback, max) => {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.min(parsed, max);
  };

  const options = {
    query,
    mode,
    caseSensitive: Boolean(raw.caseSensitive),
    type,
    scope,
    extensions,
    maxDepth: number(raw.maxDepth, limits.maxDepth, limits.maxDepth),
    maxResults: number(raw.limit ?? raw.maxResults, limits.maxResults, limits.maxResults),
  };

  // Compile now so a broken pattern is a 400 before a thread is started for it.
  if (query) compileMatcher(options);
  return options;
}

/** True when a symlink resolves to something still inside the root. */
async function staysInside(root, absolute) {
  try {
    return isInsideRoot(root, await fs.realpath(absolute));
  } catch {
    return false;
  }
}

/** The extension of a name, lowercased, without the dot. */
function extensionOf(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** A window of a line around the match, so a long line is not sent whole. */
function excerpt(line, index, width) {
  if (line.length <= width) return { text: line, column: index };
  const start = Math.max(0, index - Math.floor(width / 3));
  const head = start > 0 ? '…' : '';
  const body = line.slice(start, start + width);
  const tail = start + width < line.length ? '…' : '';
  return { text: head + body + tail, column: index - start + head.length };
}

/**
 * The lines of a file that match, or null when the file is not searchable.
 *
 * Binary files are skipped by the same NUL-byte test the editor uses: without
 * it every JPEG in the tree would be decoded as several megabytes of mojibake
 * and then searched, which is slow and finds nothing anyone wanted.
 */
async function searchContent(absolute, size, matcher, limits) {
  if (size > limits.maxContentBytes) return null;

  let buffer;
  try {
    buffer = await fs.readFile(absolute);
  } catch {
    return null;
  }
  if (looksBinary(buffer)) return null;

  let text;
  try {
    ({ text } = decodeText(buffer));
  } catch {
    return null;
  }

  const lines = text.split('\n');
  const found = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].replace(/\r$/, '');
    const hit = matcher.find(line);
    if (!hit) continue;
    const { text: shown, column } = excerpt(line, hit.index, limits.excerptLength);
    found.push({ line: i + 1, column, length: hit.length, text: shown });
    if (found.length >= limits.maxMatchesPerFile) break;
  }
  return found.length > 0 ? found : null;
}

/**
 * Walk a tree and report what matches.
 *
 * @param {object} config
 * @param {string} config.root the containment boundary
 * @param {string} config.baseAbsolute where to start
 * @param {string} config.baseVirtual the same place, as the client sees it
 * @param {object} config.options from normaliseSearchOptions
 * @param {object} [config.limits]
 * @param {string} [config.tempPrefix] names of uploads in flight, to skip
 * @param {(batch: object[]) => void} [config.onBatch] called as matches appear
 */
export async function runSearch({
  root,
  baseAbsolute,
  baseVirtual,
  options,
  limits = DEFAULT_SEARCH_LIMITS,
  tempPrefix = DEFAULT_TEMP_PREFIX,
  onBatch,
}) {
  const startedAt = Date.now();
  const deadline = startedAt + limits.timeout;
  const matcher = options.query ? compileMatcher(options) : null;
  const extensions = new Set(options.extensions);
  const wantsContent = options.scope !== 'name';
  const wantsName = options.scope !== 'content';
  // A mask containing a slash describes a path, so it is matched against the
  // path relative to where the search started rather than against the name.
  const matchesPath = options.mode === 'glob' && options.query.includes('/');

  const matches = [];
  let batch = [];
  let scanned = 0;
  let truncated = false;
  let timedOut = false;

  const flush = () => {
    if (batch.length > 0 && onBatch) {
      onBatch(batch);
      batch = [];
    }
  };

  const stop = () => {
    if (truncated || timedOut) return true;
    if (Date.now() > deadline) {
      timedOut = true;
      return true;
    }
    return false;
  };

  const push = (entry) => {
    matches.push(entry);
    batch.push(entry);
    if (batch.length >= 25) flush();
    if (matches.length >= options.maxResults) truncated = true;
  };

  const describe = async (absolute, virtual, isDirectory, lines) => {
    let stats;
    try {
      stats = await fs.stat(absolute);
    } catch {
      return;
    }
    const mode = stats.mode & 0o7777;
    push({
      name: path.basename(virtual),
      path: virtual,
      parent: path.posix.dirname(virtual) || '/',
      isDirectory,
      size: isDirectory ? null : stats.size,
      modified: stats.mtime.toISOString(),
      mode,
      modeOctal: mode.toString(8).padStart(3, '0'),
      executable: !isDirectory && (mode & 0o111) !== 0,
      matchedIn: lines ? 'content' : 'name',
      ...(lines ? { lines } : {}),
    });
  };

  // Directories are remembered by their real path: a symlink pointing at an
  // ancestor is legal, inside the root, and would otherwise walk forever.
  const visited = new Set();

  const walk = async (absolute, virtual, depth) => {
    if (stop() || depth > options.maxDepth) return;

    let dirents;
    try {
      dirents = await fs.readdir(absolute, { withFileTypes: true });
    } catch {
      // One unreadable directory must not fail the whole search.
      return;
    }

    const subdirectories = [];

    for (const dirent of dirents) {
      if (stop()) return;
      if (dirent.name.startsWith(tempPrefix)) continue;

      scanned += 1;
      if (scanned > limits.maxEntries) {
        truncated = true;
        return;
      }

      const childAbsolute = path.join(absolute, dirent.name);
      const childVirtual = joinVirtual(virtual, dirent.name);

      let isDirectory = dirent.isDirectory();
      let isFile = dirent.isFile();
      if (dirent.isSymbolicLink()) {
        if (!(await staysInside(root, childAbsolute))) continue;
        try {
          const stats = await fs.stat(childAbsolute);
          isDirectory = stats.isDirectory();
          isFile = stats.isFile();
        } catch {
          continue; // broken link
        }
      }
      if (!isDirectory && !isFile) continue; // sockets, fifos, devices

      if (isDirectory) subdirectories.push({ childAbsolute, childVirtual });

      if (options.type === 'file' && isDirectory) continue;
      if (options.type === 'directory' && !isDirectory) continue;
      if (extensions.size > 0 && !extensions.has(extensionOf(dirent.name))) continue;

      // No query at all means the filters *are* the search: every entry of the
      // right kind and extension is a result.
      if (!matcher) {
        await describe(childAbsolute, childVirtual, isDirectory, null);
        continue;
      }

      if (wantsName) {
        const subject = matchesPath
          ? childVirtual.slice(baseVirtual === '/' ? 1 : baseVirtual.length + 1)
          : dirent.name;
        if (matcher.find(subject)) {
          await describe(childAbsolute, childVirtual, isDirectory, null);
          continue;
        }
      }

      if (wantsContent && isFile) {
        let size = 0;
        try {
          size = (await fs.stat(childAbsolute)).size;
        } catch {
          continue;
        }
        const lines = await searchContent(childAbsolute, size, matcher, limits);
        if (lines) await describe(childAbsolute, childVirtual, false, lines);
      }
    }

    for (const child of subdirectories) {
      if (stop()) return;
      let real;
      try {
        real = await fs.realpath(child.childAbsolute);
      } catch {
        continue;
      }
      if (visited.has(real)) continue;
      visited.add(real);
      await walk(child.childAbsolute, child.childVirtual, depth + 1);
    }
  };

  await walk(baseAbsolute, baseVirtual, 0);
  flush();

  return {
    matches,
    scanned,
    truncated,
    timedOut,
    elapsed: Date.now() - startedAt,
  };
}
