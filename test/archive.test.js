import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

import { ArchiveService, FORMATS } from '../server/archive/index.js';
import { formatFromName, formatFromMagic, resolveFormat, strippedName } from '../server/archive/formats.js';
import { safeEntryPath } from '../server/archive/safe-entry.js';
import { createTarStream, readTar } from '../server/archive/tar.js';
import { ZipArchive } from '../server/archive/zip-read.js';
import { createZipStream } from '../server/zip.js';

let service;
let workdir;

before(async () => {
  workdir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'fsfm-arch-')));
  service = new ArchiveService();
  await service.init();
});

after(() => fs.rm(workdir, { recursive: true, force: true }));

/** A small tree to pack, and its hashes, so a round trip can be checked. */
async function makeTree(root) {
  await fs.mkdir(path.join(root, 'nested'), { recursive: true });
  await fs.mkdir(path.join(root, 'empty'), { recursive: true });
  await fs.writeFile(path.join(root, 'a.txt'), 'перший файл\n');
  await fs.writeFile(path.join(root, 'nested', 'b.txt'), 'вкладений\n');
  await fs.writeFile(path.join(root, 'nested', 'big.bin'), Buffer.alloc(70000, 7));
}

async function snapshot(root) {
  const out = {};
  const walk = async (dir, prefix) => {
    for (const dirent of await fs.readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, dirent.name);
      const rel = prefix ? `${prefix}/${dirent.name}` : dirent.name;
      if (dirent.isDirectory()) {
        out[`${rel.normalize('NFC')}/`] = 'dir';
        await walk(abs, rel);
      } else {
        out[rel.normalize('NFC')] = (await fs.readFile(abs)).toString('base64').slice(0, 24);
      }
    }
  };
  await walk(root, '');
  return out;
}

async function* entriesOf(dir, prefix = '') {
  for (const dirent of await fs.readdir(dir, { withFileTypes: true })) {
    const abs = path.join(dir, dirent.name);
    const rel = prefix ? `${prefix}/${dirent.name}` : dirent.name;
    const stats = await fs.stat(abs);
    if (dirent.isDirectory()) {
      yield { absolute: abs, relative: rel, isDirectory: true, size: 0, modified: stats.mtime, mode: stats.mode & 0o777 };
      yield* entriesOf(abs, rel);
    } else {
      yield { absolute: abs, relative: rel, size: stats.size, modified: stats.mtime, mode: stats.mode & 0o777 };
    }
  }
}

describe('archive: recognising formats', () => {
  test('a double extension is not mistaken for a single one', () => {
    // ".tar.gz" and ".gz" both end in gz; matching the short one first would
    // treat every tarball as a lone compressed file called "something.tar".
    assert.equal(formatFromName('backup.tar.gz').id, 'tar.gz');
    assert.equal(formatFromName('backup.tgz').id, 'tar.gz');
    assert.equal(formatFromName('notes.txt.gz').id, 'gz');
    assert.equal(formatFromName('x.tar.bz2').id, 'tar.bz2');
    assert.equal(formatFromName('x.tbz2').id, 'tar.bz2');
    assert.equal(formatFromName('x.tar.xz').id, 'tar.xz');
    assert.equal(formatFromName('x.tar').id, 'tar');
  });

  test('every requested format is known', () => {
    for (const name of [
      'a.zip', 'a.rar', 'a.7z', 'a.tar.gz', 'a.tgz', 'a.tar.bz2', 'a.tbz2',
      'a.tar.xz', 'a.tar', 'a.gz', 'a.bz2', 'a.xz', 'a.zst',
    ]) {
      assert.ok(formatFromName(name), `${name} має розпізнаватися`);
    }
    assert.equal(formatFromName('notes.txt'), null);
  });

  test('magic bytes identify a file whatever it is called', () => {
    assert.equal(formatFromMagic(Buffer.from([0x50, 0x4b, 0x03, 0x04])).id, 'zip');
    assert.equal(formatFromMagic(Buffer.from([0x1f, 0x8b, 0x08])).id, 'gz');
    assert.equal(formatFromMagic(Buffer.from([0x42, 0x5a, 0x68, 0x39])).id, 'bz2');
    assert.equal(formatFromMagic(Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])).id, 'xz');
    assert.equal(formatFromMagic(Buffer.from([0x28, 0xb5, 0x2f, 0xfd])).id, 'zst');
    assert.equal(formatFromMagic(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])).id, '7z');
    assert.equal(formatFromMagic(Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00])).id, 'rar');
  });

  test('content wins over the name, except where the name is more specific', () => {
    const gzipMagic = Buffer.from([0x1f, 0x8b, 0x08]);
    // Same bytes either way; only the name says whether a tar is inside.
    assert.equal(resolveFormat('a.tar.gz', gzipMagic).id, 'tar.gz');
    assert.equal(resolveFormat('a.gz', gzipMagic).id, 'gz');
    // A misnamed file is what its bytes say it is.
    assert.equal(resolveFormat('a.rar', Buffer.from([0x50, 0x4b, 0x03, 0x04])).id, 'zip');
  });

  test('stripping a compression suffix leaves the real name', () => {
    assert.equal(strippedName('notes.txt.gz', FORMATS.gz), 'notes.txt');
    assert.equal(strippedName('dump.sql.xz', FORMATS.xz), 'dump.sql');
  });
});

