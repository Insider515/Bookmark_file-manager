import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { createFileManagerRouter } from '../server/router.js';
import { RASTER_THUMBNAIL, RAW_THUMBNAIL, THUMBNAILABLE, canThumbnail, loadSharp } from '../server/thumbnail.js';

let server;
let base;
let root;

async function start(options = {}) {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'fsfm-thumb-')));
  const app = express();
  app.use('/api/files', createFileManagerRouter({ root, ...options }));
  server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  base = `http://127.0.0.1:${server.address().port}/api/files`;
}

async function stop() {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}

/** A real PNG, built here so the fixture needs no binary in the repo. */
function makePng(width, height) {
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(width * 3 + 1);
    for (let x = 0; x < width; x += 1) {
      row[1 + x * 3] = (x * 255) / Math.max(1, width - 1);
      row[2 + x * 3] = (y * 255) / Math.max(1, height - 1);
      row[3 + x * 3] = 160;
    }
    rows.push(row);
  }
  const chunk = (tag, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(tag, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A 16×16 32-bit icon, the one format libvips will not decode. */
function makeIco() {
  const size = 16;
  const pixels = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i += 1) {
    pixels.set([200, 120, 60, 255], i * 4);
  }
  const mask = Buffer.alloc((size * size) / 8);
  const dib = Buffer.alloc(40);
  dib.writeUInt32LE(40, 0);
  dib.writeInt32LE(size, 4);
  dib.writeInt32LE(size * 2, 8);
  dib.writeUInt16LE(1, 12);
  dib.writeUInt16LE(32, 14);
  dib.writeUInt32LE(pixels.length + mask.length, 20);
  const image = Buffer.concat([dib, pixels, mask]);

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry[0] = size;
  entry[1] = size;
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(image.length, 8);
  entry.writeUInt32LE(22, 12);
  return Buffer.concat([header, entry, image]);
}

describe('thumbnails: which formats are claimed', () => {
  test('the requested set is covered', () => {
    for (const extension of ['jpg', 'jpeg', 'png', 'webp', 'ico']) {
      assert.ok(canThumbnail(extension), `${extension} должен строить миниатюру`);
    }
  });

  test('pdf is deliberately excluded', () => {
    // Rasterising a PDF needs an engine the server does not carry; PDFs are
    // previewed full-size in the viewer instead of shown as a tile.
    assert.equal(canThumbnail('pdf'), false);
  });

  test('ico is pass-through, not re-encoded', () => {
    assert.ok(RAW_THUMBNAIL.has('ico'), 'libvips cannot decode .ico');
    assert.ok(!RASTER_THUMBNAIL.has('ico'));
    assert.ok(THUMBNAILABLE.has('ico'));
  });
});

describe('thumbnails: the endpoint', () => {
  before(async () => {
    await start();
    await fs.writeFile(path.join(root, 'big.png'), makePng(1200, 900));
    await fs.writeFile(path.join(root, 'small.png'), makePng(32, 32));
    await fs.writeFile(path.join(root, 'icon.ico'), makeIco());
    await fs.writeFile(path.join(root, 'notes.txt'), 'not an image');
    await fs.mkdir(path.join(root, 'folder'));
  });
  after(stop);

  test('a large image comes back far smaller than the original', async (t) => {
    if (!loadSharp()) return t.skip('sharp не установлен');
    const original = (await fs.stat(path.join(root, 'big.png'))).size;
    const response = await fetch(`${base}/thumbnail?path=/big.png&size=128`);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/webp');
    const bytes = (await response.arrayBuffer()).byteLength;
    assert.ok(bytes < original / 10, `миниатюра ${bytes} Б против оригинала ${original} Б`);
  });

  test('the thumbnail is a valid image of the requested bound', async (t) => {
    const sharp = loadSharp();
    if (!sharp) return t.skip('sharp не установлен');
    const buffer = Buffer.from(
      await (await fetch(`${base}/thumbnail?path=/big.png&size=128`)).arrayBuffer()
    );
    const meta = await sharp(buffer).metadata();
    assert.equal(meta.format, 'webp');
    assert.ok(meta.width <= 128 && meta.height <= 128, `${meta.width}×${meta.height}`);
    // 1200×900 scaled to fit a 128 box keeps its 4:3 ratio.
    assert.equal(meta.width, 128);
    assert.equal(meta.height, 96);
  });

  test('a small image is not enlarged', async (t) => {
    const sharp = loadSharp();
    if (!sharp) return t.skip('sharp не установлен');
    const buffer = Buffer.from(
      await (await fetch(`${base}/thumbnail?path=/small.png&size=256`)).arrayBuffer()
    );
    const meta = await sharp(buffer).metadata();
    assert.equal(meta.width, 32, 'upscaling a 32px source would only blur it');
  });

  test('an .ico is streamed as itself, since libvips cannot read it', async () => {
    const response = await fetch(`${base}/thumbnail?path=/icon.ico&size=128`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/vnd.microsoft.icon');
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.readUInt16LE(2), 1, 'ICO type field survives intact');
  });

  test('a format with no thumbnail is refused, not guessed at', async () => {
    for (const target of ['/notes.txt', '/folder']) {
      const response = await fetch(`${base}/thumbnail?path=${encodeURIComponent(target)}&size=128`);
      assert.ok(response.status >= 400, `${target} -> ${response.status}`);
    }
  });

  test('an unlisted size is refused rather than rendered on demand', async () => {
    const response = await fetch(`${base}/thumbnail?path=/big.png&size=133`);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'INVALID_SIZE');
  });

  test('an unchanged thumbnail answers 304, and each size has its own tag', async () => {
    const first = await fetch(`${base}/thumbnail?path=/big.png&size=128`);
    const etag = first.headers.get('etag');
    await first.arrayBuffer();
    assert.ok(etag);

    const repeat = await fetch(`${base}/thumbnail?path=/big.png&size=128`, {
      headers: { 'If-None-Match': etag },
    });
    assert.equal(repeat.status, 304);

    const other = await fetch(`${base}/thumbnail?path=/big.png&size=64`, {
      headers: { 'If-None-Match': etag },
    });
    assert.equal(other.status, 200, 'a different size is a different image');
  });

  test('a replaced file invalidates the thumbnail', async () => {
    const first = await fetch(`${base}/thumbnail?path=/small.png&size=64`);
    const etag = first.headers.get('etag');
    await first.arrayBuffer();

    await fs.writeFile(path.join(root, 'small.png'), makePng(48, 48));
    const after = await fetch(`${base}/thumbnail?path=/small.png&size=64`, {
      headers: { 'If-None-Match': etag },
    });
    assert.equal(after.status, 200);
  });

  test('thumbnails carry the same anti-sniffing headers as downloads', async () => {
    const response = await fetch(`${base}/thumbnail?path=/icon.ico&size=128`);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
    await response.arrayBuffer();
  });

  test('a path outside the root is refused here too', async () => {
    const response = await fetch(`${base}/thumbnail?path=/../../etc/passwd&size=128`);
    assert.equal(response.status, 400);
  });
});

