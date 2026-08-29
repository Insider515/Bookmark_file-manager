import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

import { createZipStream } from '../zip.js';
import { ZipArchive } from '../archive/zip-read.js';
import { XML_DECLARATION, element, escapeText, localName, parseXml } from './xml.js';
import { DEFAULT_LIMITS, EMPTY_CELL, cellText, makeCell, sheetError } from './model.js';

/**
 * ods — OpenDocument Spreadsheet, read and written without a dependency.
 *
 * Same shape as xlsx: a ZIP of XML. The difference that matters is how empty
 * space is stored. OpenDocument does not skip empty rows and columns, it
 * *repeats* them — a sheet with three used columns typically declares the
 * remaining thousand with one `table:number-columns-repeated="1021"`, and
 * LibreOffice routinely writes `number-rows-repeated="1048570"` to fill a
 * sheet to its limit.
 *
 * A reader that expands those literally allocates a million empty rows for a
 * two-row file. Everything below therefore treats a repeat as a *claim* rather
 * than an instruction: it is honoured only up to the last cell that actually
 * holds something, and capped besides.
 */

const MIMETYPE = 'application/vnd.oasis.opendocument.spreadsheet';

const NS = {
  office: 'urn:oasis:names:tc:opendocument:xmlns:office:1.0',
  table: 'urn:oasis:names:tc:opendocument:xmlns:table:1.0',
  text: 'urn:oasis:names:tc:opendocument:xmlns:text:1.0',
  style: 'urn:oasis:names:tc:opendocument:xmlns:style:1.0',
  number: 'urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0',
  fo: 'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0',
  manifest: 'urn:oasis:names:tc:opendocument:xmlns:manifest:1.0',
};

/**
 * A single repeat is never expanded beyond this, whatever the file claims.
 * The real content is bounded by the limits; this only stops one absurd
 * attribute from being believed on its own.
 */
const MAX_REPEAT = 65536;

const MANIFEST =
  XML_DECLARATION +
  element(
    'manifest:manifest',
    { 'xmlns:manifest': NS.manifest, 'manifest:version': '1.3' },
    element('manifest:file-entry', {
      'manifest:full-path': '/',
      'manifest:version': '1.3',
      'manifest:media-type': MIMETYPE,
    }) +
      element('manifest:file-entry', {
        'manifest:full-path': 'content.xml',
        'manifest:media-type': 'text/xml',
      }) +
      element('manifest:file-entry', {
        'manifest:full-path': 'styles.xml',
        'manifest:media-type': 'text/xml',
      })
  );

const STYLES =
  XML_DECLARATION +
  element(
    'office:document-styles',
    {
      'xmlns:office': NS.office,
      'xmlns:style': NS.style,
      'xmlns:fo': NS.fo,
      'office:version': '1.3',
    },
    element('office:styles', {}, '')
  );

