import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createFileManagerRouter } from '../server/router.js';
import { FsOps } from '../server/fs-ops.js';
import {
  DEFAULT_SEARCH_LIMITS,
  compileMatcher,
  globToRegExp,
  normaliseSearchOptions,
  runSearch,
} from '../server/search.js';

let root;
let ops;

/** A tree with something for every filter to catch or reject. */
before(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'fsfm-search-')));
  const make = async (relative, content) => {
    await fs.mkdir(path.join(root, path.dirname(relative)), { recursive: true });
    await fs.writeFile(path.join(root, relative), content);
  };

  await make('проєкт/src/main.js', 'const TODO = 1;\n// TODO: полагодити\nfunction main() {}\n');
  await make('проєкт/src/style.css', 'body { color: red; }\n/* todo */\n');
  await make('проєкт/readme.md', '# Заголовок\n\nтут про TODO\n');
  await make('проєкт/Архів/старе.TXT', 'нічого\n');
  await make('документи/нотатка.txt', 'звичайний текст\n');
  await fs.mkdir(path.join(root, 'проєкт/TODO-тека'), { recursive: true });

  // A binary file whose bytes happen to contain the query.
  await fs.writeFile(path.join(root, 'проєкт/зображення.png'), Buffer.from('\x00\x01TODO\x00', 'latin1'));
  // A line long enough that a catastrophic pattern cannot finish on it.
  await make('проєкт/довга.txt', `${'a'.repeat(400)}b\n`);

  ops = new FsOps({ root });
  await ops.init();
});
after(() => fs.rm(root, { recursive: true, force: true }));

const paths = (result) => result.matches.map((match) => match.path).sort();

describe('search: masks', () => {
  const matches = (pattern, text, options) => globToRegExp(pattern, options).test(text);

  test('a mask describes the whole name, not a part of it', () => {
    assert.ok(matches('*.js', 'main.js'));
    assert.ok(!matches('*.js', 'main.js.map'));
    assert.ok(!matches('main', 'main.js'), 'без зірочок маска — точне ім’я');
  });

  test('? is exactly one character and * stops at a slash', () => {
    assert.ok(matches('main.??', 'main.js'));
    assert.ok(!matches('main.?', 'main.js'));
    assert.ok(matches('*.js', 'main.js'));
    assert.ok(!matches('*.js', 'src/main.js'), '* не переходить через слеш');
    assert.ok(matches('**/*.js', 'src/deep/main.js'), '** переходит');
  });

  test('**/ also matches nothing at all', () => {
    // Otherwise `**/*.js` would find nested files but miss the ones on top.
    assert.ok(matches('**/*.js', 'main.js'));
    assert.ok(matches('**/*.js', 'a/b/main.js'));
  });

  test('character sets and negation', () => {
    assert.ok(matches('[abc].txt', 'a.txt'));
    assert.ok(!matches('[abc].txt', 'd.txt'));
    assert.ok(matches('[!abc].txt', 'd.txt'));
    assert.ok(!matches('[!abc].txt', 'a.txt'));
    assert.ok(matches('[а-я].txt', 'ж.txt'), 'діапазони працюють і для кирилиці');
  });

  test('braces are alternatives', () => {
    assert.ok(matches('*.{js,ts,tsx}', 'a.ts'));
    assert.ok(matches('*.{js,ts,tsx}', 'a.tsx'));
    assert.ok(!matches('*.{js,ts,tsx}', 'a.css'));
  });

  test('regex metacharacters in a mask are literal', () => {
    // A mask is not a regular expression: `a+b` means a plus sign.
    assert.ok(matches('a+b.txt', 'a+b.txt'));
    assert.ok(!matches('a+b.txt', 'aab.txt'));
    assert.ok(matches('file(1).txt', 'file(1).txt'));
    assert.ok(matches('2.5.txt', '2.5.txt'));
    assert.ok(!matches('2.5.txt', '2x5.txt'), 'крапка — це крапка');
  });

  test('case is ignored unless asked for', () => {
    assert.ok(matches('*.TXT', 'файл.txt'));
    assert.ok(!matches('*.TXT', 'файл.txt', { caseSensitive: true }));
  });

  test('an unterminated bracket or brace is a literal, not an error', () => {
    assert.doesNotThrow(() => globToRegExp('[abc'));
    assert.ok(matches('[abc', '[abc'));
    assert.doesNotThrow(() => globToRegExp('{a,b'));
  });
});