describe('archive: entry names are refused, not repaired', () => {
  test('traversal in every spelling is rejected', () => {
    for (const name of [
      '../escaped', 'a/../../escaped', '..', 'a/..', 'x/../../../etc/passwd',
      '..\\escaped', 'a\\..\\..\\escaped',
    ]) {
      const result = safeEntryPath(name);
      assert.equal(result.ok, false, `${name} має бути відхилено`);
      assert.match(result.reason, /escapes the directory/);
    }
  });

  test('absolute paths and drive letters are rejected', () => {
    assert.equal(safeEntryPath('/etc/passwd').ok, false);
    assert.equal(safeEntryPath('\\\\server\\share\\x').ok, false);
    assert.equal(safeEntryPath('C:/Windows/system32').ok, false);
  });

  test('a NUL byte in a name is rejected', () => {
    assert.equal(safeEntryPath('a\0b').ok, false);
  });

  test('ordinary names pass, with redundant parts folded away', () => {
    assert.equal(safeEntryPath('a/b.txt').path, 'a/b.txt');
    assert.equal(safeEntryPath('./a//b.txt').path, 'a/b.txt');
    assert.equal(safeEntryPath('тека/файл.txt').path, 'тека/файл.txt');
  });
});

describe('archive: tar interoperates with other tars', () => {
  let dir;
  before(async () => {
    dir = path.join(workdir, 'tar');
    await fs.mkdir(path.join(dir, 'src'), { recursive: true });
    await makeTree(path.join(dir, 'src'));
  });

  test('a tar written here reads back identically', async () => {
    const file = path.join(dir, 'out.tar');
    await pipeline(createTarStream(entriesOf(path.join(dir, 'src'))), createWriteStream(file));

    const names = [];
    for await (const { header, body } of readTar((await import('node:fs')).createReadStream(file))) {
      let bytes = 0;
      for await (const chunk of body) bytes += chunk.length;
      if (header.type === 'file') assert.equal(bytes, header.size, header.name);
      names.push(header.name);
    }
    assert.ok(names.includes('a.txt'));
    assert.ok(names.includes('nested/big.bin'));
    assert.ok(names.some((n) => n.startsWith('empty')), 'порожній каталог має зберегтися');
  });

  test('a path too long for ustar survives via a PAX header', async () => {
    const long = `${'дуже-довгий-сегмент/'.repeat(6)}файл.txt`;
    const src = path.join(dir, 'long.txt');
    await fs.writeFile(src, 'довгий шлях\n');

    const file = path.join(dir, 'long.tar');
    await pipeline(
      createTarStream([{ absolute: src, relative: long, size: 13 * 2, modified: new Date() }]),
      createWriteStream(file)
    );

    const seen = [];
    for await (const { header, body } of readTar((await import('node:fs')).createReadStream(file))) {
      for await (const _ of body) { /* drain */ }
      seen.push(header.name);
    }
    assert.deepEqual(seen, [long], 'ім’я має повернутися цілком');
  });

  test('a corrupt header is reported rather than guessed at', async () => {
    const file = path.join(dir, 'broken.tar');
    await fs.writeFile(file, Buffer.alloc(512, 0x41)); // 'A' * 512
    await assert.rejects(
      (async () => {
        for await (const _ of readTar((await import('node:fs')).createReadStream(file))) { /* */ }
      })(),
      (err) => err.code === 'TAR_BAD_CHECKSUM'
    );
  });
});