/** ISO date/time out of the several shapes OpenDocument allows. */
function parseOdsDate(value) {
  if (!value) return null;
  // OpenDocument writes "2023-12-01T14:30:00" with no zone, meaning the wall
  // clock as typed. Left alone, JS reads that as *local* time and shifts it by
  // the server's offset — so a date typed in Moscow comes back an hour out on
  // a machine in another zone.
  let text = String(value);
  if (text.length === 10) text += 'T00:00:00Z';
  else if (!/(Z|[+-]\d{2}:?\d{2})$/.test(text)) text += 'Z';
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * Read one `content.xml` into sheets.
 *
 * Repeats are the whole difficulty here; see the note at the top of the file.
 */
function parseContent(xml, { limits }) {
  const sheets = [];

  let sheet = null;
  let row = null;
  let rowRepeat = 1;
  let pendingEmptyRows = 0;

  let cellRepeat = 1;
  let cellType = null;
  let cellValue = null;
  let cellFormula = null;
  let cellText_ = '';
  let inParagraph = false;
  let inCell = false;
  let pendingEmptyCells = 0;
  let cellCount = 0;

  const closeRow = () => {
    if (!sheet || !row) return;
    // Trailing empties that were only ever a repeat claim are dropped rather
    // than materialised: they carry nothing.
    if (row.length > 0) {
      // Rows skipped before this one only matter if this one has content.
      for (let i = 0; i < pendingEmptyRows; i += 1) sheet.rows.push([]);
      pendingEmptyRows = 0;
      const repeat = Math.min(rowRepeat, MAX_REPEAT);
      for (let i = 0; i < repeat; i += 1) {
        sheet.rows.push(i === 0 ? row : row.map((cell) => ({ ...cell })));
        if (limits && sheet.rows.length > limits.maxRows) {
          throw sheetError(413, 'TOO_MANY_ROWS', 'The sheet has too many rows');
        }
      }
    } else {
      pendingEmptyRows += Math.min(rowRepeat, MAX_REPEAT);
      // A file may claim a million empty trailing rows; remembering the count
      // costs nothing and they are only ever emitted ahead of real content.
      if (pendingEmptyRows > MAX_REPEAT) pendingEmptyRows = MAX_REPEAT;
    }
    row = null;
  };

  const closeCell = () => {
    if (!row) return;
    const repeat = Math.min(cellRepeat, MAX_REPEAT);
    const cell = toCell();

    if (cell.type === 'empty') {
      pendingEmptyCells += repeat;
    } else {
      for (let i = 0; i < pendingEmptyCells; i += 1) row.push({ ...EMPTY_CELL });
      pendingEmptyCells = 0;
      for (let i = 0; i < repeat; i += 1) {
        row.push(i === 0 ? cell : { ...cell });
        cellCount += 1;
        if (limits && cellCount > limits.maxCells) {
          throw sheetError(413, 'TOO_MANY_CELLS', 'The workbook has too many cells');
        }
        if (limits && row.length > limits.maxColumns) {
          throw sheetError(413, 'TOO_MANY_COLUMNS', 'The sheet has too many columns');
        }
      }
    }
    inCell = false;
  };

  function toCell() {
    const formula = cellFormula
      ? // "of:=[.B2]*2" is the namespaced form; the plain expression is what a
        // person recognises, so the prefix and cell-reference brackets go.
        cellFormula.replace(/^[a-z]+:/i, '').replace(/^=/, '').replace(/\[\.([^\]]+)\]/g, '$1')
      : undefined;

    if (cellType === 'float' || cellType === 'percentage' || cellType === 'currency') {
      const numeric = Number(cellValue);
      if (Number.isFinite(numeric)) return makeCell('number', numeric, formula);
    }
    if (cellType === 'boolean') {
      return makeCell('boolean', cellValue === 'true' || cellValue === '1', formula);
    }
    if (cellType === 'date' || cellType === 'time') {
      const iso = parseOdsDate(cellValue);
      if (iso) return makeCell('date', iso, formula);
    }
    if (cellText_ !== '') return makeCell('string', cellText_, formula);
    if (formula) return makeCell('string', `=${formula}`, formula);
    return { ...EMPTY_CELL };
  }

  parseXml(xml, {
    onOpen: (name, attributes) => {
      const tag = localName(name);

      if (tag === 'table') {
        sheet = { name: attributes['table:name'] ?? `Sheet${sheets.length + 1}`, rows: [] };
        sheets.push(sheet);
        pendingEmptyRows = 0;
        if (limits && sheets.length > limits.maxSheets) {
          throw sheetError(413, 'TOO_MANY_SHEETS', 'The workbook has too many sheets');
        }
      } else if (tag === 'table-row') {
        row = [];
        rowRepeat = Number(attributes['table:number-rows-repeated'] ?? 1) || 1;
        pendingEmptyCells = 0;
        // No closeRow() here even when self-closing: parseXml fires onClose for
        // those too, and closing in both places counted every repeat twice.
      } else if (tag === 'table-cell' || tag === 'covered-table-cell') {
        inCell = true;
        cellRepeat = Number(attributes['table:number-columns-repeated'] ?? 1) || 1;
        cellType = attributes['office:value-type'] ?? null;
        cellValue =
          attributes['office:value'] ??
          attributes['office:date-value'] ??
          attributes['office:time-value'] ??
          attributes['office:boolean-value'] ??
          attributes['office:string-value'] ??
          null;
        cellFormula = attributes['table:formula'] ?? null;
        cellText_ = '';
        // See the note on table-row above: onClose covers the self-closing
        // case, which is exactly how an empty repeated cell is written.
      } else if (tag === 'p' && inCell) {
        // Several paragraphs in one cell are separate lines.
        if (cellText_ !== '') cellText_ += '\n';
        inParagraph = true;
      } else if (tag === 's' && inParagraph) {
        cellText_ += ' '.repeat(Number(attributes['text:c'] ?? 1) || 1);
      } else if (tag === 'tab' && inParagraph) {
        cellText_ += '\t';
      } else if (tag === 'line-break' && inParagraph) {
        cellText_ += '\n';
      }
    },
    onText: (text) => {
      if (inParagraph) cellText_ += text;
    },
    onClose: (name) => {
      const tag = localName(name);
      if (tag === 'p') inParagraph = false;
      else if (tag === 'table-cell' || tag === 'covered-table-cell') closeCell();
      else if (tag === 'table-row') closeRow();
      else if (tag === 'table') sheet = null;
    },
  });

  return sheets;
}

