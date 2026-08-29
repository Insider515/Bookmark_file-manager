import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createFileManagerRouter } from '../server/router.js';
import { SheetService, SHEET_FORMATS, sheetFormatOf } from '../server/sheet/index.js';
import { readCsv, writeCsv, detectDelimiter, parseCsv, decodeText } from '../server/sheet/csv.js';
import { readXlsx, writeXlsx } from '../server/sheet/xlsx.js';
import { readOds, writeOds } from '../server/sheet/ods.js';
import { readXls, writeXls } from '../server/sheet/xls.js';
import { CompoundFile, buildCompoundFile } from '../server/sheet/cfb.js';
import { parseXml, element, escapeText, localName } from '../server/sheet/xml.js';
import {
  cellText,
  coerceCell,
  fromReference,
  makeCell,
  toReference,
} from '../server/sheet/model.js';

let workdir;
let service;

before(async () => {
  workdir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'fsfm-sheet-')));
  service = new SheetService();
});
after(() => fs.rm(workdir, { recursive: true, force: true }));

/** A workbook exercising every cell type and shape that matters. */
function sampleWorkbook() {
  return {
    sheets: [
      {
        name: 'Дані',
        rows: [
          [makeCell('string', 'товар'), makeCell('string', 'ціна'), makeCell('string', 'дата')],
          [
            makeCell('string', 'хліб'),
            makeCell('number', 35.5),
            makeCell('date', '2024-03-17T14:30:00.000Z'),
            makeCell('boolean', true),
          ],
          [makeCell('string', 'молоко'), makeCell('number', -0.125), null, makeCell('boolean', false)],
          [],
          [makeCell('string', 'після пропуску')],
        ],
      },
      {
        name: 'Другий',
        rows: [[makeCell('string', 'лапки "тут"'), makeCell('string', 'перенесення\nрядка')]],
      },
    ],
    meta: {},
  };
}

/** Comparable shape: names, and every cell as text plus type. */
function signature(workbook) {
  return workbook.sheets.map((sheet) => ({
    name: sheet.name,
    rows: sheet.rows.map((row) =>
      row.map((cell) => `${cellText(cell)}|${cell?.type ?? 'empty'}`)
    ),
  }));
}

describe('sheet: the cell model', () => {
  test('typing is inferred the way a spreadsheet does it', () => {
    assert.equal(coerceCell('42').type, 'number');
    assert.equal(coerceCell('-0.5').type, 'number');
    assert.equal(coerceCell('1e3').value, 1000);
    assert.equal(coerceCell('TRUE').type, 'boolean');
    assert.equal(coerceCell('привіт').type, 'string');
    assert.equal(coerceCell('').type, 'empty');
    assert.equal(coerceCell('=B2*2').formula, 'B2*2');
  });

  test('a number too long for a double stays text', () => {
    // "12345678901234567890" coming back as a different number is worse than
    // keeping the digits the user typed.
    const cell = coerceCell('12345678901234567890');
    assert.equal(cell.type, 'string');
    assert.equal(cell.value, '12345678901234567890');
  });

  test('dates are never guessed out of text', () => {
    // "01/02/03" means different days on different continents; only a file
    // that declared a date produces one.
    assert.equal(coerceCell('01/02/03').type, 'string');
    assert.equal(coerceCell('2024-03-17').type, 'string');
  });

  test('A1 references convert both ways, past column Z', () => {
    assert.equal(toReference(0, 0), 'A1');
    assert.equal(toReference(11, 25), 'Z12');
    assert.equal(toReference(0, 26), 'AA1');
    assert.equal(toReference(0, 701), 'ZZ1');
    assert.deepEqual(fromReference('AA1'), { row: 0, column: 26 });
    assert.deepEqual(fromReference('Z12'), { row: 11, column: 25 });
    assert.equal(fromReference('немає'), null);
  });
});

