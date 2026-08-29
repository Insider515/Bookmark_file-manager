import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { createZipStream, zipFileName } from '../server/zip.js';

/** Collect a stream into one buffer. */
async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/**
 * Parse the central directory of a zip. Reading the archive through its own
 * index — rather than trusting the local headers we wrote — is what makes this
 * a real check: an unzip tool would do the same.
 */
function readCentralDirectory(buffer) {
  const eocdSignature = 0x06054b50;
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i -= 1) {
    if (buffer.readUInt32LE(i) === eocdSignature) {
      eocd = i;
      break;
    }
  }
  assert.notEqual(eocd, -1, 'end of central directory record not found');

  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = [];

  for (let i = 0; i < count; i += 1) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50, 'bad central header signature');
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const crc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');

    entries.push({ name, method, crc, compressedSize, uncompressedSize, localOffset, flags });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Extract one entry's bytes using its central-directory record. */
function readEntry(buffer, entry) {
  assert.equal(buffer.readUInt32LE(entry.localOffset), 0x04034b50, 'bad local header signature');
  const nameLength = buffer.readUInt16LE(entry.localOffset + 26);
  const extraLength = buffer.readUInt16LE(entry.localOffset + 28);
  const dataStart = entry.localOffset + 30 + nameLength + extraLength;
  const raw = buffer.subarray(dataStart, dataStart + entry.compressedSize);
  return entry.method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
}

describe('createZipStream', () => {
  let dir;

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fsfm-zip-'));
    await fs.mkdir(path.join(dir, 'nested'), { recursive: true });
    await fs.writeFile(path.join(dir, 'a.txt'), 'hello world\n'.repeat(500));
    await fs.writeFile(path.join(dir, 'b.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]));
    await fs.writeFile(path.join(dir, 'empty.txt'), '');
    await fs.writeFile(path.join(dir, 'nested', 'документ и файл.txt'), 'кириллица\n');
  });

  after(() => fs.rm(dir, { recursive: true, force: true }));

  /** Build the entry descriptors the zip writer expects. */
  async function entriesFor(relatives) {
    const result = [];
    for (const relative of relatives) {
      const absolute = path.join(dir, relative);
      const stats = await fs.stat(absolute);
      result.push({ absolute, relative, size: stats.size, modified: stats.mtime });
    }
    return result;
  }

  test('round-trips content, including an empty file', async () => {
    const files = await entriesFor(['a.txt', 'b.png', 'empty.txt']);
    const buffer = await collect(createZipStream(files));
    const central = readCentralDirectory(buffer);

    assert.deepEqual(central.map((entry) => entry.name), ['a.txt', 'b.png', 'empty.txt']);
    assert.equal(readEntry(buffer, central[0]).toString(), 'hello world\n'.repeat(500));
    assert.deepEqual([...readEntry(buffer, central[1])], [0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    assert.equal(readEntry(buffer, central[2]).length, 0);
  });

  test('deflates text but stores already-compressed formats', async () => {
    const files = await entriesFor(['a.txt', 'b.png']);
    const central = readCentralDirectory(await collect(createZipStream(files)));
    assert.equal(central[0].method, 8, 'text should deflate');
    assert.ok(central[0].compressedSize < central[0].uncompressedSize / 10);
    assert.equal(central[1].method, 0, 'png should be stored, not re-compressed');
  });

  test('unicode names survive and are flagged UTF-8', async () => {
    const files = await entriesFor(['nested/документ и файл.txt']);
    const buffer = await collect(createZipStream(files));
    const [entry] = readCentralDirectory(buffer);
    assert.equal(entry.name, 'nested/документ и файл.txt');
    assert.ok(entry.flags & 0x800, 'the UTF-8 name flag must be set');
    assert.equal(readEntry(buffer, entry).toString('utf8'), 'кириллица\n');
  });

  test('sizes and CRCs travel in a data descriptor', async () => {
    const files = await entriesFor(['a.txt']);
    const buffer = await collect(createZipStream(files));
    const [entry] = readCentralDirectory(buffer);
    // Flag bit 3 means the local header carries zeroes and the real values
    // follow the data — that is what lets the archive stream.
    assert.ok(entry.flags & 0x08);
    assert.equal(buffer.readUInt32LE(entry.localOffset + 14), 0, 'local crc must be deferred');
    assert.ok(entry.crc !== 0, 'the central directory must carry the real crc');
    assert.equal(entry.uncompressedSize, 'hello world\n'.repeat(500).length);
  });

  test('duplicate names are disambiguated, not emitted twice', async () => {
    const files = await entriesFor(['a.txt']);
    const central = readCentralDirectory(await collect(createZipStream([...files, ...files])));
    assert.deepEqual(central.map((entry) => entry.name), ['a.txt', 'a (2).txt']);
  });

  test('an unreadable file is skipped and the archive still completes', async () => {
    const files = await entriesFor(['a.txt']);
    files.push({
      absolute: path.join(dir, 'missing.txt'),
      relative: 'missing.txt',
      size: 10,
      modified: new Date(),
    });
    const skipped = [];
    const buffer = await collect(
      createZipStream(files, { onError: (_err, file) => skipped.push(file.relative) })
    );
    assert.deepEqual(skipped, ['missing.txt']);
    // The failed entry must not appear in the index readers actually use.
    assert.deepEqual(readCentralDirectory(buffer).map((entry) => entry.name), ['a.txt']);
  });

  test('without an onError handler a read failure propagates', async () => {
    const stream = createZipStream([
      { absolute: path.join(dir, 'missing.txt'), relative: 'missing.txt', size: 1, modified: new Date() },
    ]);
    await assert.rejects(collect(stream));
  });

  test('zipFileName sanitises and appends the extension once', () => {
    assert.equal(zipFileName('My Folder'), 'My Folder.zip');
    assert.equal(zipFileName('already.zip'), 'already.zip');
    assert.equal(zipFileName('a/b:c'), 'a_b_c.zip');
    assert.equal(zipFileName(''), 'archive.zip');
  });
});
