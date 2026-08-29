import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createFileManagerRouter } from '../server/router.js';
import { createTranslator } from '../src/core/i18n.js';
import { LOCALES } from '../src/locales/index.js';

let server;
let base;
let root;

/** Start the router on an ephemeral port over a throwaway directory. */
async function start(options = {}) {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'fsfm-http-')));
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

const get = (route) => fetch(`${base}${route}`);
const post = (route, body) =>
  fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('router: the eight toolbar operations over HTTP', () => {
  before(async () => {
    await start();
    await fs.mkdir(path.join(root, 'Docs'), { recursive: true });
    await fs.writeFile(path.join(root, 'Docs', 'readme.txt'), 'readme body');
  });
  after(stop);

  test('config advertises limits and write mode', async () => {
    const config = await (await get('/config')).json();
    assert.equal(config.readOnly, false);
    assert.ok(config.maxUploadSize > 0);
  });

  test('list returns the seeded tree', async () => {
    const listing = await (await get('/list?path=/Docs')).json();
    assert.deepEqual(listing.items.map((entry) => entry.name), ['readme.txt']);
  });

  test('1. create folder', async () => {
    const response = await post('/directory', { path: '/', name: 'Pictures' });
    assert.equal(response.status, 201);
    const entry = await response.json();
    assert.equal(entry.path, '/Pictures');
    assert.ok((await fs.stat(path.join(root, 'Pictures'))).isDirectory());
  });

  test('2. create file', async () => {
    const response = await post('/file', { path: '/Docs', name: 'notes.md', content: '# hi' });
    assert.equal(response.status, 201);
    assert.equal(await fs.readFile(path.join(root, 'Docs', 'notes.md'), 'utf8'), '# hi');
  });

  test('3. move', async () => {
    const response = await post('/move', { paths: ['/Docs/notes.md'], destination: '/Pictures' });
    assert.equal(response.status, 200);
    const [moved] = await response.json();
    assert.equal(moved.path, '/Pictures/notes.md');
    await assert.rejects(fs.stat(path.join(root, 'Docs', 'notes.md')));
  });

  test('4. copy', async () => {
    const response = await post('/copy', { paths: ['/Pictures/notes.md'], destination: '/Docs' });
    const [copied] = await response.json();
    assert.equal(copied.path, '/Docs/notes.md');
    // The source must survive a copy.
    assert.ok(await fs.stat(path.join(root, 'Pictures', 'notes.md')));
  });

  test('5. rename', async () => {
    const response = await post('/rename', { path: '/Docs/notes.md', name: 'renamed.md' });
    const entry = await response.json();
    assert.equal(entry.path, '/Docs/renamed.md');
  });

  test('6. delete', async () => {
    const response = await post('/delete', { paths: ['/Docs/renamed.md'] });
    const body = await response.json();
    assert.deepEqual(body.removed, ['/Docs/renamed.md']);
    await assert.rejects(fs.stat(path.join(root, 'Docs', 'renamed.md')));
  });

  test('7. download a single file streams it verbatim', async () => {
    const response = await get('/download?paths=/Docs/readme.txt');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-disposition'), /attachment/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(await response.text(), 'readme body');
  });

  test('7b. download a folder produces a zip', async () => {
    const response = await get('/download?paths=/Docs');
    assert.equal(response.headers.get('content-type'), 'application/zip');
    const buffer = Buffer.from(await response.arrayBuffer());
    // Local file header signature: "PK\x03\x04"
    assert.equal(buffer.subarray(0, 4).toString('hex'), '504b0304');
    assert.ok(buffer.includes(Buffer.from('readme.txt')));
  });

  test('7c. download of several paths produces one zip', async () => {
    const response = await get('/download?paths=/Docs/readme.txt&paths=/Pictures');
    assert.equal(response.headers.get('content-type'), 'application/zip');
    const buffer = Buffer.from(await response.arrayBuffer());
    assert.equal(buffer.subarray(0, 4).toString('hex'), '504b0304');
  });

  test('7d. range requests are honoured, so media can seek', async () => {
    const response = await fetch(`${base}/download?paths=/Docs/readme.txt`, {
      headers: { Range: 'bytes=0-5' },
    });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), 'bytes 0-5/11');
    assert.equal(await response.text(), 'readme');
  });

  test('8. upload writes the posted files', async () => {
    const form = new FormData();
    form.append('path', '/Pictures');
    form.append('files', new Blob(['uploaded body']), 'upload.txt');
    const response = await fetch(`${base}/upload?path=/Pictures`, { method: 'POST', body: form });
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.uploaded.length, 1);
    assert.equal(body.uploaded[0].path, '/Pictures/upload.txt');
    assert.equal(
      await fs.readFile(path.join(root, 'Pictures', 'upload.txt'), 'utf8'),
      'uploaded body'
    );
  });

  test('upload accepts several files at once', async () => {
    const form = new FormData();
    form.append('files', new Blob(['one']), 'a.txt');
    form.append('files', new Blob(['two']), 'b.txt');
    const response = await fetch(`${base}/upload?path=/Pictures`, { method: 'POST', body: form });
    const body = await response.json();
    assert.equal(body.uploaded.length, 2);
  });

  test('a non-ASCII upload filename survives the multipart round trip', async () => {
    const form = new FormData();
    form.append('files', new Blob(['вміст']), 'звіт за квартал.txt');
    const response = await fetch(`${base}/upload?path=/Pictures`, { method: 'POST', body: form });
    const body = await response.json();
    assert.equal(body.uploaded[0].name, 'звіт за квартал.txt');
    // The on-disk name must match too: a latin1 decode would store the UTF-8
    // bytes as mojibake and this readFile would fail.
    assert.equal(
      await fs.readFile(path.join(root, 'Pictures', 'звіт за квартал.txt'), 'utf8'),
      'вміст'
    );
  });

  test('a non-ASCII download filename is encoded per RFC 5987', async () => {
    const response = await get('/download?paths=' + encodeURIComponent('/Pictures/звіт за квартал.txt'));
    const disposition = response.headers.get('content-disposition');
    assert.match(disposition, /filename\*=UTF-8''/);
    assert.ok(disposition.includes(encodeURIComponent('звіт за квартал.txt')));
    assert.equal(await response.text(), 'вміст');
  });
});