describe('search: the matcher', () => {
  test('substring reports where the match is', () => {
    const matcher = compileMatcher({ query: 'да', mode: 'substring', caseSensitive: false });
    assert.deepEqual(matcher.find('когда-то'), { index: 3, length: 2 });
    assert.equal(matcher.find('ничего'), null);
  });

  test('substring ignores case by default and respects it on request', () => {
    assert.ok(compileMatcher({ query: 'todo', mode: 'substring' }).find('TODO here'));
    assert.equal(
      compileMatcher({ query: 'todo', mode: 'substring', caseSensitive: true }).find('TODO here'),
      null
    );
  });

  test('a regular expression is one, and a broken one is refused', () => {
    const matcher = compileMatcher({ query: '^(a|b)+$', mode: 'regex' });
    assert.ok(matcher.find('abab'));
    assert.equal(matcher.find('abc'), null);
    assert.throws(
      () => compileMatcher({ query: '(((', mode: 'regex' }),
      (err) => err.code === 'INVALID_REGEX' && err.status === 400
    );
  });

  test('a zero-width match still has something to point at', () => {
    // `a*` matches the empty string; a length of 0 would highlight nothing.
    const matcher = compileMatcher({ query: 'x*', mode: 'regex' });
    assert.deepEqual(matcher.find('abc'), { index: 0, length: 1 });
  });
});

describe('search: options', () => {
  test('defaults are the forgiving ones', () => {
    const options = normaliseSearchOptions({ query: 'a' });
    assert.equal(options.mode, 'substring');
    assert.equal(options.type, 'all');
    assert.equal(options.scope, 'name');
    assert.equal(options.caseSensitive, false, 'регистр игнорируется по умолчанию');
  });

  test('extensions are accepted however they are written', () => {
    assert.deepEqual(
      normaliseSearchOptions({ query: 'a', extensions: '.JS, ts  md,*.css' }).extensions,
      ['js', 'ts', 'md', 'css']
    );
    assert.deepEqual(
      normaliseSearchOptions({ query: 'a', extensions: ['js', 'TS'] }).extensions,
      ['js', 'ts']
    );
  });

  test('a search with nothing to match on is refused', () => {
    assert.throws(() => normaliseSearchOptions({ query: '' }), (err) => err.code === 'EMPTY_QUERY');
    // But filters alone are a search: "every .js file below here".
    assert.doesNotThrow(() => normaliseSearchOptions({ query: '', extensions: 'js' }));
  });

  test('combinations that cannot mean anything are refused', () => {
    assert.throws(
      () => normaliseSearchOptions({ query: '', extensions: 'js', scope: 'content' }),
      (err) => err.code === 'EMPTY_QUERY'
    );
    assert.throws(
      () => normaliseSearchOptions({ query: 'a', scope: 'content', type: 'directory' }),
      (err) => err.code === 'CONTENT_NEEDS_FILES'
    );
  });

  test('an unknown mode falls back rather than failing', () => {
    assert.equal(normaliseSearchOptions({ query: 'a', mode: 'фир' }).mode, 'substring');
    assert.equal(normaliseSearchOptions({ query: 'a', type: 'фир' }).type, 'all');
  });

  test('limits cannot be raised past what the server allows', () => {
    const options = normaliseSearchOptions({ query: 'a', limit: 1e9, maxDepth: 1e9 });
    assert.equal(options.maxResults, DEFAULT_SEARCH_LIMITS.maxResults);
    assert.equal(options.maxDepth, DEFAULT_SEARCH_LIMITS.maxDepth);
  });

  test('a broken pattern is rejected here, before any work starts', () => {
    assert.throws(
      () => normaliseSearchOptions({ query: '(((', mode: 'regex' }),
      (err) => err.code === 'INVALID_REGEX'
    );
  });
});

