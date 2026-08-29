import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createTranslator } from '../src/core/i18n.js';
import en from '../src/locales/en.js';

import {
  COMMAND_NAMES,
  COMMANDS,
  columnize,
  resolvePath,
  runCommand,
  tokenize,
} from '../src/core/terminal-commands.js';

/**
 * A filesystem in a map, standing in for the provider.
 *
 * The point of testing here rather than in a browser is that the things that
 * break in a command line are argument parsing and path arithmetic, and both
 * are answerable without a DOM.
 */
function fakeProvider(tree = {}) {
  const files = new Map(Object.entries(tree));
  const calls = [];

  const entryOf = (path) => {
    const value = files.get(path);
    if (value === undefined) return null;
    const isDirectory = value === null;
    return {
      name: path.split('/').filter(Boolean).pop() ?? '',
      path,
      isDirectory,
      size: isDirectory ? null : value.length,
      modified: '2026-01-01T00:00:00.000Z',
      mode: 0o644,
      modeOctal: '644',
      executable: false,
    };
  };

  const notFound = (path) =>
    Object.assign(new Error(`Not found: ${path}`), { code: 'NOT_FOUND', status: 404 });

  return {
    calls,
    files,
    async list(path) {
      calls.push(['list', path]);
      if (!files.has(path)) throw notFound(path);
      const prefix = path === '/' ? '/' : `${path}/`;
      const items = [];
      for (const key of files.keys()) {
        if (key === path || !key.startsWith(prefix)) continue;
        if (key.slice(prefix.length).includes('/')) continue;
        items.push(entryOf(key));
      }
      return { path, items };
    },
    async stat(path) {
      calls.push(['stat', path]);
      const entry = entryOf(path);
      if (!entry) throw notFound(path);
      return entry;
    },
    async properties(path, options = {}) {
      calls.push(['properties', path, options]);
      const entry = entryOf(path);
      if (!entry) throw notFound(path);
      return { ...entry, modeText: 'rw-r--r--', totalSize: 4096, itemCount: 2 };
    },
    async tree(path, depth) {
      calls.push(['tree', path, depth]);
      return { name: 'root', path, children: [{ name: 'вкладена', path: `${path}/вкладена`, children: [] }] };
    },
    async readText(path) {
      calls.push(['readText', path]);
      const value = files.get(path);
      if (value === undefined || value === null) throw notFound(path);
      return { text: value, encoding: 'utf-8', bom: false, newline: '\n' };
    },
    async search(path, options) {
      calls.push(['search', path, options]);
      return {
        path,
        query: options.query,
        matches: [
          {
            name: 'main.js',
            path: '/src/main.js',
            parent: '/src',
            isDirectory: false,
            matchedIn: options.scope === 'content' ? 'content' : 'name',
            ...(options.scope === 'content'
              ? { lines: [{ line: 3, column: 0, length: 4, text: '  TODO: полагодити' }] }
              : {}),
          },
        ],
        scanned: 9,
        truncated: false,
        timedOut: false,
        elapsed: 1,
      };
    },
    async createDirectory(parent, name) {
      calls.push(['createDirectory', parent, name]);
      const path = parent === '/' ? `/${name}` : `${parent}/${name}`;
      files.set(path, null);
      return entryOf(path);
    },
    async createFile(parent, name, content) {
      calls.push(['createFile', parent, name, content]);
      const path = parent === '/' ? `/${name}` : `${parent}/${name}`;
      files.set(path, content ?? '');
      return entryOf(path);
    },
    async remove(paths) {
      calls.push(['remove', paths]);
      for (const path of paths) files.delete(path);
      return { removed: paths };
    },
    async move(paths, destination) {
      calls.push(['move', paths, destination]);
      return paths.map((path) => {
        const name = path.split('/').pop();
        const next = destination === '/' ? `/${name}` : `${destination}/${name}`;
        files.set(next, files.get(path) ?? null);
        files.delete(path);
        return entryOf(next);
      });
    },
    async copy(paths, destination) {
      calls.push(['copy', paths, destination]);
      return paths.map((path) => {
        const name = path.split('/').pop();
        const next = destination === '/' ? `/${name}` : `${destination}/${name}`;
        files.set(next, files.get(path) ?? null);
        return entryOf(next);
      });
    },
    async rename(path, name) {
      calls.push(['rename', path, name]);
      const parent = path.split('/').slice(0, -1).join('/') || '';
      const next = `${parent}/${name}`;
      files.set(next, files.get(path) ?? null);
      files.delete(path);
      return entryOf(next);
    },
    async chmod(paths, change) {
      calls.push(['chmod', paths, change]);
      return paths.map((path) => ({ path, modeOctal: String(change.mode) }));
    },
  };
}

