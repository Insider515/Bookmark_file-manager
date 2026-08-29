import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { createFileManagerRouter } from '../server/router.js';
import { FsOps, TEMP_UPLOAD_PREFIX } from '../server/fs-ops.js';

let server;
let base;
let root;
let router;

async function start(options = {}) {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'fsfm-sec-')));
  const app = express();
  router = createFileManagerRouter({ root, ...options });
  app.use('/api/files', router);
  server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  base = `http://127.0.0.1:${server.address().port}/api/files`;
  return router;
}

async function stop() {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}

/** A multipart upload, optionally with a forged Origin or an extra path field. */
function uploadForm({ query = '', headers = {}, fields = {}, filename = 'x.txt', body = 'x' }) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  form.append('files', new Blob([body]), filename);
  return fetch(`${base}/upload${query}`, { method: 'POST', body: form, headers });
}

describe('security: cross-origin requests', () => {
  before(() => start());
  after(stop);

  test('a multipart upload from a foreign origin is refused', async () => {
    // multipart/form-data is a CORS "simple request": no preflight protects
    // this route, so the router has to reject it itself.
    const response = await uploadForm({
      query: '?path=/',
      headers: { Origin: 'https://evil.example' },
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, 'CROSS_ORIGIN');
    assert.deepEqual(await fs.readdir(root), [], 'nothing may have been written');
  });

  test('Sec-Fetch-Site: cross-site is refused even without an Origin', async () => {
    const response = await uploadForm({
      query: '?path=/',
      headers: { 'Sec-Fetch-Site': 'cross-site' },
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, 'CROSS_ORIGIN');
  });

  test('an Origin matching the request host is accepted', async () => {
    const origin = new URL(base).origin;
    const response = await uploadForm({ query: '?path=/', headers: { Origin: origin } });
    assert.equal(response.status, 201);
  });

  test('a request with no Origin at all still works, for non-browser clients', async () => {
    const response = await uploadForm({ query: '?path=/', filename: 'curl.txt' });
    assert.equal(response.status, 201);
  });

  test('reads are never blocked by the origin check', async () => {
    const response = await fetch(`${base}/list?path=/`, { headers: { Origin: 'https://evil.example' } });
    assert.equal(response.status, 200);
  });

  test('an explicit allow-list admits exactly the origins it names', async () => {
    await stop();
    await start({ allowedOrigins: ['https://dashboard.example'] });

    assert.equal(
      (await uploadForm({ query: '?path=/', headers: { Origin: 'https://dashboard.example' } })).status,
      201
    );
    assert.equal(
      (await uploadForm({ query: '?path=/', headers: { Origin: 'https://other.example' } })).status,
      403
    );
  });
});

describe('security: the authorize hook', () => {
  const seen = [];

  before(async () => {
    await start({
      authorize: (req, action, context) => {
        seen.push({ action, ...context });
        // Only /public is writable, whatever route asks.
        const targets = [...context.paths, context.destination].filter(Boolean);
        return targets.every((target) => target === '/' || target.startsWith('/public'));
      },
    });
    await fs.mkdir(path.join(root, 'public'));
    await fs.mkdir(path.join(root, 'private'));
    await fs.writeFile(path.join(root, 'private', 'secret.txt'), 'secret');
  });
  after(stop);

  test('the hook is told which entries an operation touches', async () => {
    seen.length = 0;
    await fetch(`${base}/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: ['/private/secret.txt'] }),
    });
    const call = seen.find((entry) => entry.route === '/delete');
    assert.deepEqual(call.paths, ['/private/secret.txt']);
    assert.equal(call.action, 'POST /delete');
  });

  test('a per-path decision is actually enforced', async () => {
    const response = await fetch(`${base}/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: ['/private/secret.txt'] }),
    });
    assert.equal(response.status, 403);
    assert.ok(await fs.stat(path.join(root, 'private', 'secret.txt')), 'the file must survive');
  });

  test('the hook sees a move destination, not just its sources', async () => {
    seen.length = 0;
    await fetch(`${base}/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: ['/public/a.txt'], destination: '/private' }),
    });
    const call = seen.find((entry) => entry.route === '/move');
    assert.equal(call.destination, '/private');
  });

  test('an upload cannot smuggle its destination past the hook in a form field', async () => {
    // The query says /public, which the hook allows; the field then redirects
    // the write to /private, which it does not. The upload must not land.
    const response = await uploadForm({
      query: '?path=/public',
      fields: { path: '/private' },
      filename: 'smuggled.txt',
      body: 'payload',
    });
    const body = await response.json();

    assert.equal(body.uploaded.length, 0, 'nothing may have been accepted');
    await assert.rejects(
      fs.stat(path.join(root, 'private', 'smuggled.txt')),
      'the file must not exist in the forbidden directory'
    );
    await assert.rejects(
      fs.stat(path.join(root, 'public', 'smuggled.txt')),
      'and must not have silently gone to the allowed one either'
    );
  });

  test('an upload to a permitted destination still works', async () => {
    const response = await uploadForm({
      query: '?path=/public',
      filename: 'fine.txt',
      body: 'ok',
    });
    assert.equal(response.status, 201);
    assert.equal(await fs.readFile(path.join(root, 'public', 'fine.txt'), 'utf8'), 'ok');
  });
});

describe('security: a path field arriving after the files is refused', () => {
  before(() => start());
  after(stop);

  test('the files stay in the destination the request opened with', async () => {
    await fs.mkdir(path.join(root, 'early'));
    await fs.mkdir(path.join(root, 'late'));

    // FormData preserves insertion order, so appending the field last puts it
    // after the file part on the wire.
    const form = new FormData();
    form.append('files', new Blob(['body']), 'ordered.txt');
    form.append('path', '/late');
    const response = await fetch(`${base}/upload?path=/early`, { method: 'POST', body: form });
    const body = await response.json();

    assert.equal(body.uploaded[0].path, '/early/ordered.txt');
    await assert.rejects(fs.stat(path.join(root, 'late', 'ordered.txt')));
    assert.ok(
      body.failures.some((failure) => /must come before the files/.test(failure.message)),
      'the client is told why the field was ignored'
    );
  });
});

describe('security: copy cannot import content from outside the root', () => {
  let ops;
  let outside;

  before(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'fsfm-link-')));
    outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'fsfm-out-')));
    await fs.writeFile(path.join(outside, 'secret.txt'), 'SECRET');
    await fs.mkdir(path.join(root, 'dir'));
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(root, 'dir', 'link.txt'));
    ops = new FsOps({ root });
    await ops.init();
  });
  after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  test('the escaping link is hidden from the listing', async () => {
    assert.deepEqual((await ops.list('/dir')).items, []);
  });

  test('copying its parent does not materialise the external file inside the root', async () => {
    const skipped = [];
    await ops.copy(['/dir'], '/', { onSkip: (info) => skipped.push(info) });

    assert.deepEqual((await ops.list('/dir (2)')).items, [], 'the copy must be empty');
    await assert.rejects(
      fs.stat(path.join(root, 'dir (2)', 'link.txt')),
      'no file may have been created from the out-of-root target'
    );
    assert.deepEqual(skipped, [{ reason: 'OUTSIDE_ROOT', name: 'link.txt' }]);
  });

  test('a link pointing back at the root terminates instead of recursing', async () => {
    await fs.symlink(root, path.join(root, 'dir', 'loop'));
    // Finishing at all is the assertion; an unguarded walk never returns.
    await ops.copy(['/dir'], '/', { overwrite: false });
    assert.ok(await fs.stat(path.join(root, 'dir (3)')));
  });
});

describe('security: error messages and disclosure', () => {
  before(() => start());
  after(stop);

  test('an upload failure never carries the absolute server path', async () => {
    // Node errors that FsOps has no mapping for keep their raw message, and a
    // raw fs message embeds the absolute path it failed on. Forcing one is the
    // only deterministic way to exercise the branch that has to mask it —
    // which real filesystems reach through ENAMETOOLONG, EIO, EDQUOT and the
    // rest of the long tail.
    const original = router.fsOps.writeUpload;
    router.fsOps.writeUpload = async () => {
      throw Object.assign(new Error(`EIO: i/o error, open '${root}/doomed.txt'`), { code: 'EIO' });
    };
    try {
      const response = await uploadForm({ query: '?path=/', filename: 'doomed.txt', body: 'x' });
      const text = await response.text();

      assert.equal(response.status, 400);
      assert.ok(!text.includes(root), `absolute root leaked: ${text}`);
      assert.ok(!text.includes(os.tmpdir()), 'temp directory leaked');
      assert.match(text, /Could not save the file/, 'the client gets a usable message instead');
    } finally {
      router.fsOps.writeUpload = original;
    }
  });

  test('an unmapped error on a JSON route becomes a plain 500', async () => {
    const original = router.fsOps.list;
    router.fsOps.list = async () => {
      throw Object.assign(new Error(`EIO: i/o error, scandir '${root}'`), { code: 'EIO' });
    };
    try {
      const response = await fetch(`${base}/list?path=/`);
      const text = await response.text();
      assert.equal(response.status, 500);
      assert.ok(!text.includes(root), `absolute root leaked: ${text}`);
    } finally {
      router.fsOps.list = original;
    }
  });

  test('/config withholds filesystem usage unless asked for it', async () => {
    assert.equal((await (await fetch(`${base}/config`)).json()).usage, null);

    await stop();
    await start({ exposeUsage: true });
    const usage = (await (await fetch(`${base}/config`)).json()).usage;
    assert.ok(usage && usage.total > 0, 'opting in still reports it');
  });
});

describe('efficiency: conditional requests and caps', () => {
  before(async () => {
    await start({ maxBatchPaths: 3 });
    await fs.writeFile(path.join(root, 'a.txt'), 'body');
  });
  after(stop);

  test('an unchanged file answers 304 to its own ETag', async () => {
    const first = await fetch(`${base}/download?paths=/a.txt`);
    const etag = first.headers.get('etag');
    assert.ok(etag, 'an ETag is issued');
    await first.arrayBuffer();

    const second = await fetch(`${base}/download?paths=/a.txt`, {
      headers: { 'If-None-Match': etag },
    });
    assert.equal(second.status, 304);
    assert.equal((await second.arrayBuffer()).byteLength, 0, 'no body is re-sent');
  });

  test('a changed file invalidates the ETag', async () => {
    const first = await fetch(`${base}/download?paths=/a.txt`);
    const etag = first.headers.get('etag');
    await first.arrayBuffer();

    await fs.writeFile(path.join(root, 'a.txt'), 'a longer body than before');
    const second = await fetch(`${base}/download?paths=/a.txt`, {
      headers: { 'If-None-Match': etag },
    });
    assert.equal(second.status, 200);
    assert.equal(await second.text(), 'a longer body than before');
  });

  test('an oversized download selection is refused rather than walked', async () => {
    const query = ['/a.txt', '/a.txt', '/a.txt', '/a.txt']
      .map((item) => `paths=${encodeURIComponent(item)}`)
      .join('&');
    const response = await fetch(`${base}/download?${query}`);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'TOO_MANY');
  });
});

describe('uploads: temp files and concurrent name claims', () => {
  let ops;

  before(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'fsfm-up-')));
    ops = new FsOps({ root });
    await ops.init();
  });
  after(() => fs.rm(root, { recursive: true, force: true }));

  test('two uploads racing for one name produce two files, not one', async () => {
    const [first, second] = await Promise.all([
      ops.writeUpload('/', 'same.txt', Readable.from([Buffer.from('first')])),
      ops.writeUpload('/', 'same.txt', Readable.from([Buffer.from('second')])),
    ]);
    assert.notEqual(first.path, second.path, 'the two uploads must not share a name');

    const bodies = await Promise.all(
      [first, second].map((entry) => fs.readFile(path.join(root, entry.name), 'utf8'))
    );
    assert.deepEqual(bodies.sort(), ['first', 'second'], 'neither upload was overwritten');
  });

  test('an upload in flight is not listed as a file', async () => {
    // Stand in for a slow upload by leaving a scratch file with the real prefix.
    await fs.writeFile(path.join(root, `${TEMP_UPLOAD_PREFIX}deadbeef`), 'partial');
    const names = (await ops.list('/')).items.map((entry) => entry.name);
    assert.ok(
      names.every((name) => !name.startsWith(TEMP_UPLOAD_PREFIX)),
      `temp upload surfaced in the listing: ${names.join(', ')}`
    );
  });

  test('a client cannot post a file named like the internal temp prefix', async () => {
    await assert.rejects(
      ops.writeUpload('/', `${TEMP_UPLOAD_PREFIX}sneaky`, Readable.from([Buffer.from('x')])),
      (err) => err.code === 'INVALID_NAME'
    );
  });
});