describe('thumbnails: permissions and switches', () => {
  after(stop);

  test('withholding download withholds thumbnails with it', async () => {
    await start({ permissions: { download: false } });
    await fs.writeFile(path.join(root, 'a.png'), makePng(64, 64));

    // A thumbnail is the file's content at a smaller size; letting it through
    // while /download is closed would hand out what was just withheld.
    const response = await fetch(`${base}/thumbnail?path=/a.png&size=128`);
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, 'PERMISSION_DENIED');
  });

  test('thumbnails: false turns the route off and /config says so', async () => {
    await stop();
    await start({ thumbnails: false });
    await fs.writeFile(path.join(root, 'a.png'), makePng(64, 64));

    assert.equal((await (await fetch(`${base}/config`)).json()).thumbnails, false);
    assert.equal((await fetch(`${base}/thumbnail?path=/a.png&size=128`)).status, 404);
  });

  test('/config advertises the sizes the server will actually serve', async () => {
    await stop();
    await start({ thumbnailSizes: [96] });
    await fs.writeFile(path.join(root, 'a.png'), makePng(64, 64));

    const config = await (await fetch(`${base}/config`)).json();
    assert.deepEqual(config.thumbnailSizes, [96]);
    assert.equal((await fetch(`${base}/thumbnail?path=/a.png&size=96`)).status, 200);
    assert.equal((await fetch(`${base}/thumbnail?path=/a.png&size=128`)).status, 400);
  });
});