// The real English translator, so these assert on what a user actually sees
// rather than on raw keys.
const t = createTranslator(en, en);

/** Run one line and give back the plain text of what it printed. */
async function run(input, { provider, cwd = '/', can = () => true, ...rest } = {}) {
  const state = { cwd, opened: null, downloaded: null, refreshed: 0, cleared: 0 };
  const result = await runCommand(input, {
    provider,
    t,
    cwd,
    width: 80,
    maxOutputLines: 500,
    can,
    setCwd: (path) => {
      state.cwd = path;
    },
    refresh: () => {
      state.refreshed += 1;
    },
    open: (entry) => {
      state.opened = entry;
    },
    download: (paths) => {
      state.downloaded = paths;
    },
    clear: () => {
      state.cleared += 1;
    },
    ...rest,
  });
  return { ...state, lines: result.lines, text: result.lines.map((item) => item.text), command: result.command };
}

const sampleTree = {
  '/': null,
  '/Документи': null,
  '/Документи/нотатка.txt': 'перша\nдруга\n',
  '/Проєкти': null,
  '/Проєкти/main.js': 'const a = 1;\n',
  '/файл із пробілом.txt': 'x\n',
};

describe('terminal: argument parsing', () => {
  test('plain words split on whitespace', () => {
    assert.deepEqual(tokenize('ls -l /дім').tokens, ['ls', '-l', '/дім']);
    assert.deepEqual(tokenize('   ls    ').tokens, ['ls']);
    assert.deepEqual(tokenize('').tokens, []);
  });

  test('quotes hold a name together', () => {
    // The whole reason this exists: `rm Мій звіт.txt` must not be two paths.
    assert.deepEqual(tokenize('rm "Мій звіт.txt"').tokens, ['rm', 'Мій звіт.txt']);
    assert.deepEqual(tokenize("rm 'Мій звіт.txt'").tokens, ['rm', 'Мій звіт.txt']);
    assert.deepEqual(tokenize('cp "а б" "в г"').tokens, ['cp', 'а б', 'в г']);
  });

  test('a backslash escapes the next character', () => {
    assert.deepEqual(tokenize('rm файл\\ із\\ пробілом').tokens, ['rm', 'файл із пробілом']);
    assert.deepEqual(tokenize('echo \\"').tokens, ['echo', '"']);
  });

  test('quotes glue to the word around them', () => {
    assert.deepEqual(tokenize('ls Документи/"файл із пробілом.txt"').tokens, [
      'ls',
      'Документи/файл із пробілом.txt',
    ]);
  });

  test('an empty quoted argument is still an argument', () => {
    assert.deepEqual(tokenize('mkdir ""').tokens, ['mkdir', '']);
  });

  test('an unterminated quote is reported, not guessed at', () => {
    assert.equal(tokenize('rm "не закрита').unterminated, true);
    assert.equal(tokenize('rm "закрита"').unterminated, false);
  });

  test("a single quote protects a backslash, the way a shell does", () => {
    assert.deepEqual(tokenize("echo 'a\\b'").tokens, ['echo', 'a\\b']);
  });
});