describe('archive: zip reads what it writes, and what others write', () => {
  let dir;
  before(async () => {
    dir = path.join(workdir, 'zip');
    await fs.mkdir(path.join(dir, 'src'), { recursive: true });
    await makeTree(path.join(dir, 'src'));
  });

  test('the writer produces an archive the reader can verify', async () => {
    // The writer defers sizes to a data descriptor, leaving zeroes in the
    // local headers — the exact case that forces a reader to use the central
    // directory instead.
    const file = path.join(dir, 'ours.zip');
    await pipeline(createZipStream(entriesOf(path.join(dir, 'src'))), createWriteStream(file));

    const archive = await ZipArchive.open(file);
    try {
      const byName = Object.fromEntries(archive.entries.map((e) => [e.name, e]));
      assert.ok(byName['a.txt']);
      assert.ok(byName['empty/'], 'порожній каталог має бути записаний як запис');

      // Streaming an entry verifies its CRC on the way past.
      let bytes = 0;
      for await (const chunk of await archive.createEntryStream(byName['nested/big.bin'])) {
        bytes += chunk.length;
      }
      assert.equal(bytes, 70000);
    } finally {
      await archive.close();
    }
  });

  test('a corrupted entry is caught, not written out as if it were fine', async () => {
    const file = path.join(dir, 'ours.zip');
    const corrupt = path.join(dir, 'corrupt.zip');

    // The byte to damage is computed from the entry's own offsets rather than
    // guessed: a fixed offset lands outside the compressed data as soon as a
    // filename changes length, and the test then proves nothing.
    const original = await ZipArchive.open(file);
    const target = original.entries.find((e) => !e.isDirectory && e.compressedSize > 8);
    const header = await fs.readFile(file);
    const nameLength = header.readUInt16LE(target.localOffset + 26);
    const extraLength = header.readUInt16LE(target.localOffset + 28);
    const dataStart = target.localOffset + 30 + nameLength + extraLength;
    await original.close();

    const bytes = Buffer.from(header);
    bytes[dataStart + 4] ^= 0xff; // inside the deflate stream
    await fs.writeFile(corrupt, bytes);

    const archive = await ZipArchive.open(corrupt);
    let failed = null;
    try {
      const stream = await archive.createEntryStream(target);
      for await (const chunk of stream) {
        void chunk; // drained to the end, where the checks run
      }
    } catch (err) {
      failed = err;
    } finally {
      await archive.close();
    }

    assert.ok(failed, 'пошкодження має бути помічено');
    // Either the deflate stream refuses it, or the CRC does at the end.
    assert.match(
      String(failed.code),
      /Z_DATA_ERROR|ZIP_CRC_MISMATCH|ZIP_SIZE_MISMATCH/,
      `неочікувана помилка: ${failed.code} ${failed.message}`
    );
  });
});