describe('sheet: the XML reader', () => {
  test('elements, attributes, entities, CDATA and comments', () => {
    const events = [];
    parseXml(
      '<r a="b&amp;c"><t:c/>текст<!-- c --><d><![CDATA[<raw> & x]]></d></r>',
      {
        onOpen: (name, attributes, self) => events.push(['open', name, attributes.a, self]),
        onClose: (name) => events.push(['close', name]),
        onText: (text) => text.trim() && events.push(['text', text]),
      }
    );
    assert.deepEqual(events[0], ['open', 'r', 'b&c', false]);
    assert.deepEqual(events[1], ['open', 't:c', undefined, true]);
    assert.deepEqual(events[2], ['close', 't:c']);
    assert.deepEqual(events[3], ['text', 'текст']);
    assert.ok(events.some((e) => e[0] === 'text' && e[1] === '<raw> & x'));
  });

  test('a self-closing element yields exactly one close', () => {
    // Both handlers firing is right; acting on both is what double-counted
    // ODS repeated cells.
    let closes = 0;
    parseXml('<a/><b></b>', { onClose: () => { closes += 1; } });
    assert.equal(closes, 2);
  });

  test('characters XML forbids are dropped, not escaped', () => {
    assert.equal(escapeText(`a${String.fromCharCode(0)}b`), 'ab');
    assert.equal(escapeText('a<b&c'), 'a&lt;b&amp;c');
    assert.equal(localName('table:table-cell'), 'table-cell');
    assert.equal(element('c', { r: 'A1' }, element('v', {}, '4')), '<c r="A1"><v>4</v></c>');
  });
});

describe('sheet: csv', () => {
  test('quoting, embedded delimiters and newlines survive', () => {
    const rows = parseCsv('a,"b,c","line1\nline2","he said ""hi"""\n', { delimiter: ',' });
    assert.deepEqual(rows, [['a', 'b,c', 'line1\nline2', 'he said "hi"']]);
  });

  test('the delimiter is judged by consistency, not by counting', () => {
    // A file full of commas inside quoted prose must not beat the semicolon
    // that actually separates the fields.
    assert.equal(detectDelimiter('a;b\n"x, y";z\n"p, q";w\n'), ';');
    assert.equal(detectDelimiter('a\tb\tc\n1\t2\t3\n'), '\t');
    assert.equal(detectDelimiter('a,b\n1,2\n'), ',');
  });

  test('encodings are detected and preserved', () => {
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a;b\r\n', 'utf8')]);
    const withBom = readCsv(bom);
    assert.equal(withBom.meta.encoding, 'utf-8');
    assert.equal(withBom.meta.bom, true);
    assert.equal(withBom.meta.delimiter, ';');

    // windows-1251 "товар;ціна"
    const cp1251 = Buffer.from([0xf2, 0xee, 0xe2, 0xe0, 0xf0, 0x3b, 0xf6, 0xb3, 0xed, 0xe0]);
    assert.equal(decodeText(cp1251).encoding, 'windows-1251');
    assert.equal(decodeText(cp1251).text, 'товар;ціна');
  });

  test('a round trip reproduces the shape it was given', () => {
    const source = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('товар;ціна\r\nхліб;35.5\r\n', 'utf8'),
    ]);
    const workbook = readCsv(source);
    const { buffer } = writeCsv(workbook);
    assert.deepEqual(signature(readCsv(buffer)), signature(workbook));
    assert.equal(buffer[0], 0xef, 'BOM зберігається');
    assert.ok(buffer.includes(0x3b), 'роздільник лишається крапкою з комою');
  });

  test('an encoding Node cannot write is reported rather than mangled', () => {
    const cp1251 = Buffer.from([0xf2, 0xee, 0xe2, 0xe0, 0xf0, 0x3b, 0x31]);
    const { rewritten } = writeCsv(readCsv(cp1251));
    assert.equal(rewritten, 'utf-8');
  });
});

describe('sheet: the OLE2 container', () => {
  test('a stream round-trips at every size, on both allocation schemes', async () => {
    // Under 4096 bytes a stream must live in the mini stream, and a reader
    // decides where to look purely from the recorded size.
    for (const size of [1, 500, 4095, 4096, 9000, 70000, 300000]) {
      const payload = Buffer.alloc(size);
      for (let i = 0; i < size; i += 1) payload[i] = (i * 31) & 0xff;
      const built = buildCompoundFile('Workbook', payload);
      const back = new CompoundFile(built).read('Workbook');
      assert.ok(back, `${size}: потік не знайдено`);
      assert.equal(back.length, size, `${size}: довжина`);
      assert.ok(back.equals(payload), `${size}: вміст`);
    }
  });

  test('something that is not a container is refused', () => {
    assert.equal(CompoundFile.isCompoundFile(Buffer.from('PK')), false);
    assert.throws(() => new CompoundFile(Buffer.alloc(600)));
  });
});

