import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import zlib from 'node:zlib';

import { createZipStream } from '../zip.js';
import { createTarStream, readTar } from './tar.js';
import { ZipArchive } from './zip-read.js';
import { safeEntryPath } from './safe-entry.js';
import {
  FORMATS,
  FORMAT_IDS,
  formatFromName,
  isArchiveName,
  resolveFormat,
  strippedName,
} from './formats.js';
import {
  NODE_HAS_ZSTD,
  archiveToTarStream,
  detectTools,
  filterCommand,
  filterThrough,
  tarStreamToArchive,
} from './tools.js';

export { FORMATS, FORMAT_IDS, formatFromName, isArchiveName, resolveFormat, strippedName, detectTools };
export { safeEntryPath } from './safe-entry.js';

/** Defaults for the guards against a hostile or merely enormous archive. */
export const DEFAULT_LIMITS = {
  /** Entries an archive may contain. */
  maxEntries: 100000,
  /** Bytes an archive may expand to in total. */
  maxTotalBytes: 5 * 1024 * 1024 * 1024,
  /** Bytes any single entry may expand to. */
  maxEntrySize: 2 * 1024 * 1024 * 1024,
  /** Milliseconds an external tool may run. */
  toolTimeout: 10 * 60 * 1000,
};

function archiveError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

/**
 * Packing, unpacking, and an honest account of which formats this particular
 * machine can actually handle.
 *
 * Everything funnels through the tar reader and writer in this directory, even
 * the formats a subprocess handles — see tools.js for why. The consequence
 * worth knowing: entry names are validated in one place, by safeEntryPath, for
 * every format alike.
 */
export class ArchiveService {
  #tools = { enabled: false, found: {} };
  #limits;
  #onWarning;

  constructor({ limits = {}, onWarning } = {}) {
    this.#limits = { ...DEFAULT_LIMITS, ...limits };
    this.#onWarning = onWarning;
  }

  /** Probe for external tools. Idempotent; call once at startup. */
  async init({ tools = true } = {}) {
    this.#tools = await detectTools({ enabled: tools });
    return this;
  }

  get tools() {
    return this.#tools;
  }

  /** Whether a filter can be run in this deployment, and by what. */
  #filterSupport(filter) {
    if (filter === 'gz') return 'node';
    if (filter === 'zst' && NODE_HAS_ZSTD) return 'node';
    return filterCommand(this.#tools.found, filter, 'decompress') ? 'tool' : null;
  }

