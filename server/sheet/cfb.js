/**
 * The Compound File Binary container — the thing an .xls is wrapped in.
 *
 * OLE2 is a filesystem in a file: a header, a table of sector chains (the
 * FAT), a directory of named streams, and a second smaller allocation scheme
 * (the mini-FAT) for streams under 4 KiB, because a 200-byte stream in
 * 512-byte sectors would waste most of one.
 *
 * Only what an .xls needs is implemented: reading a named stream out, and
 * writing a small file containing one. Storages inside storages, red-black
 * balancing of the directory tree, and anything to do with sector 4096 sizes
 * are read but never produced.
 */

const SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

const FREE_SECTOR = 0xffffffff;
const END_OF_CHAIN = 0xfffffffe;
const FAT_SECTOR = 0xfffffffd;
const DIFAT_SECTOR = 0xfffffffc;

const ENTRY_SIZE = 128;
const TYPE_STREAM = 2;
const TYPE_ROOT = 5;

function cfbError(message) {
  return Object.assign(new Error(message), { code: 'CFB_INVALID' });
}

/** Read-only view of a compound file already in memory. */
export class CompoundFile {
  #buffer;
  #sectorSize;
  #miniSectorSize;
  #miniCutoff;
  #fat = [];
  #miniFat = [];
  #entries = [];
  #root = null;

  constructor(buffer) {
    this.#buffer = buffer;
    this.#parseHeader();
    this.#parseFat();
    this.#parseDirectory();
    this.#parseMiniFat();
  }

  static isCompoundFile(buffer) {
    return buffer.length >= 8 && buffer.subarray(0, 8).equals(SIGNATURE);
  }

  get entries() {
    return this.#entries;
  }

