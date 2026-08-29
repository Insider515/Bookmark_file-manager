import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createFileManagerRouter } from '../server/router.js';
import {
  DOCUMENT_FORMATS,
  DocumentService,
  documentFormatOf,
} from '../server/doc/index.js';
import { readDocx, updateDocx, writeDocx } from '../server/doc/docx.js';
import { readOdt, updateOdt, writeOdt } from '../server/doc/odt.js';
import { readDoc, writeDoc } from '../server/doc/doc.js';
import { readPdf, writePdfPages, PdfDocument } from '../server/doc/pdf/index.js';
import { Lexer, decodeStream, serialize } from '../server/doc/pdf/objects.js';
import {
  blockText,
  documentText,
  isPristine,
  makeRun,
  normaliseRuns,
  runsEqual,
} from '../server/doc/model.js';
import { buildCompoundFileFrom, CompoundFile } from '../server/sheet/cfb.js';

let workdir;
let service;

before(async () => {
  workdir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'fsfm-doc-')));
  service = new DocumentService();
});
after(() => fs.rm(workdir, { recursive: true, force: true }));

const at = (name) => path.join(workdir, name);

/** A document with one of everything this model can express. */
function sampleDocument() {
  return {
    blocks: [
      { type: 'heading', level: 1, runs: [makeRun('Звіт за квартал')] },
      {
        type: 'paragraph',
        runs: [
          makeRun('Звичайний абзац із '),
          makeRun('жирним', { bold: true }),
          makeRun(', '),
          makeRun('курсивом', { italic: true }),
          makeRun(' і '),
          makeRun('підкресленим', { underline: true }),
          makeRun('.'),
        ],
      },
      { type: 'heading', level: 2, runs: [makeRun('Підрозділ')] },
      { type: 'listItem', level: 1, runs: [makeRun('Перший пункт')] },
      { type: 'listItem', level: 1, runs: [makeRun('Другий пункт')] },
      { type: 'paragraph', runs: [makeRun('Рядок один\nрядок два')] },
    ],
    meta: {},
  };
}

const marksOf = (runs) =>
  runs
    .filter((run) => run.bold || run.italic || run.underline)
    .map((run) => `${run.bold ? 'b' : ''}${run.italic ? 'i' : ''}${run.underline ? 'u' : ''}:${run.text}`);

describe('document: the block model', () => {
  test('adjacent runs with the same marks are merged', () => {
    const runs = normaliseRuns([
      makeRun('раз'),
      makeRun('два'),
      makeRun('три', { bold: true }),
      makeRun('чотири', { bold: true }),
    ]);
    assert.deepEqual(runs.map((run) => run.text), ['раздва', 'тричотири']);
    assert.deepEqual(runs.map((run) => Boolean(run.bold)), [false, true]);
  });

  test('empty runs disappear but a block never becomes runless', () => {
    assert.deepEqual(normaliseRuns([]), [{ text: '' }]);
    assert.deepEqual(normaliseRuns([makeRun('')]), [{ text: '' }]);
  });

  test('runsEqual compares marks, not only text', () => {
    assert.ok(runsEqual([makeRun('a', { bold: true })], [makeRun('a', { bold: true })]));
    assert.ok(!runsEqual([makeRun('a', { bold: true })], [makeRun('a')]));
    assert.ok(!runsEqual([makeRun('a')], [makeRun('a'), makeRun('b')]));
  });

  test('a block is pristine only while it still matches its source markup', () => {
    const block = {
      type: 'paragraph',
      raw: '<w:p/>',
      runs: [makeRun('текст')],
      original: [makeRun('текст')],
    };
    assert.ok(isPristine(block));

    block.runs = [makeRun('інший текст')];
    assert.ok(!isPristine(block), 'змінений текст робить блок невихідним');

    block.runs = [makeRun('текст', { bold: true })];
    assert.ok(!isPristine(block), 'змінене накреслення — теж зміна');

    // Without source markup there is nothing to preserve, whatever the runs say.
    assert.ok(!isPristine({ runs: [makeRun('a')], original: [makeRun('a')] }));
  });

  test('documentText joins blocks by line', () => {
    assert.equal(
      documentText({ blocks: [{ runs: [makeRun('раз')] }, { runs: [makeRun('два')] }] }),
      'раз\nдва'
    );
  });
});