describe('sheet: xlsx', () => {
  test('a workbook survives a round trip whole', async () => {
    const file = path.join(workdir, 'rt.xlsx');
    const source = sampleWorkbook();
    await writeXlsx(source, file);
    const back = await readXlsx(file);
    assert.deepEqual(signature(back), signature(source));
  });

  test('dates come back as dates, not as serial numbers', async () => {
    const file = path.join(workdir, 'dates.xlsx');
    await writeXlsx(
      { sheets: [{ name: 'S', rows: [[makeCell('date', '2024-03-17T14:30:00.000Z')]] }], meta: {} },
      file
    );
    const cell = (await readXlsx(file)).sheets[0].rows[0][0];
    assert.equal(cell.type, 'date');
    assert.equal(new Date(cell.value).toISOString(), '2024-03-17T14:30:00.000Z');
  });

  test('a formula with no cached result keeps its text', async () => {
    // Files written by a library rather than by Excel look exactly like this;
    // dropping the formula would leave the cell blank.
    const file = path.join(workdir, 'formula.xlsx');
    await writeXlsx(
      { sheets: [{ name: 'S', rows: [[makeCell('string', '=B2*2', 'B2*2')]] }], meta: {} },
      file
    );
    const cell = (await readXlsx(file)).sheets[0].rows[0][0];
    assert.equal(cell.formula, 'B2*2');
    assert.equal(cellText(cell), '=B2*2');
  });

  test('a file that is a zip but not a workbook is refused clearly', async () => {
    const file = path.join(workdir, 'plain.zip');
    const { createZipStream } = await import('../server/zip.js');
    const { pipeline } = await import('node:stream/promises');
    const { createWriteStream } = await import('node:fs');
    await pipeline(
      createZipStream([{ relative: 'readme.txt', content: Buffer.from('hi') }]),
      createWriteStream(file)
    );
    await assert.rejects(readXlsx(file), (err) => err.code === 'NOT_A_WORKBOOK');
  });
});

describe('sheet: ods', () => {
  test('a workbook survives a round trip whole', async () => {
    const file = path.join(workdir, 'rt.ods');
    const source = sampleWorkbook();
    await writeOds(source, file);
    assert.deepEqual(signature(await readOds(file)), signature(source));
  });

  test('a claimed million empty rows is not materialised', async () => {
    // LibreOffice fills a sheet to its row limit with one repeat attribute.
    // Believing it literally allocates a million rows for a two-row file.
    const content =
      '<?xml version="1.0"?><office:document-content xmlns:office="o" xmlns:table="t" xmlns:text="x">' +
      '<office:body><office:spreadsheet><table:table table:name="S">' +
      '<table:table-row><table:table-cell office:value-type="string"><text:p>єдина</text:p></table:table-cell></table:table-row>' +
      '<table:table-row table:number-rows-repeated="1048570"/>' +
      '</table:table></office:spreadsheet></office:body></office:document-content>';

    const file = path.join(workdir, 'repeats.ods');
    const { createZipStream } = await import('../server/zip.js');
    const { pipeline } = await import('node:stream/promises');
    const { createWriteStream } = await import('node:fs');
    await pipeline(
      createZipStream([{ relative: 'content.xml', content: Buffer.from(content, 'utf8') }]),
      createWriteStream(file)
    );

    const started = Date.now();
    const workbook = await readOds(file);
    assert.equal(workbook.sheets[0].rows.length, 1, 'порожні повтори не розгортаються');
    assert.ok(Date.now() - started < 2000, 'і не витрачають на це час');
  });

  test('a repeated cell count is honoured exactly once', async () => {
    // Closing the cell in both the open and close handlers doubled every
    // repeat, turning five empty columns into ten.
    const content =
      '<?xml version="1.0"?><office:document-content xmlns:office="o" xmlns:table="t" xmlns:text="x">' +
      '<office:body><office:spreadsheet><table:table table:name="S"><table:table-row>' +
      '<table:table-cell table:number-columns-repeated="5"/>' +
      '<table:table-cell office:value-type="string"><text:p>дальня</text:p></table:table-cell>' +
      '</table:table-row></table:table></office:spreadsheet></office:body></office:document-content>';

    const file = path.join(workdir, 'repeat-cells.ods');
    const { createZipStream } = await import('../server/zip.js');
    const { pipeline } = await import('node:stream/promises');
    const { createWriteStream } = await import('node:fs');
    await pipeline(
      createZipStream([{ relative: 'content.xml', content: Buffer.from(content, 'utf8') }]),
      createWriteStream(file)
    );

    const row = (await readOds(file)).sheets[0].rows[0];
    assert.equal(row.length, 6, `очікувалося 5 порожніх + 1 значення, отримано ${row.length}`);
    assert.equal(cellText(row[5]), 'дальня');
  });

  test('a date-time with no zone is not shifted by the server’s own', async () => {
    const content =
      '<?xml version="1.0"?><office:document-content xmlns:office="o" xmlns:table="t" xmlns:text="x">' +
      '<office:body><office:spreadsheet><table:table table:name="S"><table:table-row>' +
      '<table:table-cell office:value-type="date" office:date-value="2023-12-01T14:30:00"><text:p>x</text:p></table:table-cell>' +
      '</table:table-row></table:table></office:spreadsheet></office:body></office:document-content>';

    const file = path.join(workdir, 'tz.ods');
    const { createZipStream } = await import('../server/zip.js');
    const { pipeline } = await import('node:stream/promises');
    const { createWriteStream } = await import('node:fs');
    await pipeline(
      createZipStream([{ relative: 'content.xml', content: Buffer.from(content, 'utf8') }]),
      createWriteStream(file)
    );

    const cell = (await readOds(file)).sheets[0].rows[0][0];
    assert.equal(new Date(cell.value).toISOString(), '2023-12-01T14:30:00.000Z');
  });
});

