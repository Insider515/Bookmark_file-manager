import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';

/**
 * POSIX tar, read and write, with no dependencies.
 *
 * tar is 512-byte header blocks each followed by the file's bytes padded up to
 * the next 512-byte boundary, and two zero blocks at the end. That is the
 * whole format, which is why it is worth implementing here rather than pulling
 * in a package: the reader and the writer together are shorter than the
 * dependency's own README.
 *
 * Long paths use PAX extended headers rather than the GNU `L` convention —
 * both are read, but PAX is the standard one and is what every modern tar
 * writes.
 */

const BLOCK = 512;
const ZERO_BLOCK = Buffer.alloc(BLOCK);

const TYPE_FILE = '0';
const TYPE_HARDLINK = '1';
const TYPE_SYMLINK = '2';
const TYPE_DIRECTORY = '5';
const TYPE_PAX_NEXT = 'x';
const TYPE_PAX_GLOBAL = 'g';
const TYPE_GNU_LONGNAME = 'L';
const TYPE_GNU_LONGLINK = 'K';

/** Right-aligned octal with a trailing NUL, the way tar stores numbers. */
function octal(value, width) {
  const text = Math.max(0, Math.floor(value)).toString(8);
  if (text.length > width - 1) {
    // Sizes past 8 GiB do not fit the octal field; GNU base-256 encoding does.
    const buffer = Buffer.alloc(width);
    buffer[0] = 0x80;
    let remaining = BigInt(Math.floor(value));
    for (let i = width - 1; i > 0; i -= 1) {
      buffer[i] = Number(remaining & 0xffn);
      remaining >>= 8n;
    }
    return buffer;
  }
  return Buffer.from(text.padStart(width - 1, '0') + '\0', 'ascii');
}

/** Read a numeric field, in either octal or GNU base-256 form. */
function parseNumber(buffer) {
  if (buffer.length === 0) return 0;
  if (buffer[0] & 0x80) {
    let value = 0n;
    for (let i = 1; i < buffer.length; i += 1) value = (value << 8n) | BigInt(buffer[i]);
    return Number(value);
  }
  const text = buffer.toString('ascii').replace(/\0.*$/, '').trim();
  if (!text) return 0;
  const parsed = Number.parseInt(text, 8);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseString(buffer) {
  const end = buffer.indexOf(0);
  return buffer.subarray(0, end === -1 ? buffer.length : end).toString('utf8');
}

/** The checksum tar stores: the header's bytes summed with the field blanked. */
function checksum(header) {
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) {
    sum += i >= 148 && i < 156 ? 0x20 : header[i];
  }
  return sum;
}

/**
 * Split a path into ustar's name/prefix pair, or return null when it will not
 * fit and a PAX header is needed instead.
 */
function splitName(name) {
  const bytes = Buffer.from(name, 'utf8');
  if (bytes.length <= 100) return { name, prefix: '' };
  if (bytes.length > 255) return null;
  // The split has to land on a slash, and the two halves have their own caps.
  for (let i = Math.min(155, bytes.length - 1); i > 0; i -= 1) {
    if (bytes[i] === 0x2f) {
      const prefix = bytes.subarray(0, i).toString('utf8');
      const rest = bytes.subarray(i + 1).toString('utf8');
      if (Buffer.byteLength(rest) <= 100 && Buffer.byteLength(prefix) <= 155) {
        return { name: rest, prefix };
      }
    }
  }
  return null;
}

