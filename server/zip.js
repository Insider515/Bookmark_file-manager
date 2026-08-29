import { createReadStream } from 'node:fs';
import { Readable, Transform, pipeline as pipelineCb } from 'node:stream';
import zlib from 'node:zlib';

/**
 * Minimal streaming ZIP writer.
 *
 * Entries are written with a data descriptor (general-purpose flag bit 3) so
 * nothing has to be buffered to learn the compressed size — the archive
 * streams straight to the HTTP response. Zip64 records are emitted per entry
 * and for the archive as a whole whenever a 32-bit field would overflow, so
 * both large files and large archives stay valid.
 *
 * Not supported (deliberately, to keep this dependency-free): encryption,
 * multi-disk archives, and preserving unix permissions.
 */

const SIG_LOCAL = 0x04034b50;
const SIG_DESCRIPTOR = 0x08074b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;

const MAX_U32 = 0xffffffff;
const MAX_U16 = 0xffff;

/** Values at or above this force Zip64 for an entry. */
const ZIP64_THRESHOLD = 0xfffff000;

const FLAG_DATA_DESCRIPTOR = 0x0008;
const FLAG_UTF8_NAMES = 0x0800;
const FLAGS = FLAG_DATA_DESCRIPTOR | FLAG_UTF8_NAMES;

const METHOD_DEFLATE = 8;
const METHOD_STORE = 0;

const CRC_TABLE = new Int32Array(256);
for (let i = 0; i < 256; i += 1) {
  let c = i;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[i] = c;
}

function crc32Update(crc, buf) {
  let c = crc;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return c;
}