describe('router: rejections', () => {
  before(async () => {
    await start();
    await fs.writeFile(path.join(root, 'a.txt'), 'a');
  });
  after(stop);

  test('traversal in a query path is refused', async () => {
    const response = await get('/list?path=/../../etc');
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'INVALID_PATH');
  });

  test('traversal in a create name is refused', async () => {
    const response = await post('/directory', { path: '/', name: '../escaped' });
    assert.equal(response.status, 400);
    const outside = path.resolve(root, '..', 'escaped');
    await assert.rejects(fs.stat(outside));
  });

  test('a missing path yields 404 with a code', async () => {
    const response = await get('/list?path=/nope');
    assert.equal(response.status, 404);
    assert.equal((await response.json()).code, 'NOT_FOUND');
  });

  test('an empty selection is refused rather than treated as "everything"', async () => {
    const response = await post('/delete', { paths: [] });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'NO_SELECTION');
  });

  test('server error messages never leak the absolute root', async () => {
    const response = await get('/list?path=/nope');
    assert.ok(!(await response.text()).includes(root));
  });

  test('a failure carries the values its message interpolated', async () => {
    // The server answers in English; a widget in another language rebuilds the
    // sentence from the code and these values, so they have to be there.
    const body = await (await get('/list?path=/nope')).json();
    assert.equal(body.code, 'NOT_FOUND');
    assert.deepEqual(body.params, { path: '/nope' });
    assert.equal(body.error, 'Not found: /nope');
  });

  test('what the server sent turns into a sentence in every language', async () => {
    const body = await (await get('/list?path=/nope')).json();
    for (const id of Object.keys(LOCALES)) {
      const t = createTranslator(LOCALES[id], LOCALES.en);
      const text = t(`srv.${body.code}`, body.params);
      assert.notEqual(text, `srv.${body.code}`, `${id} has no sentence for ${body.code}`);
      assert.ok(text.includes('/nope'), `${id} dropped the path: ${text}`);
    }
  });
});