describe('archive: every available format round-trips', () => {
  let dir;
  let expected;

  before(async () => {
    dir = path.join(workdir, 'rt');
    await fs.mkdir(path.join(dir, 'src'), { recursive: true });
    await makeTree(path.join(dir, 'src'));
    expected = await snapshot(path.join(dir, 'src'));
  });

  for (const id of ['zip', 'tar', 'tar.gz', 'tar.bz2', 'tar.xz', 'tar.zst', '7z']) {
    test(`${id} packs and unpacks to the same tree`, async (t) => {
      const capability = service.capabilities()[id];
      if (!capability.write) return t.skip(`${id} недоступний на цій машині`);

      const format = FORMATS[id];
      const file = path.join(dir, `out.${format.extensions[0]}`);
      const out = path.join(dir, `un-${id.replace(/\./g, '_')}`);
      await fs.rm(file, { force: true });
      await fs.rm(out, { recursive: true, force: true });
      await fs.mkdir(out, { recursive: true });

      await service.pack({ entries: entriesOf(path.join(dir, 'src')), destination: file, format });
      const result = await service.unpack({ absolute: file, name: path.basename(file), destination: out });

      assert.equal(result.skipped.length, 0, JSON.stringify(result.skipped));
      assert.deepEqual(await snapshot(out), expected);
    });
  }

  for (const id of ['gz', 'bz2', 'xz', 'zst']) {
    test(`${id} carries a single file with no container`, async (t) => {
      const capability = service.capabilities()[id];
      if (!capability.write) return t.skip(`${id} недоступний на цій машині`);

      const format = FORMATS[id];
      const file = path.join(dir, `a.txt.${id}`);
      const out = path.join(dir, `f-${id}`);
      await fs.rm(out, { recursive: true, force: true });
      await fs.mkdir(out, { recursive: true });

      await service.pack({
        entries: [],
        destination: file,
        format,
        singleFile: { absolute: path.join(dir, 'src', 'a.txt'), name: 'a.txt' },
      });
      await service.unpack({ absolute: file, name: path.basename(file), destination: out });

      assert.equal(await fs.readFile(path.join(out, 'a.txt'), 'utf8'), 'перший файл\n');
    });
  }

  test('packing several things into a bare compressor is refused', async (t) => {
    if (!service.capabilities().gz.write) return t.skip('gz недоступний');
    await assert.rejects(
      service.pack({ entries: [], destination: path.join(dir, 'x.gz'), format: FORMATS.gz }),
      (err) => err.code === 'FORMAT_SINGLE_FILE'
    );
  });
});

describe('archive: rar is extract-only, by the format’s nature', () => {
  let dir;

  /**
   * A RAR 4 archive with stored entries, built here because nothing available
   * can create one — which is the very thing being tested.
   */
  function buildRar(files) {
    const crc16 = (buffer) => zlib.crc32(buffer) & 0xffff;
    const parts = [Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00])];

    const main = Buffer.alloc(11);
    main.writeUInt8(0x73, 0);
    main.writeUInt16LE(0x0000, 1);
    main.writeUInt16LE(13, 3);
    parts.push(Buffer.concat([Buffer.from([0, 0]), main]));
    parts[parts.length - 1].writeUInt16LE(crc16(main), 0);

    for (const [name, body] of files) {
      const nameBuffer = Buffer.from(name, 'utf8');
      const data = Buffer.from(body, 'utf8');
      const head = Buffer.alloc(32 + nameBuffer.length - 2);
      let offset = 0;
      head.writeUInt8(0x74, offset); offset += 1;
      head.writeUInt16LE(0x8000, offset); offset += 2;
      head.writeUInt16LE(32 + nameBuffer.length, offset); offset += 2;
      head.writeUInt32LE(data.length, offset); offset += 4;
      head.writeUInt32LE(data.length, offset); offset += 4;
      head.writeUInt8(3, offset); offset += 1; // host os: unix
      head.writeUInt32LE(zlib.crc32(data) >>> 0, offset); offset += 4;
      head.writeUInt32LE(0x54b60000, offset); offset += 4;
      head.writeUInt8(20, offset); offset += 1;
      head.writeUInt8(0x30, offset); offset += 1; // stored
      head.writeUInt16LE(nameBuffer.length, offset); offset += 2;
      // Unix attributes are the full st_mode: without the file-type bits
      // libarchive refuses the entry outright.
      head.writeUInt32LE(0o100644, offset); offset += 4;
      nameBuffer.copy(head, offset);

      const crcField = Buffer.alloc(2);
      crcField.writeUInt16LE(crc16(head), 0);
      parts.push(crcField, head, data);
    }

    const end = Buffer.alloc(5);
    end.writeUInt8(0x7b, 0);
    end.writeUInt16LE(0x4000, 1);
    end.writeUInt16LE(7, 3);
    const endCrc = Buffer.alloc(2);
    endCrc.writeUInt16LE(crc16(end), 0);
    parts.push(endCrc, end);

    return Buffer.concat(parts);
  }

  before(async () => {
    dir = path.join(workdir, 'rar');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'test.rar'),
      buildRar([['hello.txt', 'із RAR\n'], ['dir/inner.txt', 'вкладений\n']])
    );
  });

  test('creating one is refused with a reason, not a generic error', async () => {
    await assert.rejects(
      service.pack({ entries: [], destination: path.join(dir, 'x.rar'), format: FORMATS.rar }),
      (err) => err.code === 'FORMAT_READ_ONLY' && /can only be extracted/.test(err.message)
    );
  });

  test('capabilities say read but never write', () => {
    const rar = service.capabilities().rar;
    assert.equal(rar.write, false);
    assert.equal(rar.readOnly, true);
  });

  test('extraction works where a reader is installed', async (t) => {
    if (!service.capabilities().rar.read) return t.skip('немає bsdtar/unrar');
    const out = path.join(dir, 'out');
    await fs.rm(out, { recursive: true, force: true });
    await fs.mkdir(out);

    const result = await service.unpack({
      absolute: path.join(dir, 'test.rar'),
      name: 'test.rar',
      destination: out,
    });
    assert.equal(result.format, 'rar');
    assert.equal(result.written, 2);
    assert.equal(await fs.readFile(path.join(out, 'hello.txt'), 'utf8'), 'із RAR\n');
    assert.equal(await fs.readFile(path.join(out, 'dir', 'inner.txt'), 'utf8'), 'вкладений\n');
  });
});