describe('search: the walk', () => {
  const search = (options) =>
    ops.search('/', options);

  test('it reaches every level, not just the one it starts in', async () => {
    const result = await search({ query: 'main', type: 'file' });
    assert.deepEqual(paths(result), ['/проєкт/src/main.js']);
    assert.ok(result.scanned > 5);
  });

  test('case is ignored by default', async () => {
    assert.deepEqual(paths(await search({ query: 'ТОДО' })), []);
    assert.deepEqual(paths(await search({ query: 'todo-ТЕКА' })), ['/проєкт/TODO-тека']);
    assert.deepEqual(
      paths(await search({ query: 'todo-ТЕКА', caseSensitive: true })),
      [],
      'з урахуванням регістру — не знаходиться'
    );
  });

  test('only files, or only folders', async () => {
    assert.deepEqual(paths(await search({ query: 'todo', type: 'directory' })), ['/проєкт/TODO-тека']);
    assert.deepEqual(paths(await search({ query: 'todo', type: 'file' })), []);
  });

  test('by extension, with no query at all', async () => {
    assert.deepEqual(paths(await search({ query: '', extensions: 'js,css' })), [
      '/проєкт/src/main.js',
      '/проєкт/src/style.css',
    ]);
    // The filter is on the name, so an upper-case extension still counts.
    assert.deepEqual(paths(await search({ query: '', extensions: 'txt' })), [
      '/документи/нотатка.txt',
      '/проєкт/Архів/старе.TXT',
      '/проєкт/довга.txt',
    ]);
  });

  test('a mask with a slash is matched against the path', async () => {
    assert.deepEqual(paths(await search({ query: '**/src/*.js', mode: 'glob' })), [
      '/проєкт/src/main.js',
    ]);
    assert.deepEqual(paths(await search({ query: '*.css', mode: 'glob' })), [
      '/проєкт/src/style.css',
    ]);
  });

  test('a regular expression matches names', async () => {
    assert.deepEqual(paths(await search({ query: '^(main|style)\\.', mode: 'regex' })), [
      '/проєкт/src/main.js',
      '/проєкт/src/style.css',
    ]);
  });

  test('inside files, with the matching lines', async () => {
    const result = await ops.search('/', { query: 'TODO', scope: 'content', caseSensitive: true });
    assert.deepEqual(paths(result), [
      '/проєкт/readme.md',
      '/проєкт/src/main.js',
    ]);
    const main = result.matches.find((match) => match.name === 'main.js');
    assert.equal(main.matchedIn, 'content');
    assert.deepEqual(main.lines.map((line) => line.line), [1, 2]);
    assert.equal(main.lines[0].text, 'const TODO = 1;');
    // The column is where the highlight goes, so it has to be the real offset.
    assert.equal(main.lines[0].text.slice(main.lines[0].column, main.lines[0].column + 4), 'TODO');
  });

  test('binary files are not searched', async () => {
    const result = await ops.search('/', { query: 'TODO', scope: 'content', caseSensitive: true });
    assert.ok(
      !result.matches.some((match) => match.name.endsWith('.png')),
      'файл із нульовими байтами пропущено, хоча байти збігаються'
    );
  });

  test('name and content together', async () => {
    const result = await ops.search('/', { query: 'todo', scope: 'both' });
    assert.deepEqual(paths(result), [
      '/проєкт/TODO-тека',
      '/проєкт/readme.md',
      '/проєкт/src/main.js',
      '/проєкт/src/style.css',
    ]);
    assert.equal(
      result.matches.find((match) => match.name === 'TODO-тека').matchedIn,
      'name'
    );
  });

  test('content search can be narrowed by extension', async () => {
    const result = await ops.search('/', { query: 'todo', scope: 'content', extensions: 'css' });
    assert.deepEqual(paths(result), ['/проєкт/src/style.css']);
  });

  test('results come back in tree order, folders first', async () => {
    const result = await ops.search('/', { query: 'о' });
    const folders = result.matches.filter((match) => match.isDirectory);
    const files = result.matches.filter((match) => !match.isDirectory);
    assert.ok(folders.length > 0 && files.length > 0);
    assert.equal(
      result.matches.indexOf(folders[folders.length - 1]) < result.matches.indexOf(files[0]),
      true
    );
  });

  test('the starting folder can be anywhere in the tree', async () => {
    const result = await ops.search('/документи', { query: '', extensions: 'txt' });
    assert.deepEqual(paths(result), ['/документи/нотатка.txt']);
  });

  test('a depth limit stops the descent', async () => {
    const shallow = await ops.search('/', { query: 'main', maxDepth: 1 });
    assert.deepEqual(paths(shallow), [], 'на глибині 1 файлу ще не видно');
    const deeper = await ops.search('/', { query: 'main', maxDepth: 3 });
    assert.deepEqual(paths(deeper), ['/проєкт/src/main.js']);
  });

  test('too many results are cut and reported as cut', async () => {
    const result = await ops.search('/', { query: '', extensions: 'txt', limit: 1 });
    assert.equal(result.matches.length, 1);
    assert.equal(result.truncated, true, 'обрізання оголошено, а не сховано');
  });

  test('searching a file rather than a folder is refused', async () => {
    await assert.rejects(
      () => ops.search('/проєкт/readme.md', { query: 'a' }),
      (err) => err.code === 'NOT_A_DIRECTORY'
    );
  });
});