describe('sheet: xls', () => {
  test('a workbook survives a round trip whole', async () => {
    const file = path.join(workdir, 'rt.xls');
    const source = sampleWorkbook();
    await writeXls(source, file);
    assert.deepEqual(signature(await readXls(file)), signature(source));
  });

  test('a long string spanning CONTINUE records comes back intact', async () => {
    // The shared string table is the record that routinely continues; a reader
    // that ignores that sees a truncated table and every reference after it
    // points at nothing.
    const long = 'довгий рядок '.repeat(900);
    const file = path.join(workdir, 'long.xls');
    await writeXls(
      { sheets: [{ name: 'S', rows: [[makeCell('string', long)], [makeCell('string', 'після')]] }], meta: {} },
      file
    );
    const sheet = (await readXls(file)).sheets[0];
    assert.equal(sheet.rows[0][0].value, long);
    assert.equal(sheet.rows[1][0].value, 'після');
  });

  test('numbers use the packed form where it is exact, and a double otherwise', async () => {
    const file = path.join(workdir, 'numbers.xls');
    const values = [0, 1, -1, 42, 35.5, -0.125, 1 / 3, 1e15, 2.718281828459045];
    await writeXls(
      { sheets: [{ name: 'S', rows: [values.map((v) => makeCell('number', v))] }], meta: {} },
      file
    );
    const row = (await readXls(file)).sheets[0].rows[0];
    values.forEach((value, index) => {
      assert.equal(row[index].value, value, `${value} не збіглося`);
    });
  });

  test('something that is not a container is refused clearly', async () => {
    const file = path.join(workdir, 'notxls.xls');
    await fs.writeFile(file, 'просто текст');
    await assert.rejects(readXls(file), (err) => err.code === 'NOT_A_WORKBOOK');
  });
});

describe('sheet: the service', () => {
  test('every requested format is read and written', () => {
    const caps = service.capabilities();
    for (const id of ['csv', 'xlsx', 'xls', 'ods']) {
      assert.equal(caps[id].read, true, id);
      assert.equal(caps[id].write, true, id);
    }
    assert.equal(sheetFormatOf('прайс.csv').id, 'csv');
    assert.equal(sheetFormatOf('книга.xlsx').id, 'xlsx');
    assert.equal(sheetFormatOf('стара.xls').id, 'xls');
    assert.equal(sheetFormatOf('дані.ods').id, 'ods');
    assert.equal(sheetFormatOf('фото.png'), null);
  });

  test('the bytes overrule a misleading name', async () => {
    const real = path.join(workdir, 'real.xlsx');
    await writeXlsx(sampleWorkbook(), real);
    const renamed = path.join(workdir, 'lying.xls');
    await fs.copyFile(real, renamed);
    // An xlsx someone renamed to .xls would fail confusingly if read as BIFF8.
    assert.equal((await service.detect(renamed, 'lying.xls')).id, 'xlsx');

    const text = path.join(workdir, 'text.xlsx');
    await fs.writeFile(text, 'a,b\n1,2\n');
    assert.equal((await service.detect(text, 'text.xlsx')).id, 'csv');
  });

  test('a workbook converts between all four formats without loss', async () => {
    const origin = path.join(workdir, 'origin.xlsx');
    await writeXlsx(sampleWorkbook(), origin);
    const source = await service.read(origin, 'origin.xlsx');
    const want = signature(source);

    for (const id of ['xlsx', 'ods', 'xls']) {
      const target = path.join(workdir, `conv.${id}`);
      await service.write(target, `conv.${id}`, source);
      assert.deepEqual(signature(await service.read(target, `conv.${id}`)), want, id);
    }
  });

  test('csv refuses a multi-sheet workbook instead of dropping a sheet', async () => {
    const origin = path.join(workdir, 'multi.xlsx');
    await writeXlsx(sampleWorkbook(), origin);
    const workbook = await service.read(origin, 'multi.xlsx');
    // Saving two sheets into a format that holds one, and reporting success,
    // would lose data silently.
    await assert.rejects(
      service.write(path.join(workdir, 'out.csv'), 'out.csv', workbook),
      (err) => err.code === 'SINGLE_SHEET_FORMAT'
    );
  });

  test('a cell the client typed is retyped here, not trusted', async () => {
    const target = path.join(workdir, 'typed.xlsx');
    await service.write(target, 'typed.xlsx', {
      // The client claims a number; the value is text.
      sheets: [{ name: 'S', rows: [[{ type: 'number', value: 'не число', text: 'не число' }]] }],
      meta: {},
    });
    const cell = (await service.read(target, 'typed.xlsx')).sheets[0].rows[0][0];
    assert.equal(cell.type, 'string');
    assert.equal(cell.value, 'не число');
  });

  test('limits refuse an oversized workbook rather than truncating it', async () => {
    const bounded = new SheetService({ limits: { maxRows: 5 } });
    const rows = Array.from({ length: 20 }, (_, i) => [makeCell('number', i)]);
    await assert.rejects(
      bounded.write(path.join(workdir, 'big.xlsx'), 'big.xlsx', { sheets: [{ name: 'S', rows }], meta: {} }),
      (err) => err.code === 'TOO_MANY_ROWS'
    );
  });
});