describe('document: docx', () => {
  test('a written document reads back with its structure and marks', async () => {
    const file = at('sample.docx');
    await writeDocx(sampleDocument(), file);
    const read = await readDocx(file);

    assert.deepEqual(
      read.blocks.map((block) => block.type),
      ['heading', 'paragraph', 'heading', 'listItem', 'listItem', 'paragraph']
    );
    assert.equal(read.blocks[0].level, 1);
    assert.equal(read.blocks[2].level, 2);
    assert.equal(blockText(read.blocks[0]), 'Звіт за квартал');
    assert.deepEqual(marksOf(read.blocks[1].runs), ['b:жирним', 'i:курсивом', 'u:підкресленим']);
    // A line break inside a paragraph is content, not a block boundary.
    assert.equal(blockText(read.blocks[5]), 'Рядок один\nрядок два');
  });

  test('editing one paragraph leaves the rest of the package byte for byte', async () => {
    const file = at('preserve.docx');
    await writeDocx(sampleDocument(), file);

    const read = await readDocx(file);
    const untouched = read.blocks[1].raw;
    read.blocks[0].runs = [makeRun('Новий заголовок')];

    const out = at('preserve-out.docx');
    await updateDocx({ ...read, blocks: read.blocks }, file, out);

    const again = await readDocx(out);
    assert.equal(blockText(again.blocks[0]), 'Новий заголовок');
    assert.equal(again.blocks[0].type, 'heading', 'правка тексту не скидає стиль');
    assert.equal(again.blocks[1].raw, untouched, 'сусідній абзац переписано дослівно');
    assert.deepEqual(marksOf(again.blocks[1].runs), ['b:жирним', 'i:курсивом', 'u:підкресленим']);
  });

  test('unmodelled body elements survive a save', async () => {
    const file = at('opaque.docx');
    await writeDocx(sampleDocument(), file);

    // Splice a table into the body: the writer never produces one, so this is
    // the only way to prove the reader carries it across untouched.
    const { ZipArchive } = await import('../server/archive/zip-read.js');
    const archive = await ZipArchive.open(file);
    const entry = archive.entries.find((item) => item.name === 'word/document.xml');
    const chunks = [];
    for await (const chunk of await archive.createEntryStream(entry)) chunks.push(chunk);
    await archive.close();

    const table = '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>комірка</w:t></w:r></w:p></w:tc></w:tr></w:tbl>';
    const xml = Buffer.concat(chunks).toString('utf8').replace('</w:body>', `${table}</w:body>`);

    const { createZipStream } = await import('../server/zip.js');
    const { pipeline } = await import('node:stream/promises');
    const { createWriteStream } = await import('node:fs');
    const withTable = at('with-table.docx');
    await pipeline(
      createZipStream([
        { relative: 'word/document.xml', content: Buffer.from(xml, 'utf8') },
        {
          relative: '[Content_Types].xml',
          content: Buffer.from(
            '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
            'utf8'
          ),
        },
      ]),
      createWriteStream(withTable)
    );

    const read = await readDocx(withTable);
    const opaque = read.blocks.find((block) => block.type === 'opaque' && block.name === 'tbl');
    assert.ok(opaque, 'таблицю прочитано як непрозорий блок');

    read.blocks[0].runs = [makeRun('Правка')];
    const out = at('with-table-out.docx');
    await updateDocx(read, withTable, out);
    const again = await readDocx(out);
    assert.ok(
      again.blocks.some((block) => block.name === 'tbl' && block.raw.includes('комірка')),
      'таблиця пережила правку сусіднього абзацу'
    );
  });
});