export async function readOds(absolute, { limits = DEFAULT_LIMITS } = {}) {
  const archive = await ZipArchive.open(absolute);
  try {
    const entry = archive.entries.find((item) => item.name === 'content.xml');
    if (!entry) {
      throw sheetError(422, 'NOT_A_WORKBOOK', 'The file has no content.xml — it is not an ODF spreadsheet');
    }
    const chunks = [];
    for await (const chunk of await archive.createEntryStream(entry)) chunks.push(chunk);
    const sheets = parseContent(Buffer.concat(chunks).toString('utf8'), { limits });
    return { sheets: sheets.length > 0 ? sheets : [{ name: 'Sheet1', rows: [] }], meta: { format: 'ods' } };
  } finally {
    await archive.close();
  }
}

/** One cell as OpenDocument sees it. */
function cellXml(cell) {
  if (!cell || cell.type === 'empty' || cell.value === null || cell.value === '') {
    return element('table:table-cell', {});
  }
  const formula = cell.formula ? { 'table:formula': `of:=${cell.formula}` } : {};

  if (cell.type === 'number') {
    return element(
      'table:table-cell',
      { ...formula, 'office:value-type': 'float', 'office:value': String(cell.value) },
      element('text:p', {}, escapeText(cell.value))
    );
  }
  if (cell.type === 'boolean') {
    return element(
      'table:table-cell',
      { ...formula, 'office:value-type': 'boolean', 'office:boolean-value': cell.value ? 'true' : 'false' },
      element('text:p', {}, cell.value ? 'TRUE' : 'FALSE')
    );
  }
  if (cell.type === 'date') {
    const date = new Date(cell.value);
    const iso = Number.isNaN(date.getTime()) ? String(cell.value) : date.toISOString().replace(/\.\d+Z$/, '');
    return element(
      'table:table-cell',
      { ...formula, 'office:value-type': 'date', 'office:date-value': iso },
      element('text:p', {}, escapeText(iso.replace('T', ' ')))
    );
  }

  const text = String(cell.value);
  // A newline inside a cell is separate paragraphs, not an escaped character.
  const paragraphs = text.split('\n').map((line) => element('text:p', {}, escapeText(line)));
  return element(
    'table:table-cell',
    { ...formula, 'office:value-type': 'string' },
    paragraphs.join('')
  );
}

export async function writeOds(workbook, destination) {
  const tables = workbook.sheets.map((sheet, index) => {
    const width = sheet.rows.reduce((max, row) => Math.max(max, row.length), 0);
    const rows = sheet.rows.map((row) => {
      const cells = row.map((cell) => cellXml(cell));
      // Pad to the sheet width so every row is the same shape, which is what
      // readers expect; a single repeated empty cell says it compactly.
      if (row.length < width) {
        cells.push(
          element('table:table-cell', { 'table:number-columns-repeated': String(width - row.length) })
        );
      }
      return element('table:table-row', {}, cells.join(''));
    });

    return element(
      'table:table',
      { 'table:name': String(sheet.name || `Sheet${index + 1}`) },
      element('table:table-column', {
        'table:number-columns-repeated': String(Math.max(1, width)),
      }) + rows.join('')
    );
  });

  const content =
    XML_DECLARATION +
    element(
      'office:document-content',
      {
        'xmlns:office': NS.office,
        'xmlns:table': NS.table,
        'xmlns:text': NS.text,
        'office:version': '1.3',
      },
      element('office:body', {}, element('office:spreadsheet', {}, tables.join('')))
    );

  const now = new Date();
  await pipeline(
    createZipStream([
      // Must come first and uncompressed; readers that check will refuse the
      // file otherwise.
      { relative: 'mimetype', content: Buffer.from(MIMETYPE, 'utf8'), store: true, modified: now },
      { relative: 'META-INF/manifest.xml', content: Buffer.from(MANIFEST, 'utf8'), modified: now },
      { relative: 'styles.xml', content: Buffer.from(STYLES, 'utf8'), modified: now },
      { relative: 'content.xml', content: Buffer.from(content, 'utf8'), modified: now },
    ]),
    createWriteStream(destination)
  );
}

export { cellText };
