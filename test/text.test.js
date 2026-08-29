import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createFileManagerRouter } from '../server/router.js';
import { detectNewline, looksBinary, readTextFile, serializeText } from '../server/text.js';
import {
  LANGUAGE_IDS,
  TEXT_EXTENSIONS,
  highlight,
  languageLabel,
  languageOf,
} from '../src/ui/highlight.js';

/** Every extension the feature was asked to cover. */
const REQUESTED = [
  'txt', 'json', 'xml', 'html', 'md', 'sh', 'py', 'yaml', 'htm', 'php',
  'css', 'js', 'scss', 'sass', 'less', 'styl', 'ts', 'tsx',
  'd.ts', 'd.mts', 'd.cts', 'mts', 'cts',
];

/** Strip the markup back to `[type:text]` so a test can assert on tokens. */
function tokens(html) {
  const found = [];
  const pattern = /<span class="fsfm-tok-(\w+)">([\s\S]*?)<\/span>/g;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    found.push([match[1], match[2]]);
  }
  return found;
}

const hasToken = (html, type, text) =>
  tokens(html).some(([kind, value]) => kind === type && value === text);

describe('code: every requested extension is recognised', () => {
  test('all of them map to a language', () => {
    const missing = REQUESTED.filter((extension) => !languageOf(`file.${extension}`));
    assert.deepEqual(missing, [], `не розпізнано: ${missing.join(', ')}`);
  });

  test('a double extension beats the single one it ends with', () => {
    // The same trap as tar.gz against gz: matching the short spelling first
    // labels every declaration file as something it is not.
    assert.equal(languageOf('types.d.ts'), 'ts');
    assert.equal(languageOf('types.d.mts'), 'ts');
    assert.equal(languageOf('types.d.cts'), 'ts');
    assert.equal(languageOf('plain.ts'), 'ts');
    assert.equal(languageOf('mod.mts'), 'ts');
  });

  test('htm and html are the same language, tsx is its own', () => {
    assert.equal(languageOf('a.htm'), 'html');
    assert.equal(languageOf('a.html'), 'html');
    assert.equal(languageOf('a.tsx'), 'tsx');
  });

  test('yml is accepted alongside yaml', () => {
    // The commoner spelling by far; leaving it out would drop most real
    // config files through to plain text.
    assert.equal(languageOf('ci.yml'), 'yaml');
    assert.equal(languageOf('ci.yaml'), 'yaml');
  });

  test('a binary name is not claimed', () => {
    assert.equal(languageOf('photo.png'), null);
    assert.equal(languageOf('archive.zip'), null);
  });

  test('every language id has a label', () => {
    for (const id of LANGUAGE_IDS) {
      assert.ok(languageLabel(id).length > 0, id);
    }
    assert.ok(TEXT_EXTENSIONS.length >= REQUESTED.length);
  });
});