describe('search: containment', () => {
  let outside;

  before(async () => {
    outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'fsfm-outside-')));
    await fs.writeFile(path.join(outside, 'секрет.txt'), 'SECRET-OUTSIDE-ROOT\n');
  });
  after(() => fs.rm(outside, { recursive: true, force: true }));

  test('a symlink pointing out of the root is not searched', async () => {
    const link = path.join(root, 'назовні');
    await fs.symlink(outside, link, 'dir');
    try {
      const byName = await ops.search('/', { query: 'секрет' });
      assert.deepEqual(paths(byName), [], 'файл за пределами корня не найден по имени');

      const byContent = await ops.search('/', { query: 'SECRET-OUTSIDE-ROOT', scope: 'content' });
      assert.deepEqual(paths(byContent), [], 'и по содержимому тоже');
    } finally {
      await fs.rm(link, { force: true });
    }
  });

  test('a symlink loop inside the root terminates', async () => {
    const link = path.join(root, 'проєкт', 'петля');
    await fs.symlink(path.join(root, 'проєкт'), link, 'dir');
    try {
      // Without the visited-set this never returns.
      const result = await ops.search('/', { query: 'main', type: 'file' });
      assert.ok(result.matches.length >= 1);
      assert.equal(result.timedOut, false, 'поиск завершился сам, а не по таймауту');
    } finally {
      await fs.rm(link, { force: true });
    }
  });
});

describe('search: permissions', () => {
  test('content search needs the right to read files', async () => {
    const limited = new FsOps({ root, permissions: { download: false } });
    await limited.init();

    // Names are as visible as they are in a listing.
    const byName = await limited.search('/', { query: 'main' });
    assert.equal(byName.matches.length, 1);

    // Contents are not.
    await assert.rejects(
      () => limited.search('/', { query: 'TODO', scope: 'content' }),
      (err) => err.code === 'PERMISSION_DENIED' && err.status === 403
    );
    assert.equal(limited.searchCapabilities().content, false);
  });
});

describe('search: a hostile pattern', () => {
  test('a catastrophic regular expression is stopped and the server survives', async () => {
    const guarded = new FsOps({ root, searchLimits: { timeout: 500 } });
    await guarded.init();

    // `(a+)+$` against 400 a's followed by a b does not finish this century.
    // Nothing cooperative can interrupt it: only killing the thread ends it.
    let ticks = 0;
    const heartbeat = setInterval(() => {
      ticks += 1;
    }, 50);

    const started = Date.now();
    const result = await guarded.search('/', {
      query: '^(a+)+$',
      mode: 'regex',
      scope: 'content',
    });
    clearInterval(heartbeat);

    assert.equal(result.timedOut, true, 'поиск остановлен');
    assert.ok(Date.now() - started < 15000, 'и остановлен вовремя');
    // The point of the worker: the main thread kept running the whole time.
    assert.ok(ticks > 3, `основной поток не блокировался (тиков: ${ticks})`);

    // And the server still works afterwards.
    const after = await guarded.search('/', { query: 'main', type: 'file' });
    assert.deepEqual(paths(after), ['/проєкт/src/main.js']);
  });

  test('too many searches at once are refused rather than queued forever', async () => {
    const guarded = new FsOps({ root, searchLimits: { timeout: 800, maxConcurrent: 1 } });
    await guarded.init();

    const slow = guarded.search('/', { query: '^(a+)+$', mode: 'regex', scope: 'content' });
    await assert.rejects(
      () => guarded.search('/', { query: 'main' }),
      (err) => err.code === 'BUSY' && err.status === 429
    );
    await slow;
  });
});