  /**
   * What this machine can read and write, per format.
   *
   * Computed rather than declared, because it depends on the Node version and
   * on which programs happen to be installed. The widget renders exactly this,
   * so it never offers a format that would fail.
   */
  capabilities() {
    const result = {};
    for (const id of FORMAT_IDS) {
      const format = FORMATS[id];
      let read = false;
      let write = false;

      if (format.kind === 'container') {
        if (id === 'zip' || id === 'tar') {
          read = true;
          write = true; // both implemented here outright
        } else if (id === '7z') {
          read = Boolean(this.#tools.found.bsdtar);
          write = Boolean(this.#tools.found.bsdtar);
        } else if (id === 'rar') {
          read = Boolean(this.#tools.found.bsdtar || this.#tools.found.unrar);
          write = false; // see FORMATS.rar — no free encoder exists
        }
      } else {
        const support = this.#filterSupport(format.filter);
        read = support !== null;
        write = support !== null;
      }

      result[id] = {
        read,
        write,
        readOnly: Boolean(format.readOnly),
        label: format.label,
        kind: format.kind,
        // Sent to the widget so it can recognise an archive by name without
        // keeping its own copy of this table to drift out of step with.
        extensions: format.extensions,
      };
    }
    return result;
  }

  #assertCan(format, direction) {
    const capability = this.capabilities()[format.id];
    if (!capability || !capability[direction]) {
      if (format.readOnly && direction === 'write') {
        throw archiveError(
          501,
          'FORMAT_READ_ONLY',
          `${format.label} can only be extracted: there is no free packer for it`
        );
      }
      throw archiveError(
        501,
        'FORMAT_UNAVAILABLE',
        `${format.label} is not available on this server`
      );
    }
  }

  // ------------------------------------------------------------- compression

  /** A stream that compresses, by whichever route this machine has. */
  #compress(filter, source) {
    if (filter === 'gz') return source.pipe(zlib.createGzip());
    if (filter === 'zst' && NODE_HAS_ZSTD) return source.pipe(zlib.createZstdCompress());
    const command = filterCommand(this.#tools.found, filter, 'compress');
    if (!command) throw archiveError(501, 'FORMAT_UNAVAILABLE', `No packer for ${filter}`);
    return filterThrough(command.binary, command.args, source, {
      timeout: this.#limits.toolTimeout,
      onWarning: this.#onWarning,
    });
  }

  /** The mirror of the above. */
  #decompress(filter, source) {
    if (filter === 'gz') return source.pipe(zlib.createGunzip());
    if (filter === 'zst' && NODE_HAS_ZSTD) return source.pipe(zlib.createZstdDecompress());
    const command = filterCommand(this.#tools.found, filter, 'decompress');
    if (!command) throw archiveError(501, 'FORMAT_UNAVAILABLE', `No unpacker for ${filter}`);
    return filterThrough(command.binary, command.args, source, {
      timeout: this.#limits.toolTimeout,
      onWarning: this.#onWarning,
    });
  }

  // -------------------------------------------------------------- packing

  /**
   * Create an archive.
   *
   * @param {object} options
   * @param {AsyncIterable<object>} options.entries {absolute, relative, size, modified, mode, isDirectory}
   * @param {string} options.destination absolute path to write
   * @param {object} options.format one of FORMATS
   * @param {{absolute: string, name: string}} [options.singleFile] for the
   *   filter formats, which hold exactly one file and no names
   */
  async pack({ entries, destination, format, singleFile }) {
    this.#assertCan(format, 'write');

    if (format.kind === 'filter') {
      if (!singleFile) {
        throw archiveError(
          400,
          'FORMAT_SINGLE_FILE',
          `${format.label} stores exactly one unnamed file — for several items use tar.${format.extension ?? format.filter}`
        );
      }
      const source = createReadStream(singleFile.absolute);
      await pipeline(this.#compress(format.filter, source), createWriteStream(destination));
      return;
    }

    if (format.id === 'zip') {
      const archive = createZipStream(entries, {
        onError: (err, entry) => this.#onWarning?.(`File skipped while archiving: ${entry.relative}`, err),
      });
      await pipeline(archive, createWriteStream(destination));
      return;
    }

    const tar = createTarStream(entries, {
      onError: (err, entry) => this.#onWarning?.(`File skipped while archiving: ${entry.relative}`, err),
    });

    if (format.id === 'tar') {
      await pipeline(tar, createWriteStream(destination));
      return;
    }
    if (format.kind === 'tar') {
      await pipeline(this.#compress(format.filter, tar), createWriteStream(destination));
      return;
    }
    if (format.id === '7z') {
      // libarchive re-packs the tar this project produced; the only path it is
      // given is the destination, which this code chose.
      await tarStreamToArchive(this.#tools.found, tar, destination, '7z', {
        timeout: this.#limits.toolTimeout,
        onWarning: this.#onWarning,
      });
      return;
    }

    throw archiveError(501, 'FORMAT_UNAVAILABLE', `${format.label} is not available`);
  }

  // ------------------------------------------------------------ unpacking

  /**
   * Read an archive's first bytes, so the format can be judged by content and
   * not only by whatever the file happens to be called.
   */
  async detect(absolute, name) {
    let head = Buffer.alloc(0);
    try {
      const handle = await fs.open(absolute, 'r');
      try {
        const buffer = Buffer.alloc(512);
        const { bytesRead } = await handle.read(buffer, 0, 512, 0);
        head = buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    } catch {
      head = Buffer.alloc(0);
    }
    return resolveFormat(name, head);
  }

  /**
   * A uniform entry stream for every readable format.
   *
   * zip is read directly; tar and its compressed variants go through the tar
   * reader; 7z and rar are converted to a tar stream by libarchive first. The
   * caller therefore only ever deals with one shape, and only one code path
   * decides what is safe to write.
   */
  async *#entries(absolute, format, context = {}) {
    if (format.id === 'zip') {
      const archive = await ZipArchive.open(absolute);
      try {
        for (const entry of archive.entries) {
          yield {
            name: entry.name,
            size: entry.size,
            type: entry.isDirectory ? 'directory' : 'file',
            mode: entry.mode,
            mtime: entry.mtime,
            encrypted: entry.encrypted,
            open: () => archive.createEntryStream(entry),
          };
        }
      } finally {
        await archive.close();
      }
      return;
    }

    if (format.kind === 'filter') {
      // No container: the whole file is one entry, named by stripping the
      // compression suffix off the archive's own name.
      const source = this.#decompress(format.filter, createReadStream(absolute));
      try {
        yield {
          name: strippedName(path.basename(absolute), format),
          size: null, // unknowable before decompressing
          type: 'file',
          mode: null,
          mtime: null,
          open: () => source,
        };
      } finally {
        source.destroy?.();
      }
      return;
    }

    let tarSource;
    if (format.id === 'tar') {
      tarSource = createReadStream(absolute);
    } else if (format.kind === 'tar') {
      tarSource = this.#decompress(format.filter, createReadStream(absolute));
    } else {
      // 7z, rar and anything else libarchive can read.
      tarSource = archiveToTarStream(this.#tools.found, absolute, {
        timeout: this.#limits.toolTimeout,
        onWarning: this.#onWarning,
      });
      if (!tarSource) {
        throw archiveError(501, 'FORMAT_UNAVAILABLE', `${format.label} is not available on this server`);
      }
      // Kept on the caller's own context, not on the instance: an instance
      // field outlives the call, so the next unpack of an unrelated archive
      // would inherit this one's stderr — and two at once would race for it.
      context.diagnostics = tarSource;
    }

    try {
      for await (const { header, body } of readTar(tarSource)) {
        yield {
          name: header.name,
          size: header.size,
          type: header.type,
          mode: header.mode,
          mtime: header.mtime,
          linkname: header.linkname,
          open: () => Readable.from(body),
        };
      }
    } finally {
      // readTar returns at the end-of-archive marker without reading the rest,
      // and a caller may stop earlier still. Either way the source — often a
      // subprocess pipe — has to be closed here or it stays open for good.
      tarSource.destroy?.();
    }
  }

  /** Just the listing, for showing what is inside without writing anything. */
  async list(absolute, name) {
    const format = await this.detect(absolute, name);
    if (!format) throw archiveError(400, 'NOT_AN_ARCHIVE', 'The file was not recognised as an archive');
    this.#assertCan(format, 'read');

    const items = [];
    const context = {};
    for await (const entry of this.#entries(absolute, format, context)) {
      items.push({
        name: entry.name,
        size: entry.size,
        isDirectory: entry.type === 'directory',
        type: entry.type,
        encrypted: Boolean(entry.encrypted),
      });
      if (items.length >= this.#limits.maxEntries) break;
    }
    return { format: format.id, label: format.label, items };
  }

  /**
   * Extract into `destination`, which must already exist and be empty.
   *
   * The caller owns the directory: on failure it is removed wholesale, which
   * is only safe because nothing else was ever in it.
   *
   * @returns {Promise<{written: number, bytes: number, skipped: Array<object>}>}
   */
  async unpack({ absolute, name, destination }) {
    const format = await this.detect(absolute, name);
    if (!format) throw archiveError(400, 'NOT_AN_ARCHIVE', 'The file was not recognised as an archive');
    this.#assertCan(format, 'read');

    const limits = this.#limits;
    const skipped = [];
    const context = {};
    let written = 0;
    let bytes = 0;

    for await (const entry of this.#entries(absolute, format, context)) {
      if (written + skipped.length >= limits.maxEntries) {
        throw archiveError(413, 'ARCHIVE_TOO_MANY', `The archive holds more than ${limits.maxEntries} entries`);
      }
      if (entry.encrypted) {
        skipped.push({ name: entry.name, reason: 'the entry is encrypted' });
        continue;
      }
      // Links are the other half of the traversal problem: a symlink entry
      // pointing at /etc followed by a file entry that writes "through" it
      // escapes a directory that every name check said was fine.
      if (entry.type === 'symlink' || entry.type === 'link') {
        skipped.push({ name: entry.name, reason: 'links are not extracted' });
        continue;
      }
      if (entry.type !== 'file' && entry.type !== 'directory') {
        skipped.push({ name: entry.name, reason: 'not a regular file' });
        continue;
      }

      const safe = safeEntryPath(entry.name);
      if (!safe.ok) {
        skipped.push({ name: entry.name, reason: safe.reason });
        continue;
      }

      const target = path.join(destination, ...safe.segments);
      if (entry.type === 'directory') {
        await fs.mkdir(target, { recursive: true });
        continue;
      }

      // A declared size over the budget is refused before a byte is written;
      // the running count below catches an archive that lied about it.
      if (entry.size !== null && entry.size > limits.maxEntrySize) {
        skipped.push({ name: entry.name, reason: 'the entry is over the size limit' });
        continue;
      }

      await fs.mkdir(path.dirname(target), { recursive: true });

      let entrySize = 0;
      const guard = async function* (source) {
        for await (const chunk of source) {
          entrySize += chunk.length;
          bytes += chunk.length;
          if (entrySize > limits.maxEntrySize) {
            throw archiveError(413, 'ARCHIVE_ENTRY_TOO_LARGE', `Entry “${entry.name}” is too large`);
          }
          if (bytes > limits.maxTotalBytes) {
            throw archiveError(413, 'ARCHIVE_TOO_LARGE', 'The unpacked size is over the limit');
          }
          yield chunk;
        }
      };

      // wx: a second entry with the same name must not silently replace the
      // first, and cannot be a pre-existing file because the directory is new.
      await pipeline(await entry.open(), guard, createWriteStream(target, { flags: 'wx' }));
      written += 1;

      if (entry.mode) {
        // Only the read/write/execute bits, and never setuid: an archive is
        // the last place that should be able to hand out a privileged binary.
        await fs.chmod(target, entry.mode & 0o777).catch(() => {});
      }
      if (entry.mtime instanceof Date && !Number.isNaN(entry.mtime.getTime())) {
        await fs.utimes(target, entry.mtime, entry.mtime).catch(() => {});
      }
    }

    // An archive that produced neither a file nor a reason is not "done": it
    // is one the reader could not make sense of. Saying so beats reporting a
    // successful extraction of nothing.
    if (written === 0 && skipped.length === 0) {
      const diagnostics = context.diagnostics?.toolDiagnostics?.() ?? '';
      if (diagnostics) {
        throw archiveError(
          422,
          'ARCHIVE_UNREADABLE',
          `Could not read the archive contents: ${diagnostics.split('\n')[0]}`
        );
      }
    }

    return { format: format.id, written, bytes, skipped };
  }
}