describe('terminal: path arithmetic', () => {
  test('relative paths resolve against where you are', () => {
    assert.equal(resolvePath('/дім', 'файл.txt'), '/дім/файл.txt');
    assert.equal(resolvePath('/', 'а/б'), '/а/б');
    assert.equal(resolvePath('/дім', './файл'), '/дім/файл');
  });

  test('absolute paths ignore where you are', () => {
    assert.equal(resolvePath('/дім/глибше', '/інше'), '/інше');
    assert.equal(resolvePath('/дім', '/'), '/');
  });

  test('.. climbs, and cannot climb past the root', () => {
    assert.equal(resolvePath('/а/б/в', '..'), '/а/б');
    assert.equal(resolvePath('/а/б/в', '../..'), '/а');
    assert.equal(resolvePath('/а', '../../../..'), '/', 'вище кореня піднятися не можна');
    assert.equal(resolvePath('/а/б', '../в/../г'), '/а/г');
  });

  test('~ is the root of the manager', () => {
    assert.equal(resolvePath('/глибоко/всередині', '~'), '/');
    assert.equal(resolvePath('/глибоко', '~/дім'), '/дім');
  });

  test('empty and dot mean here', () => {
    assert.equal(resolvePath('/дім', ''), '/дім');
    assert.equal(resolvePath('/дім', '.'), '/дім');
    assert.equal(resolvePath('/', '.'), '/');
  });

  test('extra slashes collapse', () => {
    assert.equal(resolvePath('/', '//а///б/'), '/а/б');
    assert.equal(resolvePath('/а/', 'б'), '/а/б');
  });
});

describe('terminal: ls layout', () => {
  test('names go down the columns, then across', () => {
    // Filled down each column and then across, the order `ls` uses — which is
    // what keeps an alphabetical list readable when it wraps.
    assert.deepEqual(columnize(['a', 'b', 'c', 'd', 'e', 'f'], 10), ['a  c  e', 'b  d  f']);
    // Wide enough for all six and they stay on one line.
    assert.deepEqual(columnize(['a', 'b', 'c', 'd', 'e', 'f'], 40), ['a  b  c  d  e  f']);
  });

  test('a narrow width falls back to one per line', () => {
    assert.deepEqual(columnize(['довгеім’я', 'щеодне'], 10), ['довгеім’я', 'щеодне']);
  });

  test('nothing in, nothing out', () => {
    assert.deepEqual(columnize([], 80), []);
  });
});

