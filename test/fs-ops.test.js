import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { FsOps } from '../server/fs-ops.js';

/** Fresh ops instance over a throwaway directory. */
async function makeOps(options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fsfm-ops-'));
  const ops = new FsOps({ root, ...options });
  await ops.init();
  return { ops, root: await fs.realpath(root) };
}

describe('FsOps: listing and tree', () => {
  let ops;
  let root;

  before(async () => {
    ({ ops, root } = await makeOps());
    await fs.mkdir(path.join(root, 'Docs', 'Sub'), { recursive: true });
    await fs.writeFile(path.join(root, 'Docs', 'b.txt'), 'bb');
    await fs.writeFile(path.join(root, 'Docs', 'a.txt'), 'a');
    await fs.writeFile(path.join(root, 'top.md'), '# top');
  });

  after(() => fs.rm(root, { recursive: true, force: true }));

  test('lists directories before files, then by name', async () => {
    const listing = await ops.list('/Docs');
    assert.deepEqual(listing.items.map((entry) => entry.name), ['Sub', 'a.txt', 'b.txt']);
    assert.equal(listing.path, '/Docs');
    assert.equal(listing.parent, '/');
  });

  test('entries carry size, kind and a virtual path only', async () => {
    const listing = await ops.list('/Docs');
    const file = listing.items.find((entry) => entry.name === 'b.txt');
    assert.equal(file.isDirectory, false);
    assert.equal(file.size, 2);
    assert.equal(file.path, '/Docs/b.txt');
    assert.ok(!JSON.stringify(listing).includes(root), 'absolute paths must not leak to the client');
  });

  test('root listing reports no parent', async () => {
    const listing = await ops.list('/');
    assert.equal(listing.parent, null);
  });

  test('tree contains directories only, with a hasChildren hint', async () => {
    const tree = await ops.tree('/', 1);
    assert.equal(tree.path, '/');
    assert.deepEqual(tree.children.map((node) => node.name), ['Docs']);
    assert.equal(tree.children[0].hasChildren, true);
    // depth 1 means Docs' own children are not expanded yet
    assert.equal(tree.children[0].children, null);
  });

  test('tree depth expands further levels', async () => {
    const tree = await ops.tree('/', 2);
    assert.deepEqual(tree.children[0].children.map((node) => node.name), ['Sub']);
  });
});

describe('FsOps: create, rename, delete', () => {
  let ops;
  let root;

  before(async () => {
    ({ ops, root } = await makeOps());
  });
  after(() => fs.rm(root, { recursive: true, force: true }));

  test('createDirectory returns the new entry', async () => {
    const entry = await ops.createDirectory('/', 'New Folder');
    assert.equal(entry.name, 'New Folder');
    assert.equal(entry.isDirectory, true);
    assert.equal(entry.path, '/New Folder');
  });

  test('createDirectory refuses a duplicate', async () => {
    await assert.rejects(ops.createDirectory('/', 'New Folder'), (err) => err.code === 'EXISTS');
  });

  test('createFile writes an empty file and refuses to clobber', async () => {
    const entry = await ops.createFile('/', 'note.txt');
    assert.equal(entry.size, 0);
    await fs.writeFile(path.join(root, 'note.txt'), 'content');
    await assert.rejects(ops.createFile('/', 'note.txt'), (err) => err.code === 'EXISTS');
    // The failed create must not have truncated the existing content.
    assert.equal(await fs.readFile(path.join(root, 'note.txt'), 'utf8'), 'content');
  });

  test('rename moves within the same directory', async () => {
    const renamed = await ops.rename('/note.txt', 'renamed.txt');
    assert.equal(renamed.path, '/renamed.txt');
    assert.equal(await fs.readFile(path.join(root, 'renamed.txt'), 'utf8'), 'content');
  });

  test('rename refuses to overwrite an existing sibling', async () => {
    await ops.createFile('/', 'other.txt');
    await assert.rejects(ops.rename('/renamed.txt', 'other.txt'), (err) => err.code === 'EXISTS');
    // Both files must still be there.
    assert.ok(await fs.stat(path.join(root, 'renamed.txt')));
    assert.ok(await fs.stat(path.join(root, 'other.txt')));
  });

  test('the root cannot be renamed or deleted', async () => {
    await assert.rejects(ops.rename('/', 'x'), (err) => err.code === 'ROOT_IMMUTABLE');
    await assert.rejects(ops.remove(['/']), (err) => err.code === 'ROOT_IMMUTABLE');
  });

  test('remove deletes files and non-empty directories', async () => {
    await fs.mkdir(path.join(root, 'tree', 'deep'), { recursive: true });
    await fs.writeFile(path.join(root, 'tree', 'deep', 'x.txt'), 'x');
    const removed = await ops.remove(['/tree', '/other.txt']);
    assert.deepEqual(removed, ['/tree', '/other.txt']);
    await assert.rejects(fs.stat(path.join(root, 'tree')));
  });

  test('remove reports a missing target rather than succeeding silently', async () => {
    await assert.rejects(ops.remove(['/gone.txt']), (err) => err.code === 'NOT_FOUND');
  });
});