function buildHeader({ name, prefix = '', size, mode, mtime, type, linkname = '', uid = 0, gid = 0 }) {
  const header = Buffer.alloc(BLOCK);
  header.write(name, 0, 100, 'utf8');
  octal(mode & 0o7777, 8).copy(header, 100);
  octal(uid, 8).copy(header, 108);
  octal(gid, 8).copy(header, 116);
  octal(size, 12).copy(header, 124);
  octal(Math.floor(mtime / 1000), 12).copy(header, 136);
  header.write(type, 156, 1, 'ascii');
  header.write(linkname, 157, 100, 'utf8');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  header.write(prefix, 345, 155, 'utf8');
  // Written last: it is computed over everything above. The field is six
  // octal digits, a NUL and a space — not seven digits — and writing it any
  // other way makes every tar in existence reject the archive.
  header.write(checksum(header).toString(8).padStart(6, '0'), 148, 6, 'ascii');
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

/** Pad a length up to the next 512-byte block. */
function padding(size) {
  const remainder = size % BLOCK;
  return remainder === 0 ? 0 : BLOCK - remainder;
}

/** A PAX extended header block pair carrying one long path. */
function paxHeader(path, type, mtime) {
  // Each record is "<len> key=value\n" where <len> counts its own digits too,
  // so the length has to be solved for rather than computed in one step.
  const record = (key, value) => {
    const rest = Buffer.byteLength(` ${key}=${value}\n`, 'utf8');
    let total = rest + String(rest).length;
    while (String(total).length + rest !== total) total = String(total).length + rest;
    return Buffer.from(`${total} ${key}=${value}\n`, 'utf8');
  };
  const payload = record('path', path);
  const header = buildHeader({
    name: '././@PaxHeader',
    size: payload.length,
    mode: 0o644,
    mtime,
    type,
  });
  return [header, payload, Buffer.alloc(padding(payload.length))];
}

/**
 * Stream a set of files as a tar archive.
 *
 * @param {AsyncIterable<object>|Iterable<object>} entries
 *   {absolute, relative, size, modified, mode?, isDirectory?}
 * @param {{onError?: (err: Error, entry: object) => void}} [options]
 * @returns {import('node:stream').Readable}
 */
export function createTarStream(entries, options = {}) {
  async function* generate() {
    for await (const entry of entries) {
      const name = String(entry.relative).replace(/\\/g, '/').replace(/^\/+/, '');
      if (!name) continue;

      const isDirectory = Boolean(entry.isDirectory);
      const storedName = isDirectory && !name.endsWith('/') ? `${name}/` : name;
      const size = isDirectory ? 0 : Number(entry.size ?? 0);
      const mtime = entry.modified instanceof Date ? entry.modified.getTime() : Date.now();
      const mode = entry.mode ?? (isDirectory ? 0o755 : 0o644);

      const split = splitName(storedName);
      if (!split) {
        // Too long for ustar's fields; PAX carries the real path ahead of a
        // header whose own name field is only a placeholder.
        for (const block of paxHeader(storedName, TYPE_PAX_NEXT, mtime)) yield block;
      }

      yield buildHeader({
        name: split ? split.name : storedName.slice(0, 100),
        prefix: split ? split.prefix : '',
        size,
        mode,
        mtime,
        type: isDirectory ? TYPE_DIRECTORY : TYPE_FILE,
      });

      if (isDirectory || size === 0) continue;

      let written = 0;
      try {
        for await (const chunk of createReadStream(entry.absolute)) {
          written += chunk.length;
          // The header already declared the size; a file that grew mid-archive
          // would desynchronise every entry after it.
          if (written > size) {
            yield chunk.subarray(0, chunk.length - (written - size));
            written = size;
            break;
          }
          yield chunk;
        }
      } catch (err) {
        if (!options.onError) throw err;
        options.onError(err, entry);
      }

      if (written < size) yield Buffer.alloc(size - written); // truncated mid-read
      const pad = padding(size);
      if (pad > 0) yield Buffer.alloc(pad);
    }

    // Two zero blocks close the archive.
    yield ZERO_BLOCK;
    yield ZERO_BLOCK;
  }

  return Readable.from(generate());
}

/** Buffered pull-reader over an async byte source. */
class ByteReader {
  #iterator;
  #buffer = Buffer.alloc(0);
  #done = false;

  constructor(source) {
    this.#iterator = source[Symbol.asyncIterator]();
  }

  async #fill(length) {
    while (this.#buffer.length < length && !this.#done) {
      const { value, done } = await this.#iterator.next();
      if (done) {
        this.#done = true;
        break;
      }
      this.#buffer = this.#buffer.length === 0 ? value : Buffer.concat([this.#buffer, value]);
    }
  }

  /** Exactly `length` bytes, or null at a clean end of input. */
  async read(length) {
    await this.#fill(length);
    if (this.#buffer.length < length) return null;
    const out = this.#buffer.subarray(0, length);
    this.#buffer = this.#buffer.subarray(length);
    return out;
  }

  /** Up to `length` bytes, for streaming a body out in pieces. */
  async readSome(length) {
    if (this.#buffer.length === 0) await this.#fill(1);
    if (this.#buffer.length === 0) return null;
    const take = Math.min(length, this.#buffer.length);
    const out = this.#buffer.subarray(0, take);
    this.#buffer = this.#buffer.subarray(take);
    return out;
  }

  async skip(length) {
    let remaining = length;
    while (remaining > 0) {
      const chunk = await this.readSome(remaining);
      if (chunk === null) return;
      remaining -= chunk.length;
    }
  }
}

/**
 * Walk a tar stream.
 *
 * Yields `{header, body}` where body is an async iterable of the entry's
 * bytes. The body is drained automatically before the next entry, so a
 * consumer that only wants the listing can ignore it.
 *
 * Nothing here validates paths — a tar may legitimately contain anything, and
 * deciding what is safe to write is the extractor's job, not the parser's.
 *
 * @param {import('node:stream').Readable} source
 */
export async function* readTar(source) {
  const reader = new ByteReader(source);
  let pendingPath = null;
  let pendingLink = null;

  for (;;) {
    const block = await reader.read(BLOCK);
    if (block === null) return;

    // A zero block ends the archive; a second confirms it, but one is enough
    // to stop, since trailing garbage is not ours to interpret.
    if (block.every((byte) => byte === 0)) return;

    const stored = parseNumber(block.subarray(148, 156));
    if (stored !== checksum(block)) {
      throw Object.assign(new Error('Corrupt tar: the header checksum does not match'), {
        code: 'TAR_BAD_CHECKSUM',
      });
    }

    const type = String.fromCharCode(block[156]) || TYPE_FILE;
    const size = parseNumber(block.subarray(124, 136));
    const prefix = parseString(block.subarray(345, 500));
    const rawName = parseString(block.subarray(0, 100));

    // PAX and GNU long-name blocks describe the *next* entry rather than being
    // one; read them, remember what they said, and move on.
    if (type === TYPE_PAX_NEXT || type === TYPE_PAX_GLOBAL) {
      const payload = (await reader.read(size)) ?? Buffer.alloc(0);
      await reader.skip(padding(size));
      if (type === TYPE_PAX_NEXT) {
        for (const line of payload.toString('utf8').split('\n')) {
          const match = /^\d+ ([^=]+)=(.*)$/.exec(line);
          if (match && match[1] === 'path') pendingPath = match[2];
          if (match && match[1] === 'linkpath') pendingLink = match[2];
        }
      }
      continue;
    }
    if (type === TYPE_GNU_LONGNAME || type === TYPE_GNU_LONGLINK) {
      const payload = (await reader.read(size)) ?? Buffer.alloc(0);
      await reader.skip(padding(size));
      const value = parseString(payload);
      if (type === TYPE_GNU_LONGNAME) pendingPath = value;
      else pendingLink = value;
      continue;
    }

    const name = pendingPath ?? (prefix ? `${prefix}/${rawName}` : rawName);
    const linkname = pendingLink ?? parseString(block.subarray(157, 257));
    pendingPath = null;
    pendingLink = null;

    const header = {
      name,
      size,
      mode: parseNumber(block.subarray(100, 108)) & 0o7777,
      mtime: new Date(parseNumber(block.subarray(136, 148)) * 1000),
      type:
        type === TYPE_DIRECTORY
          ? 'directory'
          : type === TYPE_SYMLINK
            ? 'symlink'
            : type === TYPE_HARDLINK
              ? 'link'
              : type === TYPE_FILE || type === '\0'
                ? 'file'
                : 'other',
      linkname,
    };

    let remaining = size;
    let drained = false;
    const body = {
      async *[Symbol.asyncIterator]() {
        while (remaining > 0) {
          const chunk = await reader.readSome(remaining);
          if (chunk === null) break;
          remaining -= chunk.length;
          yield chunk;
        }
        drained = true;
      },
    };

    yield { header, body };

    if (!drained) await reader.skip(remaining);
    await reader.skip(padding(size));
  }
}