describe('code: tokenising', () => {
  test('the source always survives, escaped, whatever the rules do', () => {
    // The one property that must hold for every input: what goes in comes out.
    const source = 'const a = "<b & c>"; // <!-- x\n';
    for (const language of LANGUAGE_IDS) {
      const stripped = highlight(source, language)
        .replace(/<span class="fsfm-tok-\w+">/g, '')
        .replace(/<\/span>/g, '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
      assert.equal(stripped, source, `${language} потерял или исказил текст`);
    }
  });

  test('html in the source is escaped, never emitted as markup', () => {
    const html = highlight('<script>alert(1)</script>', 'txt');
    assert.ok(!html.includes('<script'), 'розмітка не має потрапляти у вивід');
    assert.ok(html.includes('&lt;script&gt;'));
  });

  test('a regex is told apart from division', () => {
    // Undecidable without parsing; the heuristic looks at what precedes the
    // slash, and getting it wrong swallows the rest of the line.
    const html = highlight('const re = /ab+c/gi;\nconst half = total / 2;', 'js');
    assert.ok(hasToken(html, 'string', '/ab+c/gi'), 'регулярний вираз');
    assert.ok(hasToken(html, 'operator', '/'), 'деление');
  });

  test('multi-line constructs span lines', () => {
    assert.ok(hasToken(highlight('/* a\nb */', 'js'), 'comment', '/* a\nb */'));
    assert.ok(hasToken(highlight('x = `a\nb`', 'js'), 'string', '`a\nb`'));
    assert.ok(hasToken(highlight('"""doc\nstring"""', 'py'), 'string', '"""doc\nstring"""'));
  });

  test('an unterminated construct does not swallow past the end', () => {
    // Half-typed code is what an editor shows most of the time.
    const html = highlight('const s = "unfinished', 'js');
    assert.ok(hasToken(html, 'string', '"unfinished'));
    assert.ok(hasToken(html, 'keyword', 'const'));
  });

  test('each family colours what it should', () => {
    assert.ok(hasToken(highlight('{"k": 1}', 'json'), 'property', '"k"'));
    assert.ok(hasToken(highlight('<a href="x">', 'html'), 'attr', 'href'));
    assert.ok(hasToken(highlight('.a { color: red }', 'css'), 'property', 'color'));
    assert.ok(hasToken(highlight('$c: red;', 'scss'), 'variable', '$c'));
    assert.ok(hasToken(highlight('# Заголовок', 'md'), 'heading', '# Заголовок'));
    assert.ok(hasToken(highlight('key: value', 'yaml'), 'property', 'key'));
    assert.ok(hasToken(highlight('echo "$x"', 'sh'), 'string', '"$x"'));
    assert.ok(hasToken(highlight('def f(): pass', 'py'), 'keyword', 'def'));
    assert.ok(hasToken(highlight('<?php $x = 1;', 'php'), 'variable', '$x'));
    assert.ok(hasToken(highlight('type Id = string', 'ts'), 'type', 'string'));
  });

  test('plain text is escaped and otherwise left alone', () => {
    assert.equal(highlight('просто текст', 'txt'), 'просто текст');
    assert.equal(tokens(highlight('просто текст', 'txt')).length, 0);
  });

  test('a large file is tokenised in reasonable time', () => {
    const source = 'const value = "строка"; // комментарий\n'.repeat(4000);
    const started = Date.now();
    highlight(source, 'js');
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 3000, `${elapsed} мс на ${source.length} символов`);
  });
});

describe('text: what has to survive a round trip', () => {
  let dir;
  before(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'fsfm-text-')));
  });
  after(() => fs.rm(dir, { recursive: true, force: true }));

  test('binary content is refused rather than shown as mojibake', async () => {
    // The decoder falls back to windows-1252, which maps every byte — without
    // the NUL check a JPEG would "open" as megabytes of nonsense.
    assert.equal(looksBinary(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d])), true);
    assert.equal(looksBinary(Buffer.from('звичайний текст', 'utf8')), false);

    const file = path.join(dir, 'photo.png');
    await fs.writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a]));
    await assert.rejects(readTextFile(file), (err) => err.code === 'NOT_TEXT');
  });

  test('a UTF-16 file is text despite being full of NUL bytes', () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('привет', 'utf16le')]);
    assert.equal(looksBinary(utf16), false);
  });

  test('line endings are detected and put back', async () => {
    assert.deepEqual(detectNewline('a\r\nb\r\n'), { newline: '\r\n', mixed: false });
    assert.deepEqual(detectNewline('a\nb\n'), { newline: '\n', mixed: false });
    assert.deepEqual(detectNewline('a\r\nb\n'), { newline: '\r\n', mixed: true });

    const file = path.join(dir, 'crlf.txt');
    await fs.writeFile(file, 'один\r\nдва\r\n');
    const read = await readTextFile(file);
    assert.equal(read.newline, '\r\n');
    // The editor works in one kind of ending; the file keeps its own.
    assert.equal(read.text, 'один\nдва\n');

    const { buffer } = serializeText(read.text, read);
    assert.equal(buffer.toString('utf8'), 'один\r\nдва\r\n');
  });

  test('a byte-order mark is preserved', async () => {
    const file = path.join(dir, 'bom.txt');
    await fs.writeFile(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('текст', 'utf8')]));
    const read = await readTextFile(file);
    assert.equal(read.bom, true);
    assert.equal(read.text, 'текст');
    assert.equal(serializeText(read.text, read).buffer[0], 0xef);
  });

  test('an encoding Node cannot write is reported, not applied silently', async () => {
    const file = path.join(dir, 'cp1251.txt');
    await fs.writeFile(file, Buffer.from([0xf2, 0xee, 0xe2, 0xe0, 0xf0]));
    const read = await readTextFile(file);
    assert.equal(read.encoding, 'windows-1251');
    assert.equal(read.text, 'товар');

    const { rewritten } = serializeText(read.text, read);
    assert.equal(rewritten, 'utf-8');
  });

  test('a file past the limit is refused with a usable message', async () => {
    const file = path.join(dir, 'big.txt');
    await fs.writeFile(file, 'x'.repeat(4096));
    await assert.rejects(
      readTextFile(file, { limits: { maxBytes: 1024, sniffBytes: 512 } }),
      (err) => err.code === 'TEXT_TOO_LARGE' && err.status === 413
    );
  });
});

