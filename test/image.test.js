import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createFileManagerRouter } from '../server/router.js';
import {
  BROWSER_NATIVE,
  NEEDS_RENDER,
  RENDER_WIDTHS,
  VIEWABLE,
  loadSharp,
  probeHeifSupport,
  renderForView,
  viewCapabilities,
} from '../server/thumbnail.js';

/**
 * A 300x200 HEIC. Every other fixture is generated at run time; HEVC has no
 * free encoder available, so this one is carried as bytes.
 *
 * Its ordinary size matters: libheif rejects a minimal 2x2 HEIC under its own
 * security limit, which would make a working decoder look broken.
 */
const SAMPLE_HEIC = Buffer.from(
  'AAAAJGZ0eXBoZWljAAAAAG1pZjFNaVBybWlhZk1pSEJoZWljAAABwm1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAHBpY3QA' +
  'AAAAAAAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAAADnBpdG0AAAAAAAEAAAA4aWlu' +
  'ZgAAAAAAAgAAABVpbmZlAgAAAAABAABodmMxAAAAABVpbmZlAgAAAQACAABFeGlmAAAAABppcmVmAAAAAAAAAA5jZHNj' +
  'AAIAAQABAAAA5WlwcnAAAADEaXBjbwAAABNjb2xybmNseAACAAIABoAAAAAMY2xsaQDLAEAAAAAUaXNwZQAAAAAAAAEs' +
  'AAAAyAAAAAlpcm90AAAAABBwaXhpAAAAAAMICAgAAABwaHZjQwEDcAAAALAAAAAAADzwAPz9+PgAAAsDoAABABdAAQwB' +
  '//8DcAAAAwCwAAADAAADADxwJKEAAQAiQgEBA3AAAAMAsAAAAwAAAwA8oAmIDR3LiHuRZVNwICBgCKIAAQAJRAHAYXLI' +
  'QFMkAAAAGWlwbWEAAAAAAAAAAQABBoECAwWGhAAAACxpbG9jAAAAAEQAAAIAAQAAAAEAAAJCAAAAaQACAAAAAQAAAfYA' +
  'AABMAAAAAW1kYXQAAAAAAAAAxQAAAAZFeGlmAABNTQAqAAAACAADARoABQAAAAEAAAAyARsABQAAAAEAAAA6ASgAAwAA' +
  'AAEAAgAAAAAAAAAAABkAAAABAAAAGQAAAAEAAABlKAGvnLlikpRARoF8//ljH//Z3+y+eTj7Fv2elHskxrwGpJA+bcX8' +
  '44qL8r803ilgIrFiI+1inf2oBRQKr16i2EUAACHgAuHwigAAAwAlYAPSwAAAAwAM2AAAAwAAAwAAAwAAZUA=',
  'base64'
);

let server;
let base;
let root;

async function start(options = {}) {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'fsfm-img-')));
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

/** Write one test image in the given format, via sharp. */
async function writeImage(target, format) {
  const sharp = loadSharp();
  const base = sharp({
    create: { width: 240, height: 160, channels: 3, background: { r: 200, g: 80, b: 40 } },
  });
  const encoders = {
    png: (p) => p.png(),
    jpeg: (p) => p.jpeg(),
    webp: (p) => p.webp(),
    tiff: (p) => p.tiff(),
    avif: (p) => p.avif(),
    gif: (p) => p.gif(),
  };
  await encoders[format](base).toFile(target);
}

describe('images: the requested formats are all accounted for', () => {
  test('every format asked for is viewable, one way or the other', () => {
    for (const extension of [
      'jpeg', 'jpg', 'png', 'gif', 'webp', 'bmp', 'tiff', 'tif',
      'avif', 'heic', 'heif', 'ico', 'svg',
    ]) {
      assert.ok(VIEWABLE.has(extension), `${extension} має відкриватися`);
    }
  });

  test('each is classified by whether a browser can draw it', () => {
    // Checked in Chrome from data: URLs rather than assumed: these loaded and
    // reported their natural size.
    for (const extension of ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg']) {
      assert.ok(BROWSER_NATIVE.has(extension), `${extension} рисуется браузером`);
      assert.ok(!NEEDS_RENDER.has(extension));
    }
    // These did not.
    for (const extension of ['tif', 'tiff', 'heic', 'heif']) {
      assert.ok(NEEDS_RENDER.has(extension), `${extension} требует преобразования`);
      assert.ok(!BROWSER_NATIVE.has(extension));
    }
  });

  test('native formats are never re-encoded, so nothing is lost', () => {
    // The two sets must not overlap, or a JPEG would be converted to WebP
    // just to look at it.
    for (const extension of BROWSER_NATIVE) {
      assert.ok(!NEEDS_RENDER.has(extension), `${extension} не має перетворюватися`);
    }
  });
});

