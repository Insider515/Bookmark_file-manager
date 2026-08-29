import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createFileManagerRouter } from '../server/router.js';
import { FsOps } from '../server/fs-ops.js';
import {
  formatModeText,
  formatOctalMode,
  isExecutable,
  parseOctalMode,
  withExecutable,
} from '../server/mode.js';

const POSIX = process.platform !== 'win32';

let server;
let base;
let root;

async function start(options = {}) {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'fsfm-chmod-')));
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

const post = (route, body) =>
  fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const diskMode = async (relative) => (await fs.stat(path.join(root, relative))).mode & 0o777;

describe('mode: parsing and formatting', () => {
  test('octal strings round-trip', () => {
    assert.equal(formatOctalMode(parseOctalMode('755')), '755');
    assert.equal(formatOctalMode(parseOctalMode('0644')), '644');
    assert.equal(formatModeText(parseOctalMode('755')), 'rwxr-xr-x');
    assert.equal(formatModeText(parseOctalMode('640')), 'rw-r-----');
  });

  test('a number is refused, because JSON would read it as decimal', () => {
    // `mode: 755` looks octal to a human and is 0o1363 to a parser. Accepting
    // it is how a file ends up world-writable by accident.
    assert.throws(() => parseOctalMode(755), (err) => err.code === 'INVALID_MODE');
  });

  test('setuid, setgid and sticky are refused outright', () => {
    for (const value of ['4755', '2755', '1755']) {
      assert.throws(
        () => parseOctalMode(value),
        (err) => err.code === 'SPECIAL_BITS_REFUSED',
        `${value} must be refused`
      );
    }
  });

  test('malformed values are refused', () => {
    for (const value of ['', '7', '77', '9999', '75x', '77777', ' 755 x']) {
      assert.throws(() => parseOctalMode(value), (err) => err.code === 'INVALID_MODE', value);
    }
  });

  test('+x follows the read bits instead of setting all three', () => {
    // 640 -> 750, not 751: making a file executable must never hand it to
    // someone who could not already read it.
    assert.equal(formatOctalMode(withExecutable(0o640, true)), '750');
    assert.equal(formatOctalMode(withExecutable(0o644, true)), '755');
    assert.equal(formatOctalMode(withExecutable(0o600, true)), '700');
    assert.equal(formatOctalMode(withExecutable(0o755, false)), '644');
    assert.ok(isExecutable(0o755) && !isExecutable(0o644));
  });
});

describe('chmod: the permission is withheld unless asked for', () => {
  after(stop);

  test('it is off by default, unlike every other operation', async () => {
    await start();
    const config = await (await fetch(`${base}/config`)).json();
    // Upgrading the package must not hand an existing deployment the ability
    // to mark uploads executable.
    assert.equal(config.permissions.chmod, false);
    assert.equal(config.permissions.remove, true, 'the others still default to allowed');
  });

  test('a withheld chmod is refused at the route', async () => {
    await fs.writeFile(path.join(root, 'a.sh'), '#!/bin/sh\n', { mode: 0o644 });
    const response = await post('/chmod', { paths: ['/a.sh'], executable: true });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, 'PERMISSION_DENIED');
    if (POSIX) assert.equal(await diskMode('a.sh'), 0o644, 'the file must be untouched');
  });

  test('readOnly overrides an explicit grant', async () => {
    await stop();
    await start({ readOnly: true, permissions: { chmod: true } });
    assert.equal((await (await fetch(`${base}/config`)).json()).permissions.chmod, false);
  });
});