describe('FsOps: move and copy', () => {
  let ops;
  let root;

  before(async () => {
    ({ ops, root } = await makeOps());
    await fs.mkdir(path.join(root, 'src', 'nested'), { recursive: true });
    await fs.mkdir(path.join(root, 'dest'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'file.txt'), 'data');
    await fs.writeFile(path.join(root, 'src', 'nested', 'deep.txt'), 'deep');
  });
  after(() => fs.rm(root, { recursive: true, force: true }));

  test('move relocates a file', async () => {
    const [moved] = await ops.move(['/src/file.txt'], '/dest');
    assert.equal(moved.path, '/dest/file.txt');
    assert.equal(await fs.readFile(path.join(root, 'dest', 'file.txt'), 'utf8'), 'data');
    await assert.rejects(fs.stat(path.join(root, 'src', 'file.txt')));
  });

  test('a name collision is resolved by suffixing, not overwriting', async () => {
    await fs.writeFile(path.join(root, 'src', 'file.txt'), 'second');
    const [moved] = await ops.move(['/src/file.txt'], '/dest');
    assert.equal(moved.path, '/dest/file (2).txt');
    assert.equal(await fs.readFile(path.join(root, 'dest', 'file.txt'), 'utf8'), 'data');
    assert.equal(await fs.readFile(path.join(root, 'dest', 'file (2).txt'), 'utf8'), 'second');
  });

  test('overwrite replaces the destination when explicitly requested', async () => {
    await fs.writeFile(path.join(root, 'src', 'file.txt'), 'third');
    const [moved] = await ops.move(['/src/file.txt'], '/dest', { overwrite: true });
    assert.equal(moved.path, '/dest/file.txt');
    assert.equal(await fs.readFile(path.join(root, 'dest', 'file.txt'), 'utf8'), 'third');
  });

  test('a directory cannot be moved into itself or its own descendant', async () => {
    await assert.rejects(ops.move(['/src'], '/src'), (err) => err.code === 'INTO_SELF');
    await assert.rejects(ops.move(['/src'], '/src/nested'), (err) => err.code === 'INTO_SELF');
  });

  test('copy duplicates a directory recursively and leaves the source', async () => {
    const [copied] = await ops.copy(['/src'], '/dest');
    assert.equal(copied.path, '/dest/src');
    assert.equal(
      await fs.readFile(path.join(root, 'dest', 'src', 'nested', 'deep.txt'), 'utf8'),
      'deep'
    );
    assert.ok(await fs.stat(path.join(root, 'src', 'nested', 'deep.txt')));
  });

  test('moving into the directory an item already sits in is a no-op', async () => {
    await fs.writeFile(path.join(root, 'dest', 'stay.txt'), 'stay');
    const [result] = await ops.move(['/dest/stay.txt'], '/dest');
    assert.equal(result.path, '/dest/stay.txt');
    assert.equal(await fs.readFile(path.join(root, 'dest', 'stay.txt'), 'utf8'), 'stay');
  });
});

describe('FsOps: uploads', () => {
  let ops;
  let root;

  before(async () => {
    ({ ops, root } = await makeOps({ maxUploadSize: 64 }));
  });
  after(() => fs.rm(root, { recursive: true, force: true }));

  test('streams a file to disk', async () => {
    const entry = await ops.writeUpload('/', 'hello.txt', Readable.from([Buffer.from('hello')]));
    assert.equal(entry.path, '/hello.txt');
    assert.equal(await fs.readFile(path.join(root, 'hello.txt'), 'utf8'), 'hello');
  });

  test('strips any directory part from the client filename', async () => {
    const entry = await ops.writeUpload('/', '../../evil.txt', Readable.from([Buffer.from('x')]));
    assert.equal(entry.path, '/evil.txt');
    const outside = path.resolve(root, '..', 'evil.txt');
    await assert.rejects(fs.stat(outside), 'must not have written above the root');
  });

  test('a collision gets a suffix instead of overwriting', async () => {
    const entry = await ops.writeUpload('/', 'hello.txt', Readable.from([Buffer.from('again')]));
    assert.equal(entry.path, '/hello (2).txt');
    assert.equal(await fs.readFile(path.join(root, 'hello.txt'), 'utf8'), 'hello');
  });

  test('an oversized upload is rejected and leaves no partial file', async () => {
    const big = Readable.from([Buffer.alloc(100, 0x61)]);
    await assert.rejects(ops.writeUpload('/', 'big.txt', big), (err) => err.code === 'TOO_LARGE');
    const names = await fs.readdir(root);
    assert.ok(!names.includes('big.txt'), 'the rejected upload must not appear');
    assert.equal(names.filter((name) => name.includes('.upload-')).length, 0, 'no temp file left behind');
  });
});

