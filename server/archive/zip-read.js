import fs from 'node:fs/promises';
import { Readable, Transform, pipeline as pipelineCb } from 'node:stream';
import zlib from 'node:zlib';

/**
 * ZIP reader, the counterpart to the writer in ../zip.js.
 *
 * Reading a zip means reading its central directory — the index at the end —
 * and not the local headers scattered through the file. Those may legitimately
 * carry zeroes where the sizes go (the writer here does exactly that, deferring
 * them to a data descriptor), so a reader that trusts them gets nothing.
 * Everything below therefore seeks from the back.
 */

const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

const MAX_U16 = 0xffff;
const MAX_U32 = 0xffffffff;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

const FLAG_ENCRYPTED = 0x0001;
const FLAG_UTF8 = 0x0800;

/** The EOCD may be followed by up to 64 KiB of archive comment. */
const EOCD_SEARCH = 66560;

const CRC_TABLE = new Int32Array(256);
for (let i = 0; i < 256; i += 1) {
  let c = i;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[i] = c;
}

function crc32Update(crc, buffer) {
  let c = crc;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return c;
}

/** DOS date/time back into a Date. */
function dosToDate(time, date) {
  const year = 1980 + ((date >> 9) & 0x7f);
  const month = ((date >> 5) & 0x0f) - 1;
  const day = date & 0x1f;
  const hours = (time >> 11) & 0x1f;
  const minutes = (time >> 5) & 0x3f;
  const seconds = (time & 0x1f) * 2;
  const parsed = new Date(year, month, day, hours, minutes, seconds);
  return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
}

/**
 * Names are UTF-8 when the flag says so. Otherwise the spec says CP437, but in
 * practice most modern writers use UTF-8 without setting the bit — so the
 * bytes are tried as UTF-8 and only fall back when they are not valid.
 */
function decodeName(buffer, flags) {
  if (flags & FLAG_UTF8) return buffer.toString('utf8');
  const utf8 = buffer.toString('utf8');
  return utf8.includes('�') ? buffer.toString('latin1') : utf8;
}

function zipError(code, message) {
  return Object.assign(new Error(message), { code });
}

export class ZipArchive {
  #handle = null;
  #size = 0;

  /** @type {Array<object>} entries from the central directory */
  entries = [];

  static async open(absolutePath) {
    const archive = new ZipArchive();
    await archive.#open(absolutePath);
    return archive;
  }

  async #open(absolutePath) {
    this.#handle = await fs.open(absolutePath, 'r');
    this.#size = (await this.#handle.stat()).size;
    if (this.#size < 22) throw zipError('ZIP_TRUNCATED', 'The file is too small to be a ZIP archive');
    const eocd = await this.#findEocd();
    await this.#readCentralDirectory(eocd);
  }