describe('terminal: running commands', () => {
  test('an unknown command says so instead of failing', async () => {
    const result = await run('нетака', { provider: fakeProvider(sampleTree) });
    assert.match(result.text[0], /No such command/);
    assert.equal(result.lines[0].tone, 'error');
  });

  test('an empty line does nothing at all', async () => {
    const result = await run('   ', { provider: fakeProvider(sampleTree) });
    assert.deepEqual(result.text, []);
    assert.equal(result.command, null);
  });

  test('ls lists, with folders first and columns aligned', async () => {
    const result = await run('ls', { provider: fakeProvider(sampleTree) });
    assert.equal(result.text.length, 1);
    assert.deepEqual(result.text[0].split(/\s{2,}/), [
      'Документи/',
      'Проєкти/',
      'файл із пробілом.txt',
    ]);
    // Padded to the longest name, so the names line up under each other.
    assert.match(result.text[0], /^Документи\/ {2,}/);
  });

  test('ls -l shows the details', async () => {
    const result = await run('ls -l /Документи', { provider: fakeProvider(sampleTree) });
    assert.equal(result.text.length, 1);
    assert.match(result.text[0], /нотатка\.txt$/);
    assert.match(result.text[0], /644/);
  });

  test('cd moves the prompt and checks the folder is one', async () => {
    const provider = fakeProvider(sampleTree);
    const moved = await run('cd Проєкти', { provider });
    assert.equal(moved.cwd, '/Проєкти');

    const file = await run('cd /Документи/нотатка.txt', { provider });
    assert.match(file.text[0], /Not a folder/);
    assert.equal(file.cwd, '/', 'після відмови запрошення не зсунулося');
  });

  test('cd .. climbs', async () => {
    const result = await run('cd ..', { provider: fakeProvider(sampleTree), cwd: '/Документи' });
    assert.equal(result.cwd, '/');
  });

  test('cat prints the file', async () => {
    const result = await run('cat /Документи/нотатка.txt', { provider: fakeProvider(sampleTree) });
    assert.deepEqual(result.text, ['перша', 'друга', '']);
  });

  test('cat on a missing file reports the reason', async () => {
    const result = await run('cat /немає.txt', { provider: fakeProvider(sampleTree) });
    assert.equal(result.lines[0].tone, 'error');
    assert.match(result.text[0], /Not found/);
  });

  test('a name with spaces survives quoting all the way to the provider', async () => {
    const provider = fakeProvider(sampleTree);
    await run('cat "/файл із пробілом.txt"', { provider });
    assert.deepEqual(
      provider.calls.find((call) => call[0] === 'readText'),
      ['readText', '/файл із пробілом.txt']
    );
  });

  test('mkdir and touch create where the prompt is', async () => {
    const provider = fakeProvider(sampleTree);
    const made = await run('mkdir "нова тека"', { provider, cwd: '/Проєкти' });
    assert.deepEqual(provider.calls.at(-1).slice(0, 3), ['createDirectory', '/Проєкти', 'нова тека']);
    assert.equal(made.refreshed, 1, 'список оновлено');

    await run('touch підтека/файл.txt', { provider, cwd: '/Проєкти' });
    assert.deepEqual(provider.calls.at(-1).slice(0, 3), ['createFile', '/Проєкти/підтека', 'файл.txt']);
  });

  test('rm refuses to delete the root', async () => {
    const provider = fakeProvider(sampleTree);
    const result = await run('rm /', { provider });
    assert.match(result.text[0], /root cannot be deleted/);
    assert.ok(!provider.calls.some((call) => call[0] === 'remove'));
  });

  test('rm passes several paths at once', async () => {
    const provider = fakeProvider(sampleTree);
    await run('rm Проєкти "файл із пробілом.txt"', { provider });
    assert.deepEqual(provider.calls.at(-1), ['remove', ['/Проєкти', '/файл із пробілом.txt']]);
  });

  test('cp into an existing folder copies', async () => {
    const provider = fakeProvider(sampleTree);
    await run('cp /Проєкти/main.js /Документи', { provider });
    assert.deepEqual(provider.calls.at(-1), ['copy', ['/Проєкти/main.js'], '/Документи']);
  });

  test('cp to something that is not a folder is refused', async () => {
    const provider = fakeProvider(sampleTree);
    const result = await run('cp /Проєкти/main.js /Документи/новое.js', { provider });
    assert.match(result.text[0], /Not a folder/);
    assert.ok(!provider.calls.some((call) => call[0] === 'copy'));
  });

  test('mv into a folder moves, and to a name renames', async () => {
    const provider = fakeProvider(sampleTree);
    await run('mv /Проєкти/main.js /Документи', { provider });
    assert.deepEqual(provider.calls.at(-1), ['move', ['/Проєкти/main.js'], '/Документи']);

    const renamed = await run('mv /Документи/main.js /Документи/index.js', { provider });
    assert.deepEqual(provider.calls.at(-1), ['rename', '/Документи/main.js', 'index.js']);
    assert.match(renamed.text[0], /→ \/Документи\/index\.js/);
  });

  test('mv across folders with a new name is a move and then a rename', async () => {
    // The API has no single call for it; doing it in two is better than
    // refusing, as long as a half-done result says so.
    const provider = fakeProvider(sampleTree);
    await run('mv /Проєкти/main.js /Документи/иначе.js', { provider });
    const kinds = provider.calls.map((call) => call[0]);
    assert.ok(kinds.includes('move') && kinds.includes('rename'));
  });

  test('mv of several things needs a folder to put them in', async () => {
    const result = await run('mv a b /Документи/файл.txt', { provider: fakeProvider(sampleTree) });
    assert.match(result.text[0], /only be moved into a folder/);
  });

  test('chmod checks the mode before sending it', async () => {
    const provider = fakeProvider(sampleTree);
    const bad = await run('chmod rwx /Проєкти', { provider });
    assert.match(bad.text[0], /octal number/);
    assert.ok(!provider.calls.some((call) => call[0] === 'chmod'));

    await run('chmod 755 /Проєкти', { provider });
    assert.deepEqual(provider.calls.at(-1), ['chmod', ['/Проєкти'], { mode: '755' }]);
  });

  test('find searches by mask, grep by content', async () => {
    const provider = fakeProvider(sampleTree);
    const found = await run('find *.js', { provider, cwd: '/Проєкти' });
    assert.deepEqual(provider.calls.at(-1), ['search', '/Проєкти', { query: '*.js', mode: 'glob' }]);
    assert.deepEqual(found.text, ['/src/main.js']);

    const grepped = await run('grep TODO /', { provider });
    assert.deepEqual(provider.calls.at(-1)[2].scope, 'content');
    assert.deepEqual(grepped.text, ['/src/main.js:3: TODO: полагодити']);
  });

  test('open and download hand off to the widget', async () => {
    const provider = fakeProvider(sampleTree);
    const opened = await run('open /Проєкти/main.js', { provider });
    assert.equal(opened.opened.path, '/Проєкти/main.js');

    const downloaded = await run('download Проєкти Документи', { provider });
    assert.deepEqual(downloaded.downloaded, ['/Проєкти', '/Документи']);
  });

  test('clear empties the screen', async () => {
    const result = await run('clear', { provider: fakeProvider(sampleTree) });
    assert.equal(result.cleared, 1);
    assert.deepEqual(result.text, []);
  });

  test('help lists every command, and explains one', async () => {
    const all = await run('help', { provider: fakeProvider(sampleTree) });
    for (const name of COMMAND_NAMES) {
      assert.ok(all.text.some((row) => row.includes(name)), `${name} згадана в help`);
    }
    // Said plainly, because the difference matters to whoever deploys this.
    assert.ok(all.text.some((row) => row.includes('not a system shell')));

    const one = await run('help mv', { provider: fakeProvider(sampleTree) });
    assert.equal(one.text[0], t(COMMANDS.mv.usageKey));
  });
});