describe('FsOps: read-only mode', () => {
  let ops;
  let root;

  before(async () => {
    ({ ops, root } = await makeOps({ readOnly: true }));
    await fs.writeFile(path.join(root, 'a.txt'), 'a');
  });
  after(() => fs.rm(root, { recursive: true, force: true }));

  test('reading still works', async () => {
    const listing = await ops.list('/');
    assert.equal(listing.items.length, 1);
  });

  test('every mutating operation is refused', async () => {
    const isReadOnly = (err) => err.code === 'READ_ONLY';
    await assert.rejects(ops.createDirectory('/', 'x'), isReadOnly);
    await assert.rejects(ops.createFile('/', 'x.txt'), isReadOnly);
    await assert.rejects(ops.rename('/a.txt', 'b.txt'), isReadOnly);
    await assert.rejects(ops.move(['/a.txt'], '/'), isReadOnly);
    await assert.rejects(ops.copy(['/a.txt'], '/'), isReadOnly);
    await assert.rejects(ops.remove(['/a.txt']), isReadOnly);
    await assert.rejects(
      ops.writeUpload('/', 'x.txt', Readable.from([Buffer.from('x')])),
      isReadOnly
    );
  });
});

describe('FsOps: names the filesystem allows but Windows does not', () => {
  // `? " : * < > |` and a backslash are all legal in a POSIX filename. The
  // listing builds its paths from the filesystem, so holding those paths to
  // the rule meant for *client input* turned one oddly named file into a 400
  // for its whole directory — and a backslash, being read as a separator,
  // reported `а\б.txt` under the path `/а/б.txt`, which then opened nothing.
  const ODD = ['звіт?.txt', 'a"b.txt', 'note:2026.md', 'зірка*.log', 'труба|канал.txt'];
  const BACKSLASH = 'а\\б.txt';
  const ODD_DIR = '<b>тека';

  let ops;
  let root;

  before(async () => {
    ({ ops, root } = await makeOps());
    for (const name of [...ODD, BACKSLASH, 'звичайний.txt']) {
      await fs.writeFile(path.join(root, name), 'вміст');
    }
    await fs.mkdir(path.join(root, ODD_DIR));
    await fs.writeFile(path.join(root, ODD_DIR, 'всередині.txt'), 'ШУКАНЕ');
  });
  after(() => fs.rm(root, { recursive: true, force: true }));

  test('the whole directory lists, not just the ordinary files', async () => {
    const listing = await ops.list('/');
    const names = listing.items.map((item) => item.name).sort();
    for (const name of [...ODD, BACKSLASH, 'звичайний.txt', ODD_DIR]) {
      assert.ok(names.includes(name), `${name} присутнє в лістингу`);
    }
  });

  test('a backslash stays part of the name', async () => {
    const listing = await ops.list('/');
    const entry = listing.items.find((item) => item.name === BACKSLASH);
    assert.ok(entry, 'файл зі зворотним слешем знайдено');
    assert.equal(entry.path, `/${BACKSLASH}`, 'і шлях не розрізано на два сегменти');
  });

  test('every path the listing hands out actually opens', async () => {
    // The real failure was a name the client could see and never use.
    const listing = await ops.list('/');
    for (const item of listing.items) {
      if (item.isDirectory) continue;
      const read = await ops.readText(item.path);
      assert.equal(read.text.trim(), 'вміст', item.path);
    }
  });

  test('a directory with such a name can be entered', async () => {
    const inside = await ops.list(`/${ODD_DIR}`);
    assert.deepEqual(inside.items.map((item) => item.name), ['всередині.txt']);
  });

  test('search, tree and properties agree with the listing', async () => {
    const found = await ops.search('/', { query: '*.txt', mode: 'glob' });
    assert.ok(found.matches.some((match) => match.name === BACKSLASH));

    const byContent = await ops.search('/', { query: 'ШУКАНЕ', scope: 'content' });
    assert.deepEqual(byContent.matches.map((match) => match.path), [`/${ODD_DIR}/всередині.txt`]);

    const tree = await ops.tree('/', 1);
    assert.deepEqual(tree.children.map((child) => child.name), [ODD_DIR]);

    const details = await ops.properties(`/${ODD[0]}`);
    assert.equal(details.name, ODD[0]);
  });

  test('they can be copied, renamed and deleted', async () => {
    const [copied] = await ops.copy([`/${ODD[0]}`], `/${ODD_DIR}`);
    assert.equal(copied.path, `/${ODD_DIR}/${ODD[0]}`);

    const renamed = await ops.rename(`/${ODD[1]}`, 'перейменований.txt');
    assert.equal(renamed.name, 'перейменований.txt');

    const removed = await ops.remove([`/${ODD[3]}`]);
    assert.deepEqual(removed, [`/${ODD[3]}`]);
  });

  test('but creating such a name is still refused', async () => {
    // The portability rule is deliberately kept: a name created here should
    // survive a copy to Windows. Only *reading* what is already there changed.
    for (const name of ['новий?.txt', 'a|b.txt', 'a\\b.txt']) {
      await assert.rejects(
        () => ops.createFile('/', name),
        (err) => err.code === 'INVALID_NAME',
        name
      );
    }
  });

  test('traversal is still refused, spelled either way', async () => {
    for (const bad of ['/../etc', '/a/../..', 'a\\..\\b']) {
      await assert.rejects(() => ops.list(bad), (err) => err.code === 'INVALID_PATH', bad);
    }
  });
});