describe('document: odt', () => {
  test('a written document reads back with its structure and marks', async () => {
    const file = at('sample.odt');
    await writeOdt(sampleDocument(), file);
    const read = await readOdt(file);

    const visible = read.blocks.filter((block) => !block.hidden);
    assert.deepEqual(
      visible.map((block) => block.type),
      ['heading', 'paragraph', 'heading', 'listItem', 'listItem', 'paragraph']
    );
    assert.equal(blockText(visible[0]), 'Звіт за квартал');
    assert.deepEqual(marksOf(visible[1].runs), ['b:жирним', 'i:курсивом', 'u:підкресленим']);
  });

  test('a span carries no formatting of its own — the style table decides', async () => {
    const file = at('styles.odt');
    await writeOdt(
      { blocks: [{ type: 'paragraph', runs: [makeRun('жирний', { bold: true })] }], meta: {} },
      file
    );

    const { ZipArchive } = await import('../server/archive/zip-read.js');
    const archive = await ZipArchive.open(file);
    const entry = archive.entries.find((item) => item.name === 'content.xml');
    const chunks = [];
    for await (const chunk of await archive.createEntryStream(entry)) chunks.push(chunk);
    await archive.close();
    const xml = Buffer.concat(chunks).toString('utf8');

    assert.match(xml, /<text:span text:style-name="FSFM_B">жирний<\/text:span>/);
    assert.match(xml, /style:name="FSFM_B"[\s\S]*?fo:font-weight="bold"/);
  });

  test('editing one paragraph keeps the others and the package', async () => {
    const file = at('preserve.odt');
    await writeOdt(sampleDocument(), file);

    const read = await readOdt(file);
    const target = read.blocks.findIndex((block) => blockText(block) === 'Звіт за квартал');
    read.blocks[target].runs = [makeRun('Новий заголовок')];

    const out = at('preserve-out.odt');
    await updateOdt(read, file, out);
    const again = await readOdt(out);
    const visible = again.blocks.filter((block) => !block.hidden);

    assert.equal(blockText(visible[0]), 'Новий заголовок');
    assert.equal(visible[0].type, 'heading');
    assert.deepEqual(marksOf(visible[1].runs), ['b:жирним', 'i:курсивом', 'u:підкресленим']);
    assert.deepEqual(
      visible.filter((block) => block.type === 'listItem').map((block) => blockText(block)),
      ['Перший пункт', 'Другий пункт'],
      'список пережив правку'
    );
  });

  test('the mimetype entry is written first and uncompressed', async () => {
    const file = at('mimetype.odt');
    await writeOdt(sampleDocument(), file);
    const buffer = await fs.readFile(file);
    // A reader identifies an ODF package by these bytes at a fixed offset.
    assert.equal(buffer.toString('latin1', 30, 38), 'mimetype');
    assert.equal(
      buffer.toString('latin1', 38, 38 + 39),
      'application/vnd.oasis.opendocument.text'
    );
  });
});

describe('document: doc', () => {
  test('a written document reads back with its structure and marks', async () => {
    const file = at('sample.doc');
    const { warnings } = await writeDoc(sampleDocument(), file);
    assert.ok(
      warnings.some((line) => line.includes('numbering table')),
      'the loss of list markers is reported'
    );

    const read = await readDoc(file);
    assert.equal(read.meta.format, 'doc');
    // Headings survive as headings; list items become indented paragraphs,
    // which is what a .doc without a numbering table can carry.
    assert.deepEqual(
      read.blocks.map((block) => block.type),
      ['heading', 'paragraph', 'heading', 'paragraph', 'paragraph', 'paragraph']
    );
    assert.equal(blockText(read.blocks[0]), 'Звіт за квартал');
    assert.equal(read.blocks[0].type, 'heading');
    assert.equal(read.blocks[0].level, 1);
    assert.equal(read.blocks[2].level, 2);
    assert.deepEqual(marksOf(read.blocks[1].runs), ['b:жирним', 'i:курсивом', 'u:підкресленим']);
  });

  test('the container really is OLE2, with the two streams Word needs', async () => {
    const file = at('container.doc');
    await writeDoc(sampleDocument(), file);
    const buffer = await fs.readFile(file);

    assert.ok(CompoundFile.isCompoundFile(buffer));
    const container = new CompoundFile(buffer);
    assert.ok(container.read('WordDocument'), 'потік WordDocument на місці');
    assert.ok(container.read('1Table'), 'потік 1Table на місці');
    // The signature Word looks for before reading anything else.
    assert.equal(container.read('WordDocument').readUInt16LE(0), 0xa5ec);
  });

  test('a file that is not a Word document is refused, not misread', async () => {
    const file = at('not.doc');
    await fs.writeFile(file, 'просто текст');
    await assert.rejects(() => readDoc(file), (err) => err.code === 'NOT_A_DOC');

    // An OLE2 container that is not a .doc: right envelope, wrong contents.
    const spreadsheet = at('wrong.doc');
    await fs.writeFile(spreadsheet, buildCompoundFileFrom([{ name: 'Workbook', content: Buffer.alloc(64) }]));
    await assert.rejects(() => readDoc(spreadsheet), (err) => err.code === 'NOT_A_DOC');
  });

  test('a password-protected document is refused rather than read as noise', async () => {
    const file = at('locked.doc');
    await writeDoc(sampleDocument(), file);
    const buffer = await fs.readFile(file);
    const container = new CompoundFile(buffer);
    const word = Buffer.from(container.read('WordDocument'));
    word.writeUInt16LE(word.readUInt16LE(0x0a) | 0x0100, 0x0a); // fEncrypted

    await fs.writeFile(
      file,
      buildCompoundFileFrom([
        { name: 'WordDocument', content: word },
        { name: '1Table', content: container.read('1Table') },
      ])
    );
    await assert.rejects(() => readDoc(file), (err) => err.code === 'DOC_ENCRYPTED');
  });
});