  async #read(length, position) {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await this.#handle.read(buffer, 0, length, position);
    return buffer.subarray(0, bytesRead);
  }

  /** Scan backwards for the end-of-central-directory record. */
  async #findEocd() {
    const window = Math.min(this.#size, EOCD_SEARCH);
    const tail = await this.#read(window, this.#size - window);

    let offset = -1;
    for (let i = tail.length - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) === SIG_EOCD) {
        offset = i;
        break;
      }
    }
    if (offset === -1) throw zipError('ZIP_NO_EOCD', 'The ZIP central directory was not found');

    let count = tail.readUInt16LE(offset + 10);
    let directorySize = tail.readUInt32LE(offset + 12);
    let directoryStart = tail.readUInt32LE(offset + 16);

    // Any of the three saturated means the real values live in a Zip64 record.
    if (count === MAX_U16 || directorySize === MAX_U32 || directoryStart === MAX_U32) {
      const locatorOffset = offset - 20;
      if (locatorOffset >= 0 && tail.readUInt32LE(locatorOffset) === SIG_ZIP64_LOCATOR) {
        const zip64Offset = Number(tail.readBigUInt64LE(locatorOffset + 8));
        const record = await this.#read(56, zip64Offset);
        if (record.readUInt32LE(0) === SIG_ZIP64_EOCD) {
          count = Number(record.readBigUInt64LE(32));
          directorySize = Number(record.readBigUInt64LE(40));
          directoryStart = Number(record.readBigUInt64LE(48));
        }
      }
    }

    return { count, directorySize, directoryStart };
  }

  async #readCentralDirectory({ count, directorySize, directoryStart }) {
    if (directoryStart + directorySize > this.#size) {
      throw zipError('ZIP_TRUNCATED', 'The central directory runs past the end of the file');
    }
    const directory = await this.#read(directorySize, directoryStart);

    let cursor = 0;
    for (let index = 0; index < count; index += 1) {
      if (cursor + 46 > directory.length) break;
      if (directory.readUInt32LE(cursor) !== SIG_CENTRAL) {
        throw zipError('ZIP_BAD_CENTRAL', 'Corrupt central-directory entry');
      }

      const flags = directory.readUInt16LE(cursor + 8);
      const method = directory.readUInt16LE(cursor + 10);
      const time = directory.readUInt16LE(cursor + 12);
      const date = directory.readUInt16LE(cursor + 14);
      const crc = directory.readUInt32LE(cursor + 16);
      let compressedSize = directory.readUInt32LE(cursor + 20);
      let size = directory.readUInt32LE(cursor + 24);
      const nameLength = directory.readUInt16LE(cursor + 28);
      const extraLength = directory.readUInt16LE(cursor + 30);
      const commentLength = directory.readUInt16LE(cursor + 32);
      const externalAttributes = directory.readUInt32LE(cursor + 38);
      let localOffset = directory.readUInt32LE(cursor + 42);

      const nameBuffer = directory.subarray(cursor + 46, cursor + 46 + nameLength);
      const extra = directory.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength);

      // Zip64 extra field carries whatever overflowed, in a fixed order and
      // only for the fields that actually saturated.
      let extraCursor = 0;
      while (extraCursor + 4 <= extra.length) {
        const headerId = extra.readUInt16LE(extraCursor);
        const dataSize = extra.readUInt16LE(extraCursor + 2);
        if (headerId === 0x0001) {
          let field = extraCursor + 4;
          if (size === MAX_U32 && field + 8 <= extra.length) { size = Number(extra.readBigUInt64LE(field)); field += 8; }
          if (compressedSize === MAX_U32 && field + 8 <= extra.length) { compressedSize = Number(extra.readBigUInt64LE(field)); field += 8; }
          if (localOffset === MAX_U32 && field + 8 <= extra.length) { localOffset = Number(extra.readBigUInt64LE(field)); }
          break;
        }
        extraCursor += 4 + dataSize;
      }

      const name = decodeName(nameBuffer, flags);
      // The high 16 bits of the external attributes hold the unix mode when
      // the archive was made on a unix-like system.
      const unixMode = (externalAttributes >>> 16) & 0o7777;

      this.entries.push({
        name,
        size,
        compressedSize,
        method,
        crc,
        mtime: dosToDate(time, date),
        isDirectory: name.endsWith('/') || (size === 0 && name.endsWith('\\')),
        encrypted: (flags & FLAG_ENCRYPTED) !== 0,
        mode: unixMode || null,
        localOffset,
      });

      cursor += 46 + nameLength + extraLength + commentLength;
    }
  }

  /**
   * A readable stream of one entry's decompressed bytes.
   *
   * The local header is read only to learn how long its own name and extra
   * fields are — the data begins after them. Its size fields are ignored on
   * purpose; the central directory is the authority.
   */
  async createEntryStream(entry) {
    if (entry.encrypted) {
      throw zipError('ZIP_ENCRYPTED', `Entry is encrypted: ${entry.name}`);
    }
    if (entry.method !== METHOD_STORE && entry.method !== METHOD_DEFLATE) {
      throw zipError('ZIP_METHOD', `Unsupported compression method (${entry.method}): ${entry.name}`);
    }

    const local = await this.#read(30, entry.localOffset);
    if (local.readUInt32LE(0) !== SIG_LOCAL) {
      throw zipError('ZIP_BAD_LOCAL', `Corrupt local header: ${entry.name}`);
    }
    const dataStart =
      entry.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);

    const handle = this.#handle;
    const compressedSize = entry.compressedSize;

    async function* rawBytes() {
      let position = dataStart;
      let remaining = compressedSize;
      const buffer = Buffer.alloc(64 * 1024);
      while (remaining > 0) {
        const want = Math.min(buffer.length, remaining);
        const { bytesRead } = await handle.read(buffer, 0, want, position);
        if (bytesRead === 0) break;
        position += bytesRead;
        remaining -= bytesRead;
        yield Buffer.from(buffer.subarray(0, bytesRead));
      }
    }

    const source = Readable.from(rawBytes());
    if (entry.method === METHOD_STORE) return this.#verify(source, entry);
    return this.#verify(
      pipelineCb(source, zlib.createInflateRaw(), () => {}),
      entry
    );
  }

  /**
   * Check the CRC as the bytes go past.
   *
   * Not optional: without it a corrupt or tampered entry writes itself to disk
   * and nothing ever notices. The error surfaces at the end of the stream, so
   * the caller has to treat a failed pipeline as a failed extraction.
   */
  #verify(stream, entry) {
    let crc = ~0;
    let bytes = 0;
    const checker = new Transform({
      transform(chunk, _encoding, callback) {
        crc = crc32Update(crc, chunk);
        bytes += chunk.length;
        callback(null, chunk);
      },
      flush(callback) {
        const actual = (crc ^ ~0) >>> 0;
        if (bytes !== entry.size) {
          callback(zipError('ZIP_SIZE_MISMATCH', `Size mismatch: ${entry.name}`));
          return;
        }
        // A zero CRC in the directory means the writer never recorded one.
        if (entry.crc !== 0 && actual !== entry.crc) {
          callback(zipError('ZIP_CRC_MISMATCH', `Checksum mismatch: ${entry.name}`));
          return;
        }
        callback();
      },
    });
    return pipelineCb(stream, checker, () => {});
  }

  async close() {
    await this.#handle?.close();
    this.#handle = null;
  }
}
