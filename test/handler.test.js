import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createFileManagerHandler, createFileManagerRouter } from '../server/router.js';
import { parseQuery, parseSize } from '../server/http.js';

/**
 * The point of this file: the handler must work with nothing but node's own
 * request and response objects. Every other server test mounts it in Express,
 * which would hide a dependency on Express having been there.
 */
let server;
let base;
let root;

async function start(options = {}) {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'fsfm-bare-')));
  const handler = createFileManagerHandler({ root, basePath: '/api/files', ...options });
  server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}/api/files`;
  return handler;
}

async function stop() {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}

const get = (route) => fetch(`${base}${route}`);
const post = (route, body) =>
  fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('handler: works on bare node:http, with no framework', () => {
  before(async () => {
    await start();
    await fs.writeFile(path.join(root, 'a.txt'), 'hello');
    await fs.mkdir(path.join(root, 'docs'));
  });
  after(stop);

  test('reads a listing', async () => {
    const body = await (await get('/list?path=/')).json();
    assert.deepEqual(body.items.map((item) => item.name).sort(), ['a.txt', 'docs']);
  });

  test('writes through a POST body', async () => {
    const response = await post('/directory', { path: '/', name: 'Reports' });
    assert.equal(response.status, 201);
    assert.ok((await fs.stat(path.join(root, 'Reports'))).isDirectory());
  });

  test('streams a file back', async () => {
    const response = await get('/download?paths=/a.txt');
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'hello');
  });

  test('a repeated query key arrives as a list', async () => {
    await fs.writeFile(path.join(root, 'b.txt'), 'b');
    const response = await get('/download?paths=/a.txt&paths=/b.txt');
    assert.equal(response.status, 200);
    // Two files come back as an archive rather than as one of them.
    assert.match(response.headers.get('content-type') ?? '', /zip/);
  });

  test('still refuses a path that leaves the root', async () => {
    const response = await get('/list?path=/../../etc');
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'INVALID_PATH');
  });

  test('an unknown route is a 404 with a code, not a hang', async () => {
    const response = await get('/no-such-route');
    assert.equal(response.status, 404);
    assert.equal((await response.json()).code, 'NOT_FOUND');
  });

  test('the mount prefix is stripped by basePath', async () => {
    // Without the stripping the pathname would be /api/files/list and match
    // nothing at all.
    assert.equal((await get('/list?path=/')).status, 200);
  });

  test('a malformed JSON body is refused, not crashed on', async () => {
    const response = await fetch(`${base}/directory`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ this is not json',
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'INVALID_JSON');
  });
});

describe('handler: body size limits are per route', () => {
  before(async () => {
    await start();
  });
  after(stop);

  /** A workbook of roughly `mb` megabytes once serialised. */
  const workbook = (mb, name = 'big.csv') => {
    const rows = [];
    const cell = 'x'.repeat(30);
    for (let i = 0; i < Math.round(mb * 10400); i += 1) {
      rows.push([{ type: 'string', value: cell, text: cell }]);
    }
    // Each case writes to its own name: asserting "nothing was written" is
    // worthless if an earlier test in this block already created the file.
    return { path: `/${name}`, workbook: { sheets: [{ name: 'S', rows }] } };
  };

  test('a save over 1 MB goes through', async () => {
    // The regression this guards: a single global 1 MB limit used to parse
    // first and reject with 413, so no spreadsheet or document larger than
    // that could ever be saved, whatever the route allowed.
    const body = workbook(3);
    const response = await post('/sheet/save', body);
    assert.equal(response.status, 200, await response.text());
  });

  test('a save past the route limit is still refused', async () => {
    const response = await post('/sheet/save', workbook(20, 'over.csv'));
    assert.equal(response.status, 413);
    assert.equal((await response.json()).code, 'TOO_LARGE');
  });

  test('an ordinary route keeps the small limit', async () => {
    const response = await post('/directory', { path: '/', name: 'x'.repeat(2 * 1024 * 1024) });
    assert.equal(response.status, 413);
  });

  test('a streamed body is refused too, and writes nothing', async () => {
    // A streamed body may arrive without a Content-Length, so the size can
    // only be counted as it comes in. Whether the client then reads a 413 or
    // sees the connection cut depends on how far past the limit it went — past
    // the point where draining it would itself be the attack, it is cut off.
    // Either way is a refusal, and that is what is asserted: pinning it to one
    // of the two would be testing undici's buffering, not this code.
    const payload = JSON.stringify(workbook(24, 'streamed.csv'));
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(payload));
        controller.close();
      },
    });
    let status = 0;
    try {
      const response = await fetch(`${base}/sheet/save`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: stream,
        duplex: 'half',
      });
      status = response.status;
      await response.text();
    } catch {
      status = 0; // the connection was cut, which is also a refusal
    }
    assert.notEqual(status, 200, 'an oversized body must never be accepted');
    // The decisive check: refused means nothing reached the disk.
    await assert.rejects(fs.stat(path.join(root, 'streamed.csv')));
  });

  test('an oversized body that declares its length gets a real 413', async () => {
    // The ordinary case: every normal client sends Content-Length, so the
    // refusal happens before a byte of the body is read and the client is
    // told why.
    const response = await post('/sheet/save', workbook(24, 'declared.csv'));
    assert.equal(response.status, 413);
    assert.equal((await response.json()).code, 'TOO_LARGE');
    await assert.rejects(fs.stat(path.join(root, 'declared.csv')));
  });
});

describe('handler: createFileManagerRouter is the same function', () => {
  test('the old name still resolves to the handler', () => {
    assert.equal(createFileManagerRouter, createFileManagerHandler);
  });
});

describe('http helpers', () => {
  test('parseSize understands the units the options use', () => {
    assert.equal(parseSize('1mb'), 1024 * 1024);
    assert.equal(parseSize('16mb'), 16 * 1024 * 1024);
    assert.equal(parseSize('512kb'), 512 * 1024);
    assert.equal(parseSize(2048), 2048);
    assert.equal(parseSize('nonsense', 99), 99);
  });

  test('parseQuery keeps a single value a string and a repeated one a list', () => {
    const query = parseQuery(new URLSearchParams('path=/a&paths=/b&paths=/c'));
    assert.equal(query.path, '/a');
    assert.deepEqual(query.paths, ['/b', '/c']);
  });

  test('parseQuery has no prototype, so ?__proto__= cannot reach Object', () => {
    const query = parseQuery(new URLSearchParams('__proto__[polluted]=yes'));
    assert.equal(Object.getPrototypeOf(query), null);
    assert.equal({}.polluted, undefined);
  });
});