  #parseHeader() {
    const buffer = this.#buffer;
    if (!CompoundFile.isCompoundFile(buffer)) {
      throw cfbError('Not an OLE2 container: the signature does not match');
    }
    this.#sectorSize = 1 << buffer.readUInt16LE(30);
    this.#miniSectorSize = 1 << buffer.readUInt16LE(32);
    this.#miniCutoff = buffer.readUInt32LE(56);
    if (this.#sectorSize < 128 || this.#sectorSize > 1 << 20) {
      throw cfbError('Implausible sector size');
    }
  }

  /** Byte offset of a sector; sector 0 begins right after the 512-byte header. */
  #offsetOf(sector) {
    return (sector + 1) * this.#sectorSize;
  }

  #readSector(sector) {
    const start = this.#offsetOf(sector);
    if (start + this.#sectorSize > this.#buffer.length) {
      throw cfbError('The sector runs past the end of the file');
    }
    return this.#buffer.subarray(start, start + this.#sectorSize);
  }

  /**
   * The FAT is itself stored in sectors, and the list of *those* is the DIFAT:
   * 109 entries live in the header and the rest are chained through sectors of
   * their own.
   */
  #parseFat() {
    const buffer = this.#buffer;
    const fatSectorCount = buffer.readUInt32LE(44);
    const difat = [];

    for (let i = 0; i < 109; i += 1) {
      const sector = buffer.readUInt32LE(76 + i * 4);
      if (sector === FREE_SECTOR) break;
      difat.push(sector);
    }

    let next = buffer.readUInt32LE(68);
    const extraCount = buffer.readUInt32LE(72);
    const perSector = this.#sectorSize / 4 - 1;
    for (let guard = 0; next !== END_OF_CHAIN && next !== FREE_SECTOR && guard <= extraCount; guard += 1) {
      const sectorData = this.#readSector(next);
      for (let i = 0; i < perSector; i += 1) {
        const entry = sectorData.readUInt32LE(i * 4);
        if (entry === FREE_SECTOR) continue;
        difat.push(entry);
      }
      next = sectorData.readUInt32LE(perSector * 4);
    }

    for (const sector of difat.slice(0, Math.max(fatSectorCount, difat.length))) {
      const sectorData = this.#readSector(sector);
      for (let i = 0; i < this.#sectorSize / 4; i += 1) {
        this.#fat.push(sectorData.readUInt32LE(i * 4));
      }
    }
  }

  #parseMiniFat() {
    let sector = this.#buffer.readUInt32LE(60);
    const count = this.#buffer.readUInt32LE(64);
    for (let i = 0; i < count && sector !== END_OF_CHAIN && sector !== FREE_SECTOR; i += 1) {
      const data = this.#readSector(sector);
      for (let j = 0; j < this.#sectorSize / 4; j += 1) {
        this.#miniFat.push(data.readUInt32LE(j * 4));
      }
      sector = this.#fat[sector] ?? END_OF_CHAIN;
    }
  }

  #parseDirectory() {
    let sector = this.#buffer.readUInt32LE(48);
    const raw = [];
    const seen = new Set();
    while (sector !== END_OF_CHAIN && sector !== FREE_SECTOR) {
      if (seen.has(sector)) throw cfbError('Cyclic directory chain');
      seen.add(sector);
      raw.push(this.#readSector(sector));
      sector = this.#fat[sector] ?? END_OF_CHAIN;
    }

    const directory = Buffer.concat(raw);
    for (let offset = 0; offset + ENTRY_SIZE <= directory.length; offset += ENTRY_SIZE) {
      const nameLength = directory.readUInt16LE(offset + 64);
      const type = directory.readUInt8(offset + 66);
      if (type !== TYPE_STREAM && type !== TYPE_ROOT) continue;
      // The length counts the UTF-16 terminator, which is not part of the name.
      const name =
        nameLength > 2
          ? directory.subarray(offset, offset + nameLength - 2).toString('utf16le')
          : '';
      const entry = {
        name,
        type,
        start: directory.readUInt32LE(offset + 116),
        size: Number(directory.readBigUInt64LE(offset + 120)),
      };
      if (type === TYPE_ROOT) this.#root = entry;
      else this.#entries.push(entry);
    }
    if (!this.#root) throw cfbError('The container has no root entry');
  }

  /** Follow a chain through either allocation table. */
  #chain(start, table) {
    const sectors = [];
    let sector = start;
    const seen = new Set();
    while (sector !== END_OF_CHAIN && sector !== FREE_SECTOR && sector !== undefined) {
      if (seen.has(sector)) throw cfbError('Cyclic sector chain');
      seen.add(sector);
      sectors.push(sector);
      sector = table[sector];
      if (sector === FAT_SECTOR || sector === DIFAT_SECTOR) break;
    }
    return sectors;
  }

  /** The bytes of one named stream, or null when there is no such stream. */
  read(name) {
    const entry = this.#entries.find((item) => item.name === name);
    if (!entry) return null;

    if (entry.size >= this.#miniCutoff) {
      const parts = this.#chain(entry.start, this.#fat).map((sector) => this.#readSector(sector));
      return Buffer.concat(parts).subarray(0, entry.size);
    }

    // Small streams live inside the root entry's own stream, cut into
    // mini-sectors and chained through the mini-FAT.
    const miniStream = Buffer.concat(
      this.#chain(this.#root.start, this.#fat).map((sector) => this.#readSector(sector))
    );
    const parts = this.#chain(entry.start, this.#miniFat).map((sector) => {
      const start = sector * this.#miniSectorSize;
      return miniStream.subarray(start, start + this.#miniSectorSize);
    });
    return Buffer.concat(parts).subarray(0, entry.size);
  }
}

/**
 * Build a compound file holding a single stream.
 *
 * Enough for an .xls, which needs exactly one: "Workbook".
 *
 * @param {string} streamName
 * @param {Buffer} content
 * @returns {Buffer}
 */
export function buildCompoundFile(streamName, content) {
  return buildCompoundFileFrom([{ name: streamName, content }]);
}

/**
 * Build a compound file holding several named streams.
 *
 * Both allocation schemes are produced, because which one applies is not a
 * choice: a stream under the 4096-byte cutoff *must* live in the mini stream,
 * and a reader decides where to look purely from the recorded size. Writing a
 * small stream through the normal FAT produces a file that looks right and
 * reads back as garbage.
 *
 * The directory is a tree, not a list. A .doc needs two streams, and the
 * moment there is more than one the sibling pointers start being followed:
 * Word finds `1Table` by walking down from the root, so entries written in a
 * flat row with no links are invisible to it however correct their bytes are.
 *
 * @param {Array<{name: string, content: Buffer}>} streams
 * @returns {Buffer}
 */