/**
 * A RAR whose entry attributes omit the file-type bits. libarchive reads it,
 * writes a complaint to stderr, and still exits 0 — the exact shape that made
 * stale diagnostics observable.
 */
function buildNoisyRar() {
  const crc16 = (buffer) => zlib.crc32(buffer) & 0xffff;
  const parts = [Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00])];

  const main = Buffer.alloc(11);
  main.writeUInt8(0x73, 0);
  main.writeUInt16LE(0x0000, 1);
  main.writeUInt16LE(13, 3);
  const mainCrc = Buffer.alloc(2);
  mainCrc.writeUInt16LE(crc16(main), 0);
  parts.push(mainCrc, main);

  const nameBuffer = Buffer.from('x.txt', 'utf8');
  const data = Buffer.from('hi\n', 'utf8');
  const head = Buffer.alloc(30 + nameBuffer.length);
  let offset = 0;
  head.writeUInt8(0x74, offset); offset += 1;
  head.writeUInt16LE(0x8000, offset); offset += 2;
  head.writeUInt16LE(32 + nameBuffer.length, offset); offset += 2;
  head.writeUInt32LE(data.length, offset); offset += 4;
  head.writeUInt32LE(data.length, offset); offset += 4;
  head.writeUInt8(3, offset); offset += 1;
  head.writeUInt32LE(zlib.crc32(data) >>> 0, offset); offset += 4;
  head.writeUInt32LE(0x54b60000, offset); offset += 4;
  head.writeUInt8(20, offset); offset += 1;
  head.writeUInt8(0x30, offset); offset += 1;
  head.writeUInt16LE(nameBuffer.length, offset); offset += 2;
  head.writeUInt32LE(0o644, offset); offset += 4; // no S_IFREG: the complaint
  nameBuffer.copy(head, offset);

  const headCrc = Buffer.alloc(2);
  headCrc.writeUInt16LE(crc16(head), 0);
  parts.push(headCrc, head, data);

  const end = Buffer.alloc(5);
  end.writeUInt8(0x7b, 0);
  end.writeUInt16LE(0x4000, 1);
  end.writeUInt16LE(7, 3);
  const endCrc = Buffer.alloc(2);
  endCrc.writeUInt16LE(crc16(end), 0);
  parts.push(endCrc, end);

  return Buffer.concat(parts);
}