describe('router: read-only mode', () => {
  before(async () => {
    await start({ readOnly: true });
    await fs.writeFile(path.join(root, 'a.txt'), 'a');
  });
  after(stop);

  test('config reports the mode', async () => {
    assert.equal((await (await get('/config')).json()).readOnly, true);
  });

  test('reads succeed', async () => {
    assert.equal((await get('/list?path=/')).status, 200);
    assert.equal((await get('/download?paths=/a.txt')).status, 200);
  });

  test('writes are refused with 403', async () => {
    for (const [route, body] of [
      ['/directory', { path: '/', name: 'x' }],
      ['/file', { path: '/', name: 'x.txt' }],
      ['/rename', { path: '/a.txt', name: 'b.txt' }],
      ['/move', { paths: ['/a.txt'], destination: '/' }],
      ['/copy', { paths: ['/a.txt'], destination: '/' }],
      ['/delete', { paths: ['/a.txt'] }],
    ]) {
      const response = await post(route, body);
      assert.equal(response.status, 403, `${route} should be refused`);
      assert.equal((await response.json()).code, 'READ_ONLY');
    }
  });

  test('upload is refused too', async () => {
    const form = new FormData();
    form.append('files', new Blob(['x']), 'x.txt');
    const response = await fetch(`${base}/upload?path=/`, { method: 'POST', body: form });
    assert.equal(response.status, 403);
  });
});

describe('router: per-operation permissions', () => {
  before(async () => {
    // Everything on except delete and upload.
    await start({ permissions: { remove: false, upload: false } });
    await fs.writeFile(path.join(root, 'a.txt'), 'a');
  });
  after(stop);

  test('config reports the resolved set, not the raw input', async () => {
    const config = await (await get('/config')).json();
    assert.equal(config.permissions.remove, false);
    assert.equal(config.permissions.upload, false);
    assert.equal(config.permissions.create, true);
    assert.equal(config.permissions.download, true);
    // Some writes remain, so this is not a read-only manager.
    assert.equal(config.readOnly, false);
  });

  test('withheld operations are refused', async () => {
    const response = await post('/delete', { paths: ['/a.txt'] });
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.equal(body.code, 'PERMISSION_DENIED');
    // The permission key travels, not its English name: only the key can be
    // looked up in another language.
    assert.deepEqual(body.params, { permission: 'remove' });
    assert.ok(await fs.stat(path.join(root, 'a.txt')), 'the file must survive');
  });

  test('a refused operation is named in every language', () => {
    for (const id of Object.keys(LOCALES)) {
      const t = createTranslator(LOCALES[id], LOCALES.en);
      const text = t('srv.PERMISSION_DENIED', { operation: t('op.remove') });
      assert.ok(text.includes(t('op.remove')), `${id} dropped the operation: ${text}`);
    }
  });

  test('upload is refused before the body is parsed', async () => {
    const form = new FormData();
    form.append('files', new Blob(['x']), 'x.txt');
    const response = await fetch(`${base}/upload?path=/`, { method: 'POST', body: form });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, 'PERMISSION_DENIED');
  });

  test('granted operations still work', async () => {
    assert.equal((await post('/directory', { path: '/', name: 'ok' })).status, 201);
    assert.equal((await post('/rename', { path: '/a.txt', name: 'b.txt' })).status, 200);
    assert.equal((await get('/download?paths=/b.txt')).status, 200);
  });

  test('withholding download blocks it while reads still work', async () => {
    await stop();
    await start({ permissions: { download: false } });
    await fs.writeFile(path.join(root, 'a.txt'), 'a');

    assert.equal((await get('/list?path=/')).status, 200);
    const response = await get('/download?paths=/a.txt');
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, 'PERMISSION_DENIED');
  });

  test('withholding every write is equivalent to readOnly', async () => {
    await stop();
    await start({
      permissions: { create: false, upload: false, move: false, copy: false, rename: false, remove: false },
    });
    const config = await (await get('/config')).json();
    assert.equal(config.readOnly, true, 'readOnly must be derived from the permission set');
    assert.equal(config.permissions.download, true, 'download is not a write');
  });

  test('readOnly cannot be widened by a permissive permission set', async () => {
    await stop();
    await start({ readOnly: true, permissions: { remove: true, create: true } });
    const config = await (await get('/config')).json();
    assert.equal(config.readOnly, true);
    assert.equal(config.permissions.remove, false);
    assert.equal(config.permissions.create, false);
  });
});

describe('router: authorize hook', () => {
  before(async () => {
    await start({
      authorize: (req) => !req.path.startsWith('/delete'),
    });
    await fs.writeFile(path.join(root, 'a.txt'), 'a');
  });
  after(stop);

  test('permitted routes pass through', async () => {
    assert.equal((await get('/list?path=/')).status, 200);
  });

  test('denied routes get 403 before touching the filesystem', async () => {
    const response = await post('/delete', { paths: ['/a.txt'] });
    assert.equal(response.status, 403);
    assert.ok(await fs.stat(path.join(root, 'a.txt')), 'the file must still exist');
  });
});