export function buildCompoundFileFrom(streams) {
  const SECTOR = 512;
  const MINI_SECTOR = 64;
  const MINI_CUTOFF = 4096;
  const ENTRIES_PER_SECTOR = SECTOR / ENTRY_SIZE;

  const padTo = (buffer, unit) => {
    const remainder = buffer.length % unit;
    return remainder === 0 ? buffer : Buffer.concat([buffer, Buffer.alloc(unit - remainder)]);
  };

  const sectors = [];
  const chains = [];
  const append = (buffer) => {
    const padded = padTo(buffer, SECTOR);
    const start = padded.length === 0 ? END_OF_CHAIN : sectors.length;
    const count = padded.length / SECTOR;
    for (let i = 0; i < count; i += 1) sectors.push(padded.subarray(i * SECTOR, (i + 1) * SECTOR));
    if (count > 0) chains.push({ start, count });
    return { start, count };
  };

  const items = streams.map((stream) => ({
    name: stream.name,
    content: stream.content,
    small: stream.content.length < MINI_CUTOFF,
    start: END_OF_CHAIN,
  }));

  // --- large streams, each its own chain of ordinary sectors ---------------
  for (const item of items) {
    if (item.small || item.content.length === 0) continue;
    item.start = append(item.content).start;
  }

  // --- the mini stream, holding every small stream end to end -------------
  const miniParts = [];
  let miniSectorCount = 0;
  for (const item of items) {
    if (!item.small || item.content.length === 0) continue;
    const padded = padTo(item.content, MINI_SECTOR);
    item.start = miniSectorCount;
    item.miniSectors = padded.length / MINI_SECTOR;
    miniSectorCount += item.miniSectors;
    miniParts.push(padded);
  }

  let rootStart = END_OF_CHAIN;
  let rootSize = 0;
  let miniFatStart = END_OF_CHAIN;
  let miniFatCount = 0;

  if (miniParts.length > 0) {
    const miniStream = Buffer.concat(miniParts);
    rootSize = miniStream.length;
    rootStart = append(miniStream).start;

    miniFatCount = Math.max(1, Math.ceil((miniSectorCount * 4) / SECTOR));
    const miniFat = Buffer.alloc(SECTOR * miniFatCount, 0xff);
    let cursor = 0;
    for (const item of items) {
      if (!item.small || !item.miniSectors) continue;
      for (let i = 0; i < item.miniSectors; i += 1) {
        const last = i === item.miniSectors - 1;
        miniFat.writeUInt32LE(last ? END_OF_CHAIN : cursor + i + 1, (cursor + i) * 4);
      }
      cursor += item.miniSectors;
    }
    miniFatStart = append(miniFat).start;
  }

  // --- directory ----------------------------------------------------------
  const entryCount = items.length + 1;
  const directorySectors = Math.ceil(entryCount / ENTRIES_PER_SECTOR);
  const directoryStart = sectors.length;
  const payloadSectors = sectors.length;

  let fatCount = 1;
  for (let guard = 0; guard < 64; guard += 1) {
    const needed = Math.ceil(
      (payloadSectors + directorySectors + fatCount) / (SECTOR / 4)
    );
    if (needed === fatCount) break;
    fatCount = needed;
  }
  // Past 109 FAT sectors the header can no longer list them all and DIFAT
  // sectors would be required. Refusing beats writing a file that looks valid
  // and is not.
  if (fatCount > 109) {
    throw cfbError('The document is too large for this container');
  }

  const firstFatSector = directoryStart + directorySectors;
  const totalSectors = firstFatSector + fatCount;

  // --- FAT ----------------------------------------------------------------
  const fat = Buffer.alloc(SECTOR * fatCount, 0xff);
  const link = (start, count) => {
    for (let i = 0; i < count; i += 1) {
      fat.writeUInt32LE(i === count - 1 ? END_OF_CHAIN : start + i + 1, (start + i) * 4);
    }
  };
  for (const chain of chains) link(chain.start, chain.count);
  link(directoryStart, directorySectors);
  for (let i = 0; i < fatCount; i += 1) fat.writeUInt32LE(FAT_SECTOR, (firstFatSector + i) * 4);

  // --- directory entries, linked as a tree --------------------------------
  const directory = Buffer.alloc(SECTOR * directorySectors);
  const left = new Array(entryCount).fill(FREE_SECTOR);
  const right = new Array(entryCount).fill(FREE_SECTOR);

  // Entry order is the order a reader compares names in: shorter names sort
  // first, and only then does the uppercased text decide.
  const order = items
    .map((item, index) => ({ item, index: index + 1 }))
    .sort((a, b) => {
      if (a.item.name.length !== b.item.name.length) return a.item.name.length - b.item.name.length;
      const left = a.item.name.toUpperCase();
      const right = b.item.name.toUpperCase();
      return left < right ? -1 : left > right ? 1 : 0;
    })
    .map((entry) => entry.index);

  const buildTree = (range) => {
    if (range.length === 0) return FREE_SECTOR;
    const middle = range.length >> 1;
    const node = range[middle];
    left[node] = buildTree(range.slice(0, middle));
    right[node] = buildTree(range.slice(middle + 1));
    return node;
  };
  const treeRoot = buildTree(order);

  const writeEntry = (index, name, type, start, size, child) => {
    const base = index * ENTRY_SIZE;
    const encoded = Buffer.from(`${name}\0`, 'utf16le');
    encoded.copy(directory, base, 0, Math.min(encoded.length, 64));
    directory.writeUInt16LE(Math.min(encoded.length, 64), base + 64);
    directory.writeUInt8(type, base + 66);
    directory.writeUInt8(1, base + 67); // colour: black
    directory.writeUInt32LE(left[index] ?? FREE_SECTOR, base + 68);
    directory.writeUInt32LE(right[index] ?? FREE_SECTOR, base + 72);
    directory.writeUInt32LE(child, base + 76);
    directory.writeUInt32LE(start, base + 116);
    directory.writeBigUInt64LE(BigInt(size), base + 120);
  };

  writeEntry(0, 'Root Entry', TYPE_ROOT, rootStart, rootSize, treeRoot);
  items.forEach((item, index) => {
    writeEntry(index + 1, item.name, TYPE_STREAM, item.start, item.content.length, FREE_SECTOR);
  });
  for (let i = entryCount; i < directorySectors * ENTRIES_PER_SECTOR; i += 1) {
    directory.writeUInt8(0, i * ENTRY_SIZE + 66);
    directory.writeUInt32LE(FREE_SECTOR, i * ENTRY_SIZE + 68);
    directory.writeUInt32LE(FREE_SECTOR, i * ENTRY_SIZE + 72);
    directory.writeUInt32LE(FREE_SECTOR, i * ENTRY_SIZE + 76);
  }

  // --- header -------------------------------------------------------------
  const header = Buffer.alloc(SECTOR);
  SIGNATURE.copy(header, 0);
  header.writeUInt16LE(0x003e, 24);
  header.writeUInt16LE(0x0003, 26); // 512-byte sectors
  header.writeUInt16LE(0xfffe, 28);
  header.writeUInt16LE(9, 30);
  header.writeUInt16LE(6, 32);
  // Offset 40 counts directory sectors, but for 512-byte sectors the format
  // requires it to be zero and readers take it literally.
  header.writeUInt32LE(0, 40);
  header.writeUInt32LE(fatCount, 44);
  header.writeUInt32LE(directoryStart, 48);
  header.writeUInt32LE(MINI_CUTOFF, 56);
  header.writeUInt32LE(miniFatStart, 60);
  header.writeUInt32LE(miniFatCount, 64);
  header.writeUInt32LE(END_OF_CHAIN, 68);
  header.writeUInt32LE(0, 72);
  header.fill(0xff, 76, SECTOR);
  for (let i = 0; i < fatCount; i += 1) header.writeUInt32LE(firstFatSector + i, 76 + i * 4);

  const out = Buffer.alloc(SECTOR * (totalSectors + 1), 0);
  header.copy(out, 0);
  sectors.forEach((sector, index) => sector.copy(out, SECTOR * (1 + index)));
  directory.copy(out, SECTOR * (1 + directoryStart));
  fat.copy(out, SECTOR * (1 + firstFatSector));
  return out;
}