describe('archive: hostile input', () => {
  let dir;

  before(async () => {
    dir = path.join(workdir, 'evil');
    await fs.mkdir(dir, { recursive: true });
  });

  /** A tar built byte by byte, so it can hold names a real tar would refuse. */
  function tarBlock({ name, size = 0, type = '0', linkname = '' }) {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8');
    header.write('0000644\0', 100, 8, 'ascii');
    header.write('0000000\0', 108, 8, 'ascii');
    header.write('0000000\0', 116, 8, 'ascii');
    header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
    header.write(`${(0).toString(8).padStart(11, '0')}\0`, 136, 12, 'ascii');
    header.write(type, 156, 1, 'ascii');
    header.write(linkname, 157, 100, 'utf8');
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    let sum = 0;
    for (let i = 0; i < 512; i += 1) sum += i >= 148 && i < 156 ? 0x20 : header[i];
    header.write(sum.toString(8).padStart(6, '0'), 148, 6, 'ascii');
    header[154] = 0;
    header[155] = 0x20;
    return header;
  }

  test('traversal, absolute paths, links and devices are all skipped', async () => {
    const body = Buffer.from('вийшло\n');
    const parts = [
      tarBlock({ name: '../../../../tmp/FSFM-ESCAPED.txt', size: body.length }), body, Buffer.alloc(512 - body.length),
      tarBlock({ name: '/etc/FSFM-ABSOLUTE.txt', size: body.length }), body, Buffer.alloc(512 - body.length),
      tarBlock({ name: 'evil-link', type: '2', linkname: '/etc/passwd' }),
      tarBlock({ name: 'evil-hard', type: '1', linkname: 'ok.txt' }),
      tarBlock({ name: 'device', type: '3' }),
      tarBlock({ name: 'ok.txt', size: body.length }), body, Buffer.alloc(512 - body.length),
      Buffer.alloc(512), Buffer.alloc(512),
    ];
    const file = path.join(dir, 'evil.tar');
    await fs.writeFile(file, Buffer.concat(parts));

    const out = path.join(dir, 'out-evil');
    await fs.rm(out, { recursive: true, force: true });
    await fs.mkdir(out);
    const result = await service.unpack({ absolute: file, name: 'evil.tar', destination: out });

    assert.equal(result.written, 1, 'лише безпечний запис має бути записано');
    assert.deepEqual(await fs.readdir(out), ['ok.txt']);

    const reasons = result.skipped.map((s) => s.reason).join(' | ');
    assert.match(reasons, /escapes the directory/);
    assert.match(reasons, /absolute path/);
    assert.match(reasons, /links are not extracted/);
    assert.match(reasons, /not a regular file/);

    // The decisive check: nothing appeared outside the destination.
    await assert.rejects(fs.stat('/tmp/FSFM-ESCAPED.txt'));
    await assert.rejects(fs.stat(path.join(dir, 'FSFM-ESCAPED.txt')));
  });

  test('a zip whose entries point outside is skipped the same way', async () => {
    const file = path.join(dir, 'evil.zip');
    await pipeline(
      createZipStream([
        { absolute: path.join(dir, 'evil.tar'), relative: '../../ESCAPED.txt', size: 1 },
        { absolute: path.join(dir, 'evil.tar'), relative: 'good.txt', size: 1 },
      ]),
      createWriteStream(file)
    );

    const out = path.join(dir, 'out-zip');
    await fs.rm(out, { recursive: true, force: true });
    await fs.mkdir(out);
    const result = await service.unpack({ absolute: file, name: 'evil.zip', destination: out });

    assert.deepEqual(await fs.readdir(out), ['good.txt']);
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0].reason, /escapes the directory/);
  });

  test('an oversized expansion is stopped at the budget', async () => {
    const bounded = new ArchiveService({ limits: { maxTotalBytes: 64 * 1024 } });
    await bounded.init({ tools: false });

    const big = path.join(dir, 'big.bin');
    await fs.writeFile(big, Buffer.alloc(512 * 1024, 0));
    const file = path.join(dir, 'bomb.zip');
    await pipeline(
      createZipStream([{ absolute: big, relative: 'bomb.bin', size: 512 * 1024 }]),
      createWriteStream(file)
    );

    const out = path.join(dir, 'out-bomb');
    await fs.rm(out, { recursive: true, force: true });
    await fs.mkdir(out);
    await assert.rejects(
      bounded.unpack({ absolute: file, name: 'bomb.zip', destination: out }),
      (err) => err.code === 'ARCHIVE_TOO_LARGE' && err.status === 413
    );
  });

  test('an empty archive is not an error, and never borrows another one’s', async () => {
    // A zip with no entries is valid. The failure this guards against was a
    // diagnostics field living on the service rather than the call: after one
    // archive that made libarchive complain, the *next* empty archive was
    // reported as unreadable, quoting a message about a file it never held.
    const noisy = path.join(dir, 'noisy.rar');
    await fs.writeFile(noisy, buildNoisyRar());

    const first = path.join(dir, 'out-noisy');
    await fs.rm(first, { recursive: true, force: true });
    await fs.mkdir(first);
    await service.unpack({ absolute: noisy, name: 'noisy.rar', destination: first }).catch(() => {});

    const empty = path.join(dir, 'empty.zip');
    await pipeline(createZipStream([]), createWriteStream(empty));

    const out = path.join(dir, 'out-empty');
    await fs.rm(out, { recursive: true, force: true });
    await fs.mkdir(out);
    const result = await service.unpack({ absolute: empty, name: 'empty.zip', destination: out });

    assert.equal(result.written, 0);
    assert.deepEqual(result.skipped, []);
    assert.deepEqual(await fs.readdir(out), []);
  });

  test('a file that is not an archive at all is refused', async () => {
    const file = path.join(dir, 'plain.txt');
    await fs.writeFile(file, 'просто текст\n');
    await assert.rejects(
      service.unpack({ absolute: file, name: 'plain.txt', destination: dir }),
      (err) => err.code === 'NOT_AN_ARCHIVE'
    );
  });
});