describe('search: the route', () => {
  let server;
  let base;
  let seen;

  const start = async (options = {}) => {
    const app = express();
    app.use('/api/files', createFileManagerRouter({ root, ...options }));
    server = await new Promise((resolve) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    base = `http://127.0.0.1:${server.address().port}/api/files`;
  };
  const stop = () => new Promise((resolve) => server.close(resolve));
  after(stop);

  const get = async (qs) => {
    const response = await fetch(`${base}/search?${qs}`);
    return [response.status, await response.json()];
  };

  test('a search runs over HTTP', async () => {
    seen = [];
    await start({
      // The hook is called as (req, action, context) — the description this
      // route contributes is the third argument.
      authorize: (_req, action, context) => {
        seen.push({ action, ...context });
        return true;
      },
    });

    const [status, body] = await get('query=main&type=file');
    assert.equal(status, 200);
    assert.deepEqual(body.matches.map((match) => match.path), ['/проєкт/src/main.js']);
    assert.equal(body.path, '/');

    // The authorize hook must be told what is being searched.
    const call = seen.find((context) => context.route === '/search');
    assert.ok(call, 'хук authorize получил маршрут поиска');
    assert.equal(call.action, 'GET /search');
    assert.deepEqual(call.paths, [], 'шлях за замовчуванням — корінь, він не передається');
  });

  test('case sensitivity is off unless the parameter says otherwise', async () => {
    const [, insensitive] = await get('query=TODO-%D1%82%D0%B5%D0%BA%D0%B0');
    assert.equal(insensitive.matches.length, 1);
    const [, sensitive] = await get('query=todo-%D1%82%D0%B5%D0%BA%D0%B0&caseSensitive=1');
    assert.equal(sensitive.matches.length, 0);
  });

  test('bad input comes back as a reason, not a server error', async () => {
    const [status, body] = await get('query=(((&mode=regex');
    assert.equal(status, 400);
    assert.equal(body.code, 'INVALID_REGEX');

    const [emptyStatus, emptyBody] = await get('query=');
    assert.equal(emptyStatus, 400);
    assert.equal(emptyBody.code, 'EMPTY_QUERY');
  });

  test('the config says what a search may do here', async () => {
    const config = await (await fetch(`${base}/config`)).json();
    assert.deepEqual(config.search.modes, ['substring', 'glob', 'regex']);
    assert.equal(config.search.content, true);
    assert.equal(typeof config.search.maxResults, 'number');
  });

  test('a path outside the root is refused', async () => {
    const [status, body] = await get('path=..%2F..%2Fetc&query=passwd');
    assert.ok(status >= 400);
    assert.ok(['INVALID_PATH', 'OUTSIDE_ROOT'].includes(body.code));
  });

  test('without download, content search is refused and names still work', async () => {
    await stop();
    await start({ permissions: { download: false } });

    const [nameStatus] = await get('query=main');
    assert.equal(nameStatus, 200);

    const [contentStatus, contentBody] = await get('query=TODO&scope=content');
    assert.equal(contentStatus, 403);
    assert.equal(contentBody.code, 'PERMISSION_DENIED');

    const config = await (await fetch(`${base}/config`)).json();
    assert.equal(config.search.content, false, 'віджету сказано не пропонувати це');
  });
});

describe('search: runSearch on its own', () => {
  test('matches are streamed out as they are found', async () => {
    const batches = [];
    const result = await runSearch({
      root,
      baseAbsolute: root,
      baseVirtual: '/',
      options: normaliseSearchOptions({ query: '', extensions: 'txt,js,css,md' }),
      onBatch: (batch) => batches.push(batch.length),
    });
    // Streaming is what makes a killed search still able to return something.
    assert.ok(batches.length > 0, 'зворотний виклик відбувався під час обходу');
    assert.equal(
      batches.reduce((sum, count) => sum + count, 0),
      result.matches.length
    );
  });
});