describe('sheet: the routes', () => {
  let server;
  let base;
  let root;

  const start = async (options = {}) => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'fsfm-sheet-http-')));
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

  test('a spreadsheet is read and saved over HTTP', async () => {
    await start();
    await writeXlsx(sampleWorkbook(), path.join(root, 'книга.xlsx'));

    const opened = await (await fetch(`${base}/sheet?path=/книга.xlsx`)).json();
    assert.equal(opened.meta.format, 'xlsx');
    assert.equal(opened.sheets.length, 2);
    assert.equal(cellText(opened.sheets[0].rows[0][0]), 'товар');

    opened.sheets[0].rows[1][1] = { type: 'string', value: '99.9', text: '99.9' };
    const saved = await (
      await fetch(`${base}/sheet/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: '/книга.xlsx', workbook: opened }),
      })
    ).json();
    assert.equal(saved.format, 'xlsx');

    const again = await readXlsx(path.join(root, 'книга.xlsx'));
    assert.equal(again.sheets[0].rows[1][1].value, 99.9);
    assert.equal(again.sheets[0].rows[1][1].type, 'number', 'текст «99.9» став числом');
  });

  test('/config advertises the formats', async () => {
    const config = await (await fetch(`${base}/config`)).json();
    assert.deepEqual(Object.keys(config.sheetFormats).sort(), ['csv', 'ods', 'xls', 'xlsx']);
    assert.equal(config.sheetFormats.csv.singleSheet, true);
    assert.equal(config.sheetFormats.xlsx.singleSheet, false);
  });

  test('a failed save leaves the original file untouched', async () => {
    const before = await fs.readFile(path.join(root, 'книга.xlsx'));
    const response = await fetch(`${base}/sheet/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/книга.xlsx', workbook: { sheets: 'не масив' } }),
    });
    assert.equal(response.status, 400);
    // The write goes to a temporary name and is renamed into place, so a
    // refusal cannot leave a half-written spreadsheet under the real one.
    assert.ok(before.equals(await fs.readFile(path.join(root, 'книга.xlsx'))));
  });

  test('a path outside the root is refused here too', async () => {
    assert.equal((await fetch(`${base}/sheet?path=/../../etc/passwd`)).status, 400);
  });

  test('withholding edit closes the whole feature', async () => {
    await stop();
    await start({ permissions: { edit: false } });
    await writeXlsx(sampleWorkbook(), path.join(root, 'книга.xlsx'));

    assert.equal((await fetch(`${base}/sheet?path=/книга.xlsx`)).status, 403);
    const save = await fetch(`${base}/sheet/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/книга.xlsx', workbook: { sheets: [] } }),
    });
    assert.equal(save.status, 403);
  });

  test('edit follows create, so a read-only manager has no editor', async () => {
    await stop();
    await start({ readOnly: true });
    const config = await (await fetch(`${base}/config`)).json();
    assert.equal(config.permissions.edit, false);
  });
});