describe('images: HEIC support is probed, not assumed', () => {
  test('the probe decodes pixels rather than reading headers', async () => {
    const support = await probeHeifSupport();
    // libheif parses a HEIC container happily even with no HEVC decoder
    // behind it, so metadata() succeeds where an actual decode fails. If the
    // probe says yes, a real render has to work.
    if (support === false) {
      assert.ok(!viewCapabilities().render.includes('heic'), 'нельзя обещать то, чего нет');
      return;
    }

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'heic-'));
    const file = path.join(dir, 'tiny.heic');
    await fs.writeFile(file, SAMPLE_HEIC);
    try {
      const rendered = await renderForView(file, 'heic', { width: RENDER_WIDTHS[0] });
      assert.ok(rendered, 'проба обещала поддержку — рендер обязан получиться');
      assert.equal(rendered.contentType, 'image/webp');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('the capability report matches the probe', async () => {
    const support = await probeHeifSupport();
    const caps = viewCapabilities();
    assert.equal(caps.render.includes('heic'), Boolean(support) && Boolean(loadSharp()));
    assert.equal(caps.heif, support);
  });
});

describe('images: the render route', () => {
  before(async () => {
    await start();
    if (!loadSharp()) return;
    await writeImage(path.join(root, 'scan.tiff'), 'tiff');
    await writeImage(path.join(root, 'photo.png'), 'png');
    await fs.writeFile(path.join(root, 'phone.heic'), SAMPLE_HEIC);
    await fs.writeFile(path.join(root, 'old.bmp'), Buffer.alloc(64, 0));
    await fs.writeFile(path.join(root, 'notes.txt'), 'не картинка');
  });
  after(stop);

  test('a TIFF comes back as something a browser will draw', async (t) => {
    if (!loadSharp()) return t.skip('sharp не установлен');
    const response = await fetch(`${base}/render?path=/scan.tiff&width=1024`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/webp');
    // The original dimensions travel separately, so the viewer can report the
    // file rather than the rendition.
    assert.equal(response.headers.get('x-image-width'), '240');
    assert.equal(response.headers.get('x-image-height'), '160');
    assert.ok((await response.arrayBuffer()).byteLength > 0);
  });

  test('a HEIC does too, where the server can decode one', async (t) => {
    if (!(await probeHeifSupport())) return t.skip('HEVC не декодується на цій машині');
    const response = await fetch(`${base}/render?path=/phone.heic&width=1024`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/webp');
  });

  test('a browser-native format is refused, not needlessly converted', async (t) => {
    if (!loadSharp()) return t.skip('sharp не установлен');
    // .bmp and .svg the browser draws itself; sending them through a decoder
    // would cost CPU and lose fidelity for nothing.
    for (const target of ['/old.bmp']) {
      const response = await fetch(`${base}/render?path=${encodeURIComponent(target)}&width=1024`);
      assert.equal(response.status, 415, target);
      assert.equal((await response.json()).code, 'NO_RENDER');
    }
  });

  test('something that is not an image at all is refused', async () => {
    const response = await fetch(`${base}/render?path=/notes.txt&width=1024`);
    assert.equal(response.status, 415);
    assert.equal((await response.json()).code, 'NOT_VIEWABLE');
  });

  test('an unlisted width is refused rather than rendered on demand', async () => {
    const response = await fetch(`${base}/render?path=/scan.tiff&width=1337`);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'INVALID_SIZE');
  });

  test('an unchanged rendition answers 304', async (t) => {
    if (!loadSharp()) return t.skip('sharp не установлен');
    const first = await fetch(`${base}/render?path=/scan.tiff&width=1024`);
    const etag = first.headers.get('etag');
    await first.arrayBuffer();

    const again = await fetch(`${base}/render?path=/scan.tiff&width=1024`, {
      headers: { 'If-None-Match': etag },
    });
    assert.equal(again.status, 304);

    const wider = await fetch(`${base}/render?path=/scan.tiff&width=1600`, {
      headers: { 'If-None-Match': etag },
    });
    assert.equal(wider.status, 200, 'другая ширина — другое изображение');
  });

  test('it carries the same anti-sniffing headers as every other file route', async (t) => {
    if (!loadSharp()) return t.skip('sharp не установлен');
    const response = await fetch(`${base}/render?path=/scan.tiff&width=1024`);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
    await response.arrayBuffer();
  });

  test('a path outside the root is refused here too', async () => {
    const response = await fetch(`${base}/render?path=/../../etc/passwd&width=1024`);
    assert.equal(response.status, 400);
  });
});

describe('images: the route follows the download permission', () => {
  after(stop);

  test('withholding download withholds renditions with it', async () => {
    await start({ permissions: { download: false } });
    // A rendition is the file's pixels; serving it while /download is closed
    // would hand out exactly what was withheld.
    const response = await fetch(`${base}/render?path=/x.tiff&width=1024`);
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, 'PERMISSION_DENIED');
  });

  test('/config tells the widget what it may open', async () => {
    await stop();
    await start();
    const config = await (await fetch(`${base}/config`)).json();
    assert.ok(Array.isArray(config.imageView.native));
    assert.ok(config.imageView.native.includes('png'));
    assert.ok(config.imageView.native.includes('bmp'));
    assert.deepEqual(config.imageView.widths, RENDER_WIDTHS);
    // Only what this machine can genuinely convert is advertised.
    for (const extension of config.imageView.render) {
      assert.ok(NEEDS_RENDER.has(extension), `${extension} не нуждается в преобразовании`);
    }
  });
});

describe('images: many thumbnails at once are queued, not refused', () => {
  before(async () => {
    await start({ maxConcurrentThumbnails: 2 });
    if (!loadSharp()) return;
    for (let i = 0; i < 12; i += 1) {
      await writeImage(path.join(root, `img${i}.png`), 'png');
    }
  });
  after(stop);

  test('a grid of images all get their thumbnail', async (t) => {
    if (!loadSharp()) return t.skip('sharp не установлен');
    // A folder of photos fires every request at once. Refusing the overflow
    // left most tiles showing a generic icon with nothing to explain it.
    const responses = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        fetch(`${base}/thumbnail?path=/img${i}.png&size=128`)
      )
    );
    const statuses = responses.map((r) => r.status);
    await Promise.all(responses.map((r) => r.arrayBuffer()));

    assert.ok(!statuses.includes(503), `черга не має відмовляти: ${statuses.join(',')}`);
    assert.ok(statuses.every((s) => s === 200), statuses.join(','));
  });
});
