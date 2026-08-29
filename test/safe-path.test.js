import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  FsError,
  assertValidName,
  baseName,
  isSameOrInside,
  joinVirtual,
  normalizeVirtual,
  parentVirtual,
  resolveSafe,
} from '../server/safe-path.js';

describe('normalizeVirtual', () => {
  test('canonicalises separators and empty segments', () => {
    assert.equal(normalizeVirtual(''), '/');
    assert.equal(normalizeVirtual('/'), '/');
    assert.equal(normalizeVirtual('//a///b//'), '/a/b');
    assert.equal(normalizeVirtual('a/b'), '/a/b');
    assert.equal(normalizeVirtual('/a/./b'), '/a/b');
  });

  test('refuses traversal rather than resolving it', () => {
    assert.throws(() => normalizeVirtual('/a/../b'), (err) => err.code === 'INVALID_PATH');
    assert.throws(() => normalizeVirtual('..'), (err) => err.code === 'INVALID_PATH');
    assert.throws(() => normalizeVirtual('/../../etc/passwd'), (err) => err.code === 'INVALID_PATH');
    assert.throws(() => normalizeVirtual('/a/..'), (err) => err.code === 'INVALID_PATH');
  });

  test('refuses traversal spelled with backslashes too', () => {
    // A backslash separates directories on Windows. The same string is one
    // legal filename on POSIX, so it is refused either way rather than left to
    // whichever platform the server happens to run on.
    assert.throws(() => normalizeVirtual('a\\..\\b'), (err) => err.code === 'INVALID_PATH');
    assert.throws(() => normalizeVirtual('/a\\..'), (err) => err.code === 'INVALID_PATH');
  });

  test('refuses a NUL byte', () => {
    // It ends the string inside the syscall, so what gets opened stops
    // matching whatever was checked in JavaScript.
    assert.throws(() => normalizeVirtual('/a\u0000b'), (err) => err.code === 'INVALID_PATH');
  });

  test('addresses names the filesystem allows, however unusual', () => {
    // All legal on Linux and macOS. Refusing them here turned one oddly named
    // file into a 400 for its whole directory: these paths are built from the
    // filesystem, not sent by a client.
    for (const name of ['звіт?.txt', 'a"b.txt', 'note:2026.md', 'зірка*.log',
      'труба|канал.txt', '<b>тека</b>']) {
      assert.equal(normalizeVirtual(`/${name}`), `/${name}`, name);
    }
  });

  test('a backslash is a character in a name, not a separator', () => {
    // Splitting on it reported `а\б.txt` as the path `/а/б.txt` — a name the
    // client was shown and could never open.
    assert.equal(normalizeVirtual('/а\\б.txt'), '/а\\б.txt');
    assert.equal(baseName('/а\\б.txt'), 'а\\б.txt');
    assert.equal(parentVirtual('/каталог/а\\б.txt'), '/каталог');
  });
});

describe('assertValidName', () => {
  test('accepts ordinary names including spaces, hyphens and unicode', () => {
    for (const name of ['file.txt', 'my file-2.txt', 'Документ.docx', 'a'.repeat(255)]) {
      assert.equal(assertValidName(name), name);
    }
  });

  test('rejects names that would be ambiguous or unportable', () => {
    // Deliberately stricter than the filesystem: a name created here should
    // survive a copy to Windows. Reading such a name is a separate question,
    // and normalizeVirtual above allows it.
    const bad = ['', '.', '..', 'a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b',
      'trailing.', 'trailing ', 'con', 'CON.txt', 'lpt1.log', 'a'.repeat(256), 'nul'];
    for (const name of bad) {
      assert.throws(() => assertValidName(name), FsError, `expected rejection for ${JSON.stringify(name)}`);
    }
  });
});

describe('path helpers', () => {
  test('parent, join and baseName agree with each other', () => {
    assert.equal(parentVirtual('/a/b/c'), '/a/b');
    assert.equal(parentVirtual('/a'), '/');
    assert.equal(parentVirtual('/'), '/');
    assert.equal(joinVirtual('/', 'a'), '/a');
    assert.equal(joinVirtual('/a', 'b'), '/a/b');
    assert.equal(baseName('/a/b.txt'), 'b.txt');
    assert.equal(baseName('/'), '');
  });

  test('isSameOrInside does not treat sibling prefixes as nested', () => {
    assert.equal(isSameOrInside('/a', '/a'), true);
    assert.equal(isSameOrInside('/a', '/a/b'), true);
    assert.equal(isSameOrInside('/a', '/ab'), false);
    assert.equal(isSameOrInside('/a/b', '/a'), false);
    assert.equal(isSameOrInside('/', '/anything'), true);
  });
});

describe('resolveSafe', () => {
  let root;

  test('setup', async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'fsfm-safe-')));
    await fs.mkdir(path.join(root, 'inside'));
    await fs.writeFile(path.join(root, 'inside', 'file.txt'), 'x');
  });

  test('resolves paths inside the root', async () => {
    const result = await resolveSafe(root, '/inside/file.txt');
    assert.equal(result.exists, true);
    assert.equal(result.virtual, '/inside/file.txt');
    assert.equal(result.absolute, path.join(root, 'inside', 'file.txt'));
  });

  test('reports missing leaves, and allows them only when asked', async () => {
    await assert.rejects(resolveSafe(root, '/inside/nope.txt'), (err) => err.code === 'NOT_FOUND');
    const allowed = await resolveSafe(root, '/inside/nope.txt', { allowMissing: true });
    assert.equal(allowed.exists, false);
    assert.equal(allowed.absolute, path.join(root, 'inside', 'nope.txt'));
  });

  test('a missing parent is reported even with allowMissing', async () => {
    await assert.rejects(
      resolveSafe(root, '/no-such-dir/file.txt', { allowMissing: true }),
      (err) => err.code === 'NOT_FOUND'
    );
  });

  test('refuses a symlink that escapes the root', async () => {
    const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'fsfm-outside-')));
    await fs.writeFile(path.join(outside, 'secret.txt'), 'secret');
    await fs.symlink(outside, path.join(root, 'escape'));

    await assert.rejects(resolveSafe(root, '/escape'), (err) => err.code === 'OUTSIDE_ROOT');
    await assert.rejects(resolveSafe(root, '/escape/secret.txt'), (err) => err.code === 'OUTSIDE_ROOT');
    // Writing through a symlinked parent must be refused too.
    await assert.rejects(
      resolveSafe(root, '/escape/new.txt', { allowMissing: true }),
      (err) => err.code === 'OUTSIDE_ROOT'
    );

    await fs.rm(outside, { recursive: true, force: true });
    await fs.rm(path.join(root, 'escape'), { force: true });
  });

  test('a symlink that stays inside the root is allowed', async () => {
    await fs.symlink(path.join(root, 'inside'), path.join(root, 'link'));
    const result = await resolveSafe(root, '/link/file.txt');
    assert.equal(result.absolute, path.join(root, 'inside', 'file.txt'));
  });

  test('teardown', async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
});