describe('text: the routes', () => {
  let server;
  let base;
  let root;

  const start = async (options = {}) => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'fsfm-text-http-')));
    const app = express();
    app.use('/api/files', createFileManagerRouter({ root, ...options }));
    server = await new Promise((resolve) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    base = `http://127.0.0.1:${server.address().port}/api/files`;
  };
  const stop = async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  };
  after(stop);

  const save = (body) =>
    fetch(`${base}/text/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  test('a file is read and written back over HTTP', async () => {
    await start();
    await fs.writeFile(path.join(root, 'app.ts'), 'const a: number = 1;\n');

    const opened = await (await fetch(`${base}/text?path=/app.ts`)).json();
    assert.equal(opened.name, 'app.ts');
    assert.equal(opened.text, 'const a: number = 1;\n');
    assert.equal(opened.encoding, 'utf-8');

    const result = await (await save({ path: '/app.ts', text: 'const a: number = 2;\n' })).json();
    assert.equal(result.path, '/app.ts');
    assert.equal(await fs.readFile(path.join(root, 'app.ts'), 'utf8'), 'const a: number = 2;\n');
  });

  test('the file keeps its CRLF endings through an edit', async () => {
    await fs.writeFile(path.join(root, 'win.txt'), 'один\r\nдва\r\n');
    const opened = await (await fetch(`${base}/text?path=/win.txt`)).json();
    await save({
      path: '/win.txt',
      text: `${opened.text}три\n`,
      encoding: opened.encoding,
      bom: opened.bom,
      newline: opened.newline,
    });
    // Re-writing a CRLF file as LF turns a one-line edit into a whole-file diff.
    assert.equal(await fs.readFile(path.join(root, 'win.txt'), 'utf8'), 'один\r\nдва\r\nтри\r\n');
  });

  test('a binary file is refused', async () => {
    await fs.writeFile(path.join(root, 'blob.bin'), Buffer.from([1, 2, 0, 3]));
    const response = await fetch(`${base}/text?path=/blob.bin`);
    assert.equal(response.status, 415);
    assert.equal((await response.json()).code, 'NOT_TEXT');
  });

  test('a failed save leaves the original untouched', async () => {
    const before = await fs.readFile(path.join(root, 'app.ts'), 'utf8');
    const response = await save({ path: '/app.ts', text: 12345 });
    assert.equal(response.status, 400);
    // The write goes through a temporary name and a rename.
    assert.equal(await fs.readFile(path.join(root, 'app.ts'), 'utf8'), before);
  });

  test('a path outside the root is refused', async () => {
    assert.equal((await fetch(`${base}/text?path=/../../etc/passwd`)).status, 400);
    assert.equal((await save({ path: '/../../tmp/x.txt', text: 'x' })).status, 400);
  });

  test('a size limit is enforced on the way in and out', async () => {
    await stop();
    await start({ textLimits: { maxBytes: 64 } });
    await fs.writeFile(path.join(root, 'big.txt'), 'x'.repeat(200));

    assert.equal((await fetch(`${base}/text?path=/big.txt`)).status, 413);
    assert.equal((await save({ path: '/other.txt', text: 'y'.repeat(200) })).status, 413);
  });

  test('withholding edit closes the feature', async () => {
    await stop();
    await start({ permissions: { edit: false } });
    await fs.writeFile(path.join(root, 'a.txt'), 'x');

    assert.equal((await fetch(`${base}/text?path=/a.txt`)).status, 403);
    assert.equal((await save({ path: '/a.txt', text: 'y' })).status, 403);
  });

  test('a text file is no longer claimed by the spreadsheet reader', async () => {
    await stop();
    await start();
    const config = await (await fetch(`${base}/config`)).json();
    // `.txt` used to sit in the csv extension list, which sent every note and
    // readme to the grid instead of the code editor.
    assert.ok(!config.sheetFormats.csv.extensions.includes('txt'));
    assert.ok(config.sheetFormats.csv.extensions.includes('csv'));
  });
});
