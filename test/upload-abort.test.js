import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

import { createFileManagerHandler } from '../server/router.js';
import { createRouter } from '../server/http.js';
import { TEMP_UPLOAD_PREFIX } from '../server/fs-ops.js';

let server;
let base;
let root;

before(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'fsfm-abort-')));
  server = http.createServer(createFileManagerHandler({ root }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  server.close();
  await once(server, 'close');
  await fs.rm(root, { recursive: true, force: true });
});

const listing = async () => (await fs.readdir(root)).sort();
const temps = async () => (await listing()).filter((n) => n.startsWith(TEMP_UPLOAD_PREFIX));

/**
 * Start an upload and cut the connection part-way through the file, the way a
 * closed tab, a cancelled upload or a lost signal does.
 */
async function abortMidUpload({ name = 'report.pdf', bytes = 256 * 1024, afterMs = 60 } = {}) {
  const boundary = '----abort';
  const controller = new AbortController();
  const body = new ReadableStream({
    start(c) {
      c.enqueue(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${name}"\r\n` +
        'Content-Type: application/pdf\r\n\r\n'
      ));
      c.enqueue(Buffer.alloc(bytes, 0x41));
      // No closing boundary is ever sent: the request simply stops.
      setTimeout(() => controller.abort(), afterMs);
    },
  });

  await fetch(`${base}/upload?path=/`, {
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    body,
    duplex: 'half',
    signal: controller.signal,
  }).catch(() => {});

  await new Promise((resolve) => setTimeout(resolve, 300));
}

describe('an upload that dies part-way through', () => {
  test('leaves neither a temp file nor an empty file under the real name', async () => {
    await abortMidUpload();

    // The destination name is claimed up front, so an upload that is never
    // finished used to leave a zero-byte `report.pdf` in the user's folder —
    // visible in the manager, alongside the hidden temp copy.
    assert.deepEqual(await temps(), [], 'a temp file was abandoned');
    assert.deepEqual(await listing(), [], 'an empty placeholder was left behind');
  });

  test('is still clean after several of them', async () => {
    for (let i = 0; i < 4; i += 1) await abortMidUpload({ afterMs: 30 + i * 15 });
    assert.deepEqual(await listing(), [],
      'cancelling repeatedly fills the folder with empty files');
  });

  test('does not stop the next upload from working', async () => {
    await abortMidUpload();

    const form = new FormData();
    form.append('files', new Blob(['real content']), 'after.txt');
    const response = await fetch(`${base}/upload?path=/`, { method: 'POST', body: form });
    const answer = await response.json();

    assert.equal(response.status, 201);
    assert.deepEqual(answer.uploaded.map((u) => u.name), ['after.txt']);
    assert.deepEqual(await temps(), []);
    assert.deepEqual(await listing(), ['after.txt']);

    await fs.rm(path.join(root, 'after.txt'), { force: true });
  });
});

describe('an error handler that throws', () => {
  test('still ends the request instead of hanging the socket', async () => {
    const handler = createRouter();
    handler.get('/x', () => { throw new Error('first'); });
    handler.use((err, req, res, next) => { throw new Error('second'); });

    const local = http.createServer((req, res) => handler(req, res));
    local.listen(0, '127.0.0.1');
    await once(local, 'listening');
    const { port } = local.address();

    const response = await fetch(`http://127.0.0.1:${port}/x`);
    const payload = await response.json();

    local.closeAllConnections();
    local.close();
    await once(local, 'close');

    assert.equal(response.status, 500);
    assert.equal(payload.code, 'INTERNAL');
  });
});