describe('chmod: changing bits', { skip: !POSIX && 'POSIX-only' }, () => {
  before(async () => {
    await start({ permissions: { chmod: true } });
    await fs.mkdir(path.join(root, 'bin'));
    await fs.writeFile(path.join(root, 'bin', 'run.sh'), '#!/bin/sh\n', { mode: 0o644 });
    await fs.writeFile(path.join(root, 'bin', 'private.sh'), '#!/bin/sh\n', { mode: 0o640 });
    await fs.writeFile(path.join(root, 'notes.txt'), 'x', { mode: 0o644 });
  });
  after(stop);

  test('executable: true sets the bits and reports the new mode', async () => {
    const response = await post('/chmod', { paths: ['/bin/run.sh'], executable: true });
    assert.equal(response.status, 200);
    const [updated] = await response.json();

    assert.equal(updated.modeOctal, '755');
    assert.equal(updated.modeText, 'rwxr-xr-x');
    assert.equal(updated.executable, true);
    assert.equal(await diskMode('bin/run.sh'), 0o755);
  });

  test('executable: false takes them away again', async () => {
    await post('/chmod', { paths: ['/bin/run.sh'], executable: false });
    assert.equal(await diskMode('bin/run.sh'), 0o644);
  });

  test('an absolute mode is applied verbatim', async () => {
    const [updated] = await (await post('/chmod', { paths: ['/notes.txt'], mode: '600' })).json();
    assert.equal(updated.modeOctal, '600');
    assert.equal(await diskMode('notes.txt'), 0o600);
  });

  test('the listing carries the mode, so the menu can label itself', async () => {
    await post('/chmod', { paths: ['/bin/run.sh'], mode: '755' });
    const listing = await (await fetch(`${base}/list?path=/bin`)).json();
    const entry = listing.items.find((item) => item.name === 'run.sh');
    assert.equal(entry.modeOctal, '755');
    assert.equal(entry.executable, true);
  });

  test('recursive keeps each entry’s own read bits', async () => {
    await post('/chmod', { paths: ['/bin'], executable: true, recursive: true });
    assert.equal(await diskMode('bin/run.sh'), 0o755);
    // 640 becomes 750, not 751 — the group and others gain nothing.
    assert.equal(await diskMode('bin/private.sh'), 0o750);
  });

  test('setuid is refused over HTTP too', async () => {
    const response = await post('/chmod', { paths: ['/notes.txt'], mode: '4755' });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'SPECIAL_BITS_REFUSED');
    assert.equal(await diskMode('notes.txt'), 0o600, 'nothing may have changed');
  });

  test('mode and executable together are refused as ambiguous', async () => {
    const response = await post('/chmod', { paths: ['/notes.txt'], mode: '755', executable: true });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'INVALID_MODE');
  });

  test('neither one is refused as well', async () => {
    assert.equal((await post('/chmod', { paths: ['/notes.txt'] })).status, 400);
  });

  test('the root cannot be chmodded', async () => {
    const response = await post('/chmod', { paths: ['/'], mode: '700' });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'ROOT_IMMUTABLE');
  });

  test('a path outside the root is refused', async () => {
    assert.equal((await post('/chmod', { paths: ['/../../tmp'], mode: '777' })).status, 400);
  });

  test('a symlink out of the root is not chmodded through', async () => {
    const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'fsfm-out-')));
    const victim = path.join(outside, 'victim.txt');
    await fs.writeFile(victim, 'x', { mode: 0o600 });
    await fs.mkdir(path.join(root, 'links'));
    await fs.symlink(victim, path.join(root, 'links', 'out.txt'));

    // Directly: the link is not listed and does not resolve inside the root.
    const direct = await post('/chmod', { paths: ['/links/out.txt'], mode: '777' });
    assert.equal(direct.status, 403);

    // Recursively: the walk must step over it rather than follow it.
    await post('/chmod', { paths: ['/links'], mode: '755', recursive: true });
    assert.equal((await fs.stat(victim)).mode & 0o777, 0o600, 'the outside file must be untouched');

    await fs.rm(outside, { recursive: true, force: true });
  });
});