describe('archive: an archive never ends up inside itself', () => {
  let ops;
  let root;

  before(async () => {
    const { FsOps } = await import('../server/fs-ops.js');
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'fsfm-self-')));
    await fs.mkdir(path.join(root, 'Docs'));
    await fs.writeFile(path.join(root, 'Docs', 'a.txt'), 'a');
    await fs.writeFile(path.join(root, 'top.txt'), 'top');
    ops = new FsOps({ root });
    await ops.init();
  });
  after(() => fs.rm(root, { recursive: true, force: true }));

  test('packing a folder into itself excludes the archive being written', async () => {
    // The destination sits inside the tree being walked, so without an
    // exclusion the walk reaches the archive and stores it inside itself — at
    // whatever length it had reached by then.
    const created = await ops.createArchive(['/Docs'], { format: 'zip', destination: '/Docs' });
    const contents = await service.list(path.join(root, created.path), created.name);
    assert.ok(
      !contents.items.some((item) => item.name.split('/').pop() === created.name),
      `архів містить себе: ${contents.items.map((i) => i.name).join(', ')}`
    );
    assert.deepEqual(contents.items.map((i) => i.name).sort(), ['Docs/', 'Docs/a.txt']);
  });

  test('packing the whole root does the same', async () => {
    const created = await ops.createArchive(['/'], { format: 'zip', destination: '/', name: 'all.zip' });
    const contents = await service.list(path.join(root, created.path), created.name);
    assert.ok(!contents.items.some((item) => item.name.split('/').pop() === 'all.zip'));
  });

  test('a refused pack leaves no placeholder under the name it never filled', async () => {
    await assert.rejects(
      ops.createArchive(['/top.txt', '/Docs'], { format: 'gz', destination: '/', name: 'bad.gz' }),
      (err) => err.code === 'FORMAT_SINGLE_FILE'
    );
    // #reserveName creates the file to claim the name; a failure has to undo it.
    await assert.rejects(fs.stat(path.join(root, 'bad.gz')));
  });
});

describe('archive: capabilities are reported, not assumed', () => {
  test('zip and tar work with no external tools at all', async () => {
    const bare = new ArchiveService();
    await bare.init({ tools: false });
    const caps = bare.capabilities();

    // These two are implemented in this project outright.
    assert.equal(caps.zip.write, true);
    assert.equal(caps.tar.write, true);
    assert.equal(caps['tar.gz'].write, true, 'gzip надходить із zlib');
    assert.equal(caps.gz.write, true);

    // These need a program that was not looked for.
    assert.equal(caps.bz2.write, false);
    assert.equal(caps.xz.write, false);
    assert.equal(caps['7z'].write, false);
    assert.equal(caps.rar.read, false);
  });

  test('every format reports the extensions the widget matches on', () => {
    const caps = service.capabilities();
    assert.deepEqual(caps['tar.gz'].extensions, ['tar.gz', 'tgz']);
    assert.deepEqual(caps.zip.extensions, ['zip']);
  });
});