describe('terminal: permissions', () => {
  test('a command that writes is refused when the permission is off', async () => {
    const provider = fakeProvider(sampleTree);
    const can = (action) => action !== 'remove';

    const result = await run('rm /Проєкти', { provider, can });
    assert.match(result.text[0], /“remove”/);
    assert.equal(result.lines[0].tone, 'error');
    // Refused here, so the request is never made — the server would refuse it
    // too, but a terminal that says why is the point.
    assert.ok(!provider.calls.some((call) => call[0] === 'remove'));
  });

  test('reading commands stay available in a read-only manager', async () => {
    const result = await run('ls', { provider: fakeProvider(sampleTree), can: () => false });
    assert.deepEqual(result.text[0].split(/\s{2,}/), [
      'Документи/',
      'Проєкти/',
      'файл із пробілом.txt',
    ]);
  });

  test('every writing command declares which permission it needs', () => {
    const writes = ['mkdir', 'touch', 'rm', 'cp', 'mv', 'chmod', 'download'];
    for (const name of writes) {
      assert.ok(COMMANDS[name].needs, `${name} оголошує право`);
    }
    for (const name of ['ls', 'cd', 'cat', 'pwd', 'find', 'grep', 'stat', 'tree', 'help', 'clear']) {
      assert.equal(COMMANDS[name].needs, undefined, `${name} ничего не пишет`);
    }
  });
});

describe('terminal: it never throws', () => {
  test('a provider that fails every call still produces output', async () => {
    const angry = new Proxy(
      {},
      {
        get: () => async () => {
          throw new Error('сервер недоступен');
        },
      }
    );
    for (const name of COMMAND_NAMES) {
      const result = await run(`${name} а б`, { provider: angry });
      assert.ok(Array.isArray(result.lines), `${name} вернула строки, а не исключение`);
    }
  });

  test('an unterminated quote is an error line, not a crash', async () => {
    const result = await run('rm "не закрита', { provider: fakeProvider(sampleTree) });
    assert.match(result.text[0], /Unclosed quote/);
  });
});