describe('properties', { skip: !POSIX && 'POSIX-only' }, () => {
  before(async () => {
    await start({ permissions: { chmod: true } });
    await fs.mkdir(path.join(root, 'folder', 'nested'), { recursive: true });
    await fs.writeFile(path.join(root, 'folder', 'a.txt'), 'a'.repeat(100));
    await fs.writeFile(path.join(root, 'folder', 'nested', 'b.txt'), 'b'.repeat(50));
    await fs.writeFile(path.join(root, 'script.sh'), '#!/bin/sh\n', { mode: 0o755 });
  });
  after(stop);

  test('a file reports its mode in all three renderings', async () => {
    const details = await (await fetch(`${base}/properties?path=/script.sh`)).json();
    assert.equal(details.modeOctal, '755');
    assert.equal(details.modeText, 'rwxr-xr-x');
    assert.equal(details.mode, 0o755);
    assert.equal(details.executable, true);
    assert.equal(details.isDirectory, false);
    assert.ok(details.created && details.modified && details.accessed);
  });

  test('modeEditable mirrors whether this session may actually change it', async () => {
    assert.equal((await (await fetch(`${base}/properties?path=/script.sh`)).json()).modeEditable, true);

    await stop();
    await start(); // chmod withheld by default
    await fs.writeFile(path.join(root, 'script.sh'), '#!/bin/sh\n', { mode: 0o755 });
    assert.equal((await (await fetch(`${base}/properties?path=/script.sh`)).json()).modeEditable, false);
  });

  test('a directory counts its children but does not add up bytes unasked', async () => {
    await stop();
    await start({ permissions: { chmod: true } });
    await fs.mkdir(path.join(root, 'folder', 'nested'), { recursive: true });
    await fs.writeFile(path.join(root, 'folder', 'a.txt'), 'a'.repeat(100));
    await fs.writeFile(path.join(root, 'folder', 'nested', 'b.txt'), 'b'.repeat(50));

    const plain = await (await fetch(`${base}/properties?path=/folder`)).json();
    assert.equal(plain.isDirectory, true);
    assert.equal(plain.itemCount, 2);
    assert.equal(plain.totalSize, null, 'the walk is opt-in');

    const walked = await (await fetch(`${base}/properties?path=/folder&size=1`)).json();
    assert.equal(walked.totalSize, 150, 'both files, including the nested one');
    assert.equal(walked.totalSizePartial, false);
  });

  test('the walk admits when it stopped early instead of under-reporting', async () => {
    await stop();
    await start({ maxSizeWalkEntries: 1 });
    await fs.mkdir(path.join(root, 'many'));
    for (let i = 0; i < 5; i += 1) {
      await fs.writeFile(path.join(root, 'many', `f${i}.txt`), 'xxxxx');
    }
    const walked = await (await fetch(`${base}/properties?path=/many&size=1`)).json();
    assert.equal(walked.totalSizePartial, true);
    assert.ok(walked.totalSize < 25, 'it really did stop short');
  });

  test('no absolute server path leaks into the properties', async () => {
    await stop();
    await start();
    await fs.writeFile(path.join(root, 'x.txt'), 'x');
    const text = await (await fetch(`${base}/properties?path=/x.txt`)).text();
    assert.ok(!text.includes(root), `absolute root leaked: ${text}`);
  });

  test('a symlink reports its target as a virtual path, never an absolute one', async () => {
    await fs.mkdir(path.join(root, 'real'));
    await fs.writeFile(path.join(root, 'real', 'target.txt'), 'x');
    await fs.symlink(path.join(root, 'real', 'target.txt'), path.join(root, 'link.txt'));

    const details = await (await fetch(`${base}/properties?path=/link.txt`)).json();
    assert.equal(details.isSymbolicLink, true);
    assert.equal(details.linkTarget, '/real/target.txt');
  });
});

describe('chmod: FsOps refuses on a platform without mode bits', () => {
  test('chmodSupported drives both the permission and the route', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fsfm-plat-'));
    const ops = new FsOps({ root: dir, permissions: { chmod: true } });
    await ops.init();

    assert.equal(ops.chmodSupported, POSIX);
    assert.equal(ops.can('chmod'), POSIX, 'a platform without the concept never advertises it');

    await fs.rm(dir, { recursive: true, force: true });
  });
});