describe('document: the OLE2 writer with several streams', () => {
  test('every stream comes back, whichever allocation it landed in', async () => {
    const small = Buffer.from('малий потік', 'utf8');
    const large = Buffer.alloc(9000, 0x41);
    const buffer = buildCompoundFileFrom([
      { name: 'WordDocument', content: large },
      { name: '1Table', content: small },
      { name: 'Data', content: Buffer.alloc(0) },
    ]);

    const container = new CompoundFile(buffer);
    assert.equal(container.read('1Table').toString('utf8'), 'малий потік');
    assert.equal(container.read('WordDocument').length, 9000);
    assert.ok(container.read('WordDocument').every((byte) => byte === 0x41));
    assert.equal(container.read('Data').length, 0);
    assert.equal(container.read('Відсутній'), null);
  });
});

describe('document: pdf', () => {
  /** A minimal but real PDF: two pages, one font, text on each. */
  async function makePdf(file, pages = 2) {
    const objects = [];
    const push = (body) => {
      objects.push(body);
      return objects.length;
    };
    const font = push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const kids = [];
    for (let i = 0; i < pages; i += 1) {
      const text = `BT /F1 24 Tf 72 700 Td (Page ${i + 1} text) Tj ET`;
      const content = push(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`);
      kids.push(push(
        `<< /Type /Page /Parent 999 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`
      ));
    }
    const pagesNum = push(
      `<< /Type /Pages /Kids [${kids.map((num) => `${num} 0 R`).join(' ')}] /Count ${kids.length} >>`
    );
    const catalog = push(`<< /Type /Catalog /Pages ${pagesNum} 0 R >>`);

    let out = '%PDF-1.4\n';
    const offsets = [];
    objects.forEach((body, index) => {
      offsets[index + 1] = out.length;
      out += `${index + 1} 0 obj\n${body.replace('999 0 R', `${pagesNum} 0 R`)}\nendobj\n`;
    });
    const xref = out.length;
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (let i = 1; i <= objects.length; i += 1) {
      out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
    }
    out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    await fs.writeFile(file, Buffer.from(out, 'latin1'));
  }

  test('objects parse, including the awkward corners', () => {
    const read = (source) => new Lexer(Buffer.from(source, 'latin1'), 0).parseObject();

    assert.deepEqual(read('/Name#20With#20Spaces'), { type: 'name', value: 'Name With Spaces' });
    // Balanced parentheses inside a string are content, not its end.
    assert.equal(read('(a (nested) string)').value.toString('latin1'), 'a (nested) string');
    assert.equal(read('(escaped \\) paren)').value.toString('latin1'), 'escaped ) paren');
    assert.equal(read('(\\101\\102)').value.toString('latin1'), 'AB');
    assert.equal(read('<414243>').value.toString('latin1'), 'ABC');
    // An odd number of hex digits is padded, not rejected.
    assert.equal(read('<41424>').value.toString('hex'), '414240');
    assert.deepEqual(read('12 0 R'), { type: 'ref', num: 12, gen: 0 });
    // The same digits without the R are two numbers, and only the third token
    // tells them apart.
    assert.equal(read('12 0'), 12);
    assert.deepEqual(read('[1 2 /Three]'), [1, 2, { type: 'name', value: 'Three' }]);
    assert.equal(read('<< /A 1 /B (two) >>').map.A, 1);
    assert.equal(read('true'), true);
    assert.equal(read('null'), null);
  });

  test('a stream whose declared length is wrong is still read', () => {
    const source = Buffer.from('<< /Length 3 >>\nstream\nDATA-IS-LONGER\nendstream', 'latin1');
    const object = new Lexer(source, 0).parseObject();
    assert.equal(object.type, 'stream');
    // The keyword that ends the stream is believed over the number that lied.
    assert.equal(decodeStream(object).toString('latin1'), 'DATA-IS-LONGER');
  });

  test('serialising round-trips through the parser', () => {
    const source = '<< /Name /A#20B /Text (a (b) c) /Ref 3 0 R /List [1 2.5 true] >>';
    const once = new Lexer(Buffer.from(source, 'latin1'), 0).parseObject();
    const twice = new Lexer(serialize(once), 0).parseObject();
    assert.equal(twice.map.Name.value, 'A B');
    assert.equal(twice.map.Text.value.toString('latin1'), 'a (b) c');
    assert.deepEqual(twice.map.Ref, { type: 'ref', num: 3, gen: 0 });
    assert.deepEqual(twice.map.List, [1, 2.5, true]);
  });

  test('pages, geometry and text come out of a real file', async () => {
    const file = at('sample.pdf');
    await makePdf(file, 3);

    const read = await readPdf(file);
    assert.equal(read.format, 'pdf');
    assert.equal(read.pages.length, 3);
    assert.equal(read.textLayer, 'full');
    assert.deepEqual(read.pages.map((page) => page.width), [612, 612, 612]);
    assert.deepEqual(read.pages.map((page) => page.height), [792, 792, 792]);
    assert.deepEqual(read.pages.map((page) => page.text), [
      'Page 1 text',
      'Page 2 text',
      'Page 3 text',
    ]);
  });

  test('deleting, reordering and rotating are one operation', async () => {
    const file = at('ops.pdf');
    await makePdf(file, 3);
    const out = at('ops-out.pdf');

    await writePdfPages([file], [{ page: 2 }, { page: 0, rotate: 90 }], out);
    const read = await readPdf(out);

    assert.equal(read.pages.length, 2, 'сторінку 2 видалено');
    assert.deepEqual(read.pages.map((page) => page.text), ['Page 3 text', 'Page 1 text']);
    assert.equal(read.pages[1].rotation, 90);
    // A quarter turn swaps the reported page size, which is what a viewer shows.
    assert.equal(read.pages[1].width, 792);
    assert.equal(read.pages[1].height, 612);
  });

  test('merging pulls pages, and their fonts, out of two files', async () => {
    const first = at('merge-a.pdf');
    const second = at('merge-b.pdf');
    await makePdf(first, 2);
    await makePdf(second, 2);

    const out = at('merged.pdf');
    await writePdfPages(
      [first, second],
      [{ source: 1, page: 1 }, { source: 0, page: 0 }, { source: 1, page: 0 }],
      out
    );

    const read = await readPdf(out);
    assert.equal(read.pages.length, 3);
    // The text only survives if each page's font came with it.
    assert.deepEqual(read.pages.map((page) => page.text), [
      'Page 2 text',
      'Page 1 text',
      'Page 1 text',
    ]);
  });

  test('an empty plan and an out-of-range page are refused', async () => {
    const file = at('refuse.pdf');
    await makePdf(file, 2);
    await assert.rejects(
      () => writePdfPages([file], [], at('never.pdf')),
      (err) => err.code === 'PDF_NO_PAGES_SELECTED'
    );
    await assert.rejects(
      () => writePdfPages([file], [{ page: 9 }], at('never.pdf')),
      (err) => err.code === 'PDF_BAD_PAGE'
    );
  });

  test('an encrypted PDF is refused rather than decoded to noise', async () => {
    const file = at('encrypted.pdf');
    await makePdf(file, 1);
    const text = (await fs.readFile(file)).toString('latin1');
    await fs.writeFile(
      file,
      Buffer.from(text.replace('/Size', '/Encrypt 1 0 R /Size'), 'latin1')
    );
    await assert.rejects(() => readPdf(file), (err) => err.code === 'PDF_ENCRYPTED');
  });

  test('a file with a broken cross-reference table still opens', async () => {
    const file = at('broken.pdf');
    await makePdf(file, 2);
    const text = (await fs.readFile(file)).toString('latin1');
    // Every offset in the table is now wrong. Scanning does not consult it.
    const wrecked = text.replace(/^\d{10} 00000 n $/gm, '0000000001 00000 n ');
    await fs.writeFile(file, Buffer.from(wrecked, 'latin1'));

    const read = await readPdf(file);
    assert.equal(read.pages.length, 2);
    assert.equal(read.pages[0].text, 'Page 1 text');
  });

  test('a page tree that points at itself does not hang the reader', async () => {
    const file = at('cycle.pdf');
    const body =
      '%PDF-1.4\n' +
      '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
      '2 0 obj\n<< /Type /Pages /Kids [2 0 R 3 0 R] /Count 1 >>\nendobj\n' +
      '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] >>\nendobj\n' +
      'trailer\n<< /Root 1 0 R >>\n%%EOF\n';
    await fs.writeFile(file, Buffer.from(body, 'latin1'));

    const read = await readPdf(file);
    assert.equal(read.pages.length, 1);
    assert.equal(read.pages[0].width, 300);
  });

  test('a page inherits the box and resources of its ancestors', async () => {
    const file = at('inherit.pdf');
    const body =
      '%PDF-1.4\n' +
      '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
      '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 200 400] /Rotate 270 >>\nendobj\n' +
      '3 0 obj\n<< /Type /Page /Parent 2 0 R >>\nendobj\n' +
      'trailer\n<< /Root 1 0 R >>\n%%EOF\n';
    await fs.writeFile(file, Buffer.from(body, 'latin1'));

    const read = await readPdf(file);
    assert.equal(read.pages[0].rotation, 270);
    assert.equal(read.pages[0].width, 400, 'поворот міняє місцями сторони');
    assert.equal(read.pages[0].height, 200);

    // And the inherited values must come along when the page is copied out.
    const out = at('inherit-out.pdf');
    await writePdfPages([file], [{ page: 0 }], out);
    const again = await readPdf(out);
    assert.equal(again.pages[0].width, 400);
    assert.equal(again.pages[0].rotation, 270);
  });
});

describe('document: the service', () => {
  test('the format is decided by the bytes, not the extension', async () => {
    const disguised = at('really-a-docx.doc');
    await writeDocx(sampleDocument(), disguised);
    assert.equal((await service.detect(disguised, 'really-a-docx.doc')).id, 'docx');

    const pdf = at('really-a-pdf.docx');
    await fs.writeFile(pdf, '%PDF-1.4\n%%EOF\n');
    assert.equal((await service.detect(pdf, 'really-a-pdf.docx')).id, 'pdf');

    const odt = at('sniff.odt');
    await writeOdt(sampleDocument(), odt);
    assert.equal((await service.detect(odt, 'sniff.odt')).id, 'odt');
  });

  test('the name still decides for a file that does not exist yet', () => {
    assert.equal(documentFormatOf('план.docx').id, 'docx');
    assert.equal(documentFormatOf('план.ODT').id, 'odt');
    assert.equal(documentFormatOf('план.txt'), null);
  });

  test('capabilities say what each format can actually do', () => {
    const caps = service.capabilities();
    assert.equal(caps.docx.write, true);
    assert.equal(caps.docx.preserves, true);
    assert.equal(caps.doc.preserves, false, 'у .doc нічого зберігати під час перезапису');
    assert.equal(caps.pdf.write, false);
    assert.equal(caps.pdf.pages, true);
  });

  test('the source markup never leaves the server', async () => {
    const file = at('service.docx');
    await writeDocx(sampleDocument(), file);
    const read = await service.read(file, 'service.docx');

    for (const block of read.blocks) {
      assert.ok(!('raw' in block), 'сира розмітка не йде клієнту');
      assert.ok(!('original' in block), 'вихідні прогони не йдуть клієнту');
      assert.equal(typeof block.id, 'number', 'але лишається розпізнавальний номер');
    }
  });

  test('markup sent by a client is ignored in favour of the file', async () => {
    const file = at('injection.docx');
    await writeDocx(sampleDocument(), file);
    const read = await service.read(file, 'injection.docx');

    // A client that echoes back a `raw` of its own devising must not have it
    // written into the document.
    const tampered = read.blocks.map((block) => ({
      ...block,
      raw: '<w:p><w:r><w:t>ПІДМІНА</w:t></w:r></w:p>',
      original: block.runs,
    }));
    const out = at('injection-out.docx');
    await service.write(out, 'injection.docx', { blocks: tampered }, { source: file });

    const again = await readDocx(out);
    assert.ok(
      !documentText(again).includes('ПІДМІНА'),
      'підставлену клієнтом розмітку відкинуто'
    );
    assert.equal(blockText(again.blocks[0]), 'Звіт за квартал');
  });

  test('saving PDF text is refused with a reason', async () => {
    await assert.rejects(
      () => service.write(at('x.pdf'), 'x.pdf', { blocks: [] }, { format: 'pdf' }),
      (err) => err.code === 'FORMAT_READ_ONLY'
    );
  });

  test('a document past the block limit is refused', async () => {
    const small = new DocumentService({ limits: { maxBlocks: 3 } });
    const file = at('big.docx');
    await writeDocx(sampleDocument(), file);
    await assert.rejects(
      () => small.read(file, 'big.docx'),
      (err) => err.code === 'TOO_MANY_BLOCKS'
    );
  });
});

describe('document: the routes', () => {
  let server;
  let base;
  let root;

  const start = async (options = {}) => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'fsfm-doc-http-')));
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

  const post = (route, body) =>
    fetch(`${base}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  test('a document is read and saved over HTTP', async () => {
    await start();
    await writeDocx(sampleDocument(), path.join(root, 'звіт.docx'));

    const opened = await (await fetch(`${base}/document?path=/звіт.docx`)).json();
    assert.equal(opened.format, 'docx');
    assert.equal(opened.kind, 'rich');
    assert.equal(opened.blocks[0].type, 'heading');

    opened.blocks[0].runs = [{ text: 'Змінено' }];
    const saved = await (await post('/document/save', { path: '/звіт.docx', document: opened })).json();
    assert.equal(saved.format, 'docx');

    const again = await readDocx(path.join(root, 'звіт.docx'));
    assert.equal(blockText(again.blocks[0]), 'Змінено');
    assert.equal(again.blocks[0].type, 'heading', 'стиль пережив правку по HTTP');
    assert.deepEqual(marksOf(again.blocks[1].runs), ['b:жирним', 'i:курсивом', 'u:підкресленим']);
  });

  test('the config advertises what the formats can do', async () => {
    const config = await (await fetch(`${base}/config`)).json();
    assert.equal(config.documentFormats.docx.write, true);
    assert.equal(config.documentFormats.pdf.pages, true);
    assert.equal(config.documentFormats.pdf.write, false);
  });

  test('a body without blocks is rejected before anything is written', async () => {
    const response = await post('/document/save', { path: '/звіт.docx', document: {} });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'INVALID_DOCUMENT');
  });

  test('a merge cannot reach outside the root', async () => {
    const response = await post('/document/pages', {
      path: '/звіт.docx',
      plan: [{ page: 0 }],
      sources: ['../../etc/hosts'],
    });
    assert.ok(response.status >= 400, 'вихід за корінь відхилено');
    assert.notEqual((await response.json()).code, undefined);
  });

  test('a read-only deployment offers neither route', async () => {
    await stop();
    await start({ permissions: { edit: false } });
    await writeDocx(sampleDocument(), path.join(root, 'звіт.docx'));

    const read = await fetch(`${base}/document?path=/звіт.docx`);
    assert.equal(read.status, 403);
    const write = await post('/document/save', {
      path: '/звіт.docx',
      document: { blocks: [{ type: 'paragraph', runs: [{ text: 'x' }] }] },
    });
    assert.equal(write.status, 403);
  });
});