/** Convert a JS Date to the DOS date/time pair stored in zip headers. */
function dosDateTime(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const year = d.getFullYear();
  if (year < 1980) return { time: 0, date: (1 << 5) | 1 };
  if (year > 2107) return { time: 0, date: ((2107 - 1980) << 9) | (12 << 5) | 31 };
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** Extensions whose bytes are already compressed; deflating them wastes CPU. */
const PRECOMPRESSED = new Set([
  'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'jar',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'heic',
  'mp3', 'mp4', 'm4a', 'mov', 'avi', 'mkv', 'webm', 'ogg', 'opus', 'flac',
  'pdf', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'woff', 'woff2',
]);

function chooseMethod(name, size) {
  if (size === 0) return METHOD_STORE;
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  return PRECOMPRESSED.has(ext) ? METHOD_STORE : METHOD_DEFLATE;
}

function writeU16(value) {
  const b = Buffer.allocUnsafe(2);
  b.writeUInt16LE(value, 0);
  return b;
}

function writeU32(value) {
  const b = Buffer.allocUnsafe(4);
  b.writeUInt32LE(value >>> 0, 0);
  return b;
}

function writeU64(value) {
  const b = Buffer.allocUnsafe(8);
  b.writeBigUInt64LE(BigInt(value), 0);
  return b;
}

/**
 * Stream a set of files as a zip archive.
 *
 * `files` may be an array or an async iterable. The async form is what lets a
 * directory download start sending bytes while its tree is still being walked,
 * instead of materialising the whole file list in memory first — which is the
 * difference between a constant footprint and one that scales with the number
 * of files in the directory.
 *
 * @param {Iterable<object>|AsyncIterable<object>} files entries as
 *   {relative, size?, modified?, isDirectory?} plus either `absolute` (read
 *   from disk) or `content` (a Buffer already in memory — which is how the
 *   spreadsheet writers build an .xlsx, whose parts are generated XML rather
 *   than files anywhere). `store: true` disables compression for that entry.
 * @param {{level?: number, onError?: (err: Error, file: object) => void}} [options]
 *   onError is called when one entry cannot be read; that entry is skipped and
 *   the rest of the archive still streams. Without it, the stream errors.
 * @returns {import('node:stream').Readable} the archive bytes
 */
export function createZipStream(files, options = {}) {
  const level = options.level ?? zlib.constants.Z_DEFAULT_COMPRESSION;

  async function* generate() {
    /** @type {Array<object>} central directory records, filled as we go */
    const central = [];
    let offset = 0;
    const usedNames = new Set();

    for await (const file of files) {
      // Zip stores forward slashes and no leading slash, regardless of host OS.
      let name = String(file.relative).replace(/\\/g, '/').replace(/^\/+/, '');
      if (!name) continue;
      // Two entries with the same name make an ambiguous archive; disambiguate
      // rather than emit a duplicate.
      if (usedNames.has(name)) {
        const dot = name.lastIndexOf('.');
        const stem = dot > 0 ? name.slice(0, dot) : name;
        const ext = dot > 0 ? name.slice(dot) : '';
        let n = 2;
        while (usedNames.has(`${stem} (${n})${ext}`)) n += 1;
        name = `${stem} (${n})${ext}`;
      }
      usedNames.add(name);

      // A directory is an entry with a trailing slash, no data and no
      // compression. Without it an archive of a tree loses every empty folder
      // in it, and the writer trips over trying to read a directory as a file.
      const isDirectory = Boolean(file.isDirectory);
      if (isDirectory && !name.endsWith('/')) name += '/';

      const inMemory = Buffer.isBuffer(file.content) ? file.content : null;
      const nameBuffer = Buffer.from(name, 'utf8');
      const knownSize = isDirectory ? 0 : Number(inMemory ? inMemory.length : file.size ?? 0);
      // `store` forces no compression. OpenDocument requires it for its
      // `mimetype` entry — the format says that entry must be first and
      // uncompressed, and a reader that checks will reject the file otherwise.
      const method =
        isDirectory || file.store ? METHOD_STORE : chooseMethod(name, knownSize);
      const { time, date } = dosDateTime(file.modified);
      // The uncompressed size is known from stat(), so Zip64 can be decided
      // before the local header is written; a deflated stream never grows past
      // the threshold margin left here.
      const entryZip64 = knownSize >= ZIP64_THRESHOLD;
      const versionNeeded = entryZip64 ? 45 : 20;

      const localOffset = offset;

      // --- local file header ---
      const localHeader = Buffer.concat([
        writeU32(SIG_LOCAL),
        writeU16(versionNeeded),
        writeU16(FLAGS),
        writeU16(method),
        writeU16(time),
        writeU16(date),
        writeU32(0), // crc32 — in the data descriptor
        writeU32(0), // compressed size — in the data descriptor
        writeU32(0), // uncompressed size — in the data descriptor
        writeU16(nameBuffer.length),
        writeU16(0), // no extra field; sizes travel in the descriptor
        nameBuffer,
      ]);
      yield localHeader;
      offset += localHeader.length;

      // --- file data ---
      let crc = ~0;
      let uncompressed = 0;
      let compressed = 0;
      let failed = null;

      if (isDirectory) {
        // Nothing to stream: close the entry immediately and record it.
        const emptyDescriptor = Buffer.concat([
          writeU32(SIG_DESCRIPTOR),
          writeU32(0),
          entryZip64 ? writeU64(0) : writeU32(0),
          entryZip64 ? writeU64(0) : writeU32(0),
        ]);
        yield emptyDescriptor;
        offset += emptyDescriptor.length;
        central.push({
          nameBuffer,
          method,
          time,
          date,
          crc: 0,
          compressed: 0,
          uncompressed: 0,
          localOffset,
          versionNeeded,
          isDirectory: true,
        });
        continue;
      }

      const source = inMemory ? Readable.from([inMemory]) : createReadStream(file.absolute);
      const tap = new Transform({
        transform(chunk, _enc, cb) {
          crc = crc32Update(crc, chunk);
          uncompressed += chunk.length;
          cb(null, chunk);
        },
      });

      let pipeError = null;
      const stages = [source, tap];
      if (method === METHOD_DEFLATE) stages.push(zlib.createDeflateRaw({ level }));
      const destination = pipelineCb(...stages, (err) => {
        if (err) pipeError = err;
      });

      try {
        for await (const chunk of destination) {
          compressed += chunk.length;
          yield chunk;
        }
        if (pipeError) throw pipeError;
      } catch (err) {
        failed = err;
      }

      if (failed) {
        if (!options.onError) throw failed;
        options.onError(failed, file);
        // The local header is already on the wire and cannot be recalled, so
        // close the entry honestly as a zero-length one and omit it from the
        // central directory — readers list only what the directory names.
        const descriptor = Buffer.concat([
          writeU32(SIG_DESCRIPTOR),
          writeU32(0),
          entryZip64 ? writeU64(0) : writeU32(0),
          entryZip64 ? writeU64(0) : writeU32(0),
        ]);
        yield descriptor;
        offset += descriptor.length;
        continue;
      }

      offset += compressed;

      // --- data descriptor ---
      const finalCrc = (crc ^ ~0) >>> 0;
      const descriptor = Buffer.concat([
        writeU32(SIG_DESCRIPTOR),
        writeU32(finalCrc),
        entryZip64 ? writeU64(compressed) : writeU32(compressed),
        entryZip64 ? writeU64(uncompressed) : writeU32(uncompressed),
      ]);
      yield descriptor;
      offset += descriptor.length;

      central.push({
        nameBuffer,
        method,
        time,
        date,
        crc: finalCrc,
        compressed,
        uncompressed,
        localOffset,
        versionNeeded,
      });
    }

    // --- central directory ---
    const centralStart = offset;
    for (const entry of central) {
      // Any field that overflows 32 bits is stored as 0xFFFFFFFF here and
      // carried at full width in the Zip64 extra field.
      const needSize = entry.uncompressed > MAX_U32 || entry.compressed > MAX_U32;
      const needOffset = entry.localOffset > MAX_U32;
      const extraParts = [];
      if (needSize || needOffset) {
        const payload = [];
        // Fixed order per the spec: uncompressed, compressed, local offset.
        if (needSize) payload.push(writeU64(entry.uncompressed), writeU64(entry.compressed));
        if (needOffset) payload.push(writeU64(entry.localOffset));
        const payloadBuffer = Buffer.concat(payload);
        extraParts.push(writeU16(0x0001), writeU16(payloadBuffer.length), payloadBuffer);
      }
      const extra = Buffer.concat(extraParts);

      const header = Buffer.concat([
        writeU32(SIG_CENTRAL),
        writeU16(0x031e), // made by: unix, spec 3.0
        writeU16(extra.length ? 45 : entry.versionNeeded),
        writeU16(FLAGS),
        writeU16(entry.method),
        writeU16(entry.time),
        writeU16(entry.date),
        writeU32(entry.crc),
        writeU32(needSize ? MAX_U32 : entry.compressed),
        writeU32(needSize ? MAX_U32 : entry.uncompressed),
        writeU16(entry.nameBuffer.length),
        writeU16(extra.length),
        writeU16(0), // comment length
        writeU16(0), // disk number start
        writeU16(0), // internal attributes
        // External attributes: the unix mode in the high half, and for a
        // directory the MS-DOS directory bit in the low half — some extractors
        // read one, some the other.
        writeU32(entry.isDirectory ? ((0o755 | 0o040000) << 16) | 0x10 : 0o644 << 16),
        writeU32(needOffset ? MAX_U32 : entry.localOffset),
        entry.nameBuffer,
        extra,
      ]);
      yield header;
      offset += header.length;
    }
    const centralSize = offset - centralStart;

    // --- end of central directory ---
    const needZip64End =
      central.length > MAX_U16 || centralSize > MAX_U32 || centralStart > MAX_U32;

    if (needZip64End) {
      const zip64Eocd = Buffer.concat([
        writeU32(SIG_ZIP64_EOCD),
        writeU64(44), // size of this record minus its first 12 bytes
        writeU16(0x031e), // version made by
        writeU16(45), // version needed
        writeU32(0), // this disk
        writeU32(0), // disk with central directory
        writeU64(central.length),
        writeU64(central.length),
        writeU64(centralSize),
        writeU64(centralStart),
      ]);
      yield zip64Eocd;

      yield Buffer.concat([
        writeU32(SIG_ZIP64_LOCATOR),
        writeU32(0), // disk with the zip64 eocd
        writeU64(offset), // its offset
        writeU32(1), // total disks
      ]);
      offset += zip64Eocd.length + 20;
    }

    yield Buffer.concat([
      writeU32(SIG_EOCD),
      writeU16(0),
      writeU16(0),
      writeU16(needZip64End ? MAX_U16 : central.length),
      writeU16(needZip64End ? MAX_U16 : central.length),
      writeU32(needZip64End ? MAX_U32 : centralSize),
      writeU32(needZip64End ? MAX_U32 : centralStart),
      writeU16(0), // archive comment length
    ]);
  }

  return Readable.from(generate());
}

/** Sanitise a name for use in a Content-Disposition filename. */
export function zipFileName(base) {
  const cleaned = String(base).replace(/[/\\:*?"<>|]/g, '_').trim() || 'archive';
  return cleaned.toLowerCase().endsWith('.zip') ? cleaned : `${cleaned}.zip`;
}
