import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

import { createZipStream } from '../zip.js';
import { ZipArchive } from '../archive/zip-read.js';
import { XML_DECLARATION, element, escapeText, localName, parseXml } from './xml.js';
import {
  DEFAULT_LIMITS,
  EMPTY_CELL,
  cellText,
  fromReference,
  makeCell,
  sheetError,
  sheetWidth,
  toReference,
} from './model.js';

/**
 * xlsx — SpreadsheetML, read and written without a dependency.
 *
 * An .xlsx is a ZIP of XML parts, and this project already owns both a ZIP
 * reader and a ZIP writer. What is left is the schema, and only a small part
 * of it matters for values: the workbook lists its sheets, the rels file says
 * which part each sheet lives in, sharedStrings holds the text, styles say
 * which numbers are really dates, and the sheet itself holds the cells.
 *
 * Charts, pivot tables, conditional formats, images and macros are read past
 * and — this is the part worth knowing — **not preserved on save**. Editing a
 * workbook here and saving it keeps the values and loses the rest, so the
 * caller warns before overwriting anything it did not itself create.
 */

/** Parts that never vary, written verbatim. */
const CONTENT_TYPES = `${XML_DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\
<Default Extension="xml" ContentType="application/xml"/>\
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>\
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>\
<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>`;

const ROOT_RELS = `${XML_DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>\
</Relationships>`;

/**
 * Number formats that mean "this number is a date".
 *
 * The built-in ids are fixed by the spec; anything above 163 is defined in the
 * file itself and has to be judged by its format string. Without this a date
 * column reads back as 45000-odd, which is what the file literally holds.
 */
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

function looksLikeDateFormat(code) {
  if (!code) return false;
  // Strip quoted literals and colour/condition blocks before looking for the
  // date placeholders, so a currency format with "May" in its literal text is
  // not mistaken for one.
  const stripped = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '');
  return /[ymdhs]/i.test(stripped) && !/^[^ymdhs]*$/i.test(stripped);
}

/** Excel's serial day number to a Date, in UTC. */
export function serialToDate(serial) {
  // Excel believes 1900 was a leap year. Serial 60 is that day, which never
  // existed; everything after it is therefore one too high, and the epoch
  // below is chosen to cancel that out for the range anyone actually uses.
  const epoch = Date.UTC(1899, 11, 30);
  const days = serial < 60 ? serial + 1 : serial;
  return new Date(epoch + Math.round(days * 86400000));
}

/** The inverse, for writing. */
export function dateToSerial(date) {
  const epoch = Date.UTC(1899, 11, 30);
  const days = (date.getTime() - epoch) / 86400000;
  return days < 61 ? days - 1 : days;
}

async function readPart(archive, name) {
  const entry = archive.entries.find((item) => item.name === name);
  if (!entry) return null;
  const chunks = [];
  for await (const chunk of await archive.createEntryStream(entry)) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/** sharedStrings.xml into a flat array; `si` may hold several runs of text. */
function parseSharedStrings(xml) {
  if (!xml) return [];
  const strings = [];
  let current = null;
  let inText = false;

  parseXml(xml, {
    onOpen: (name) => {
      const tag = localName(name);
      if (tag === 'si') current = '';
      else if (tag === 't') inText = true;
    },
    onText: (text) => {
      if (inText && current !== null) current += text;
    },
    onClose: (name) => {
      const tag = localName(name);
      if (tag === 't') inText = false;
      else if (tag === 'si') {
        strings.push(current ?? '');
        current = null;
      }
    },
  });
  return strings;
}

/** styles.xml reduced to "is the cell format at this index a date?". */
function parseStyles(xml) {
  if (!xml) return [];
  const customFormats = new Map();
  const dateStyles = [];
  let inCellXfs = false;

  parseXml(xml, {
    onOpen: (name, attributes) => {
      const tag = localName(name);
      if (tag === 'numFmt') {
        customFormats.set(Number(attributes.numFmtId), attributes.formatCode ?? '');
      } else if (tag === 'cellXfs') {
        inCellXfs = true;
      } else if (tag === 'xf' && inCellXfs) {
        const id = Number(attributes.numFmtId ?? 0);
        dateStyles.push(
          BUILTIN_DATE_FORMATS.has(id) || looksLikeDateFormat(customFormats.get(id))
        );
      }
    },
    onClose: (name) => {
      if (localName(name) === 'cellXfs') inCellXfs = false;
    },
  });
  return dateStyles;
}

/** workbook.xml: sheet names in order, with the relationship id for each. */
function parseWorkbook(xml) {
  const sheets = [];
  parseXml(xml, {
    onOpen: (name, attributes) => {
      if (localName(name) !== 'sheet') return;
      const relationship =
        attributes['r:id'] ?? attributes['relationships:id'] ?? attributes.id ?? null;
      sheets.push({ name: attributes.name ?? `Sheet${sheets.length + 1}`, relationship });
    },
  });
  return sheets;
}

/** workbook.xml.rels: relationship id to the part it points at. */
function parseRels(xml) {
  const map = new Map();
  if (!xml) return map;
  parseXml(xml, {
    onOpen: (name, attributes) => {
      if (localName(name) !== 'Relationship') return;
      map.set(attributes.Id, attributes.Target);
    },
  });
  return map;
}

/** One worksheet part into rows of cells. */
function parseSheet(xml, { sharedStrings, dateStyles, limits }) {
  const rows = [];
  let row = null;
  let rowIndex = -1;

  let cell = null;
  let cellRef = null;
  let cellType = null;
  let cellStyle = 0;
  let inValue = false;
  let inFormula = false;
  let inInlineText = false;
  let value = '';
  let formula = '';
  let cellCount = 0;

  const place = (index, entry) => {
    while (row.length < index) row.push({ ...EMPTY_CELL });
    row[index] = entry;
  };

  parseXml(xml, {
    onOpen: (name, attributes) => {
      const tag = localName(name);
      if (tag === 'row') {
        // `r` is one-based and may skip: an empty row simply is not written.
        const declared = attributes.r ? Number(attributes.r) - 1 : rowIndex + 1;
        while (rows.length < declared) rows.push([]);
        rowIndex = declared;
        row = [];
        rows[declared] = row;
        if (limits && rows.length > limits.maxRows) {
          throw sheetError(413, 'TOO_MANY_ROWS', 'The sheet has too many rows');
        }
      } else if (tag === 'c') {
        cellRef = attributes.r ?? null;
        cellType = attributes.t ?? 'n';
        cellStyle = Number(attributes.s ?? 0);
        value = '';
        formula = '';
        cell = true;
        // parseXml fires onClose for self-closing elements too, so the cell is
        // finished there — closing it here as well would double-count.
      } else if (tag === 'v') {
        inValue = true;
      } else if (tag === 'f') {
        inFormula = true;
      } else if (tag === 't') {
        inInlineText = true;
      }
    },
    onText: (text) => {
      if (inValue || inInlineText) value += text;
      else if (inFormula) formula += text;
    },
    onClose: (name) => {
      const tag = localName(name);
      if (tag === 'v') inValue = false;
      else if (tag === 'f') inFormula = false;
      else if (tag === 't') inInlineText = false;
      else if (tag === 'c') finishCell();
      else if (tag === 'row') row = null;
    },
  });

  function finishCell() {
    if (!cell || !row) {
      cell = null;
      return;
    }
    const reference = cellRef ? fromReference(cellRef) : null;
    const columnIndex = reference ? reference.column : row.length;
    cellCount += 1;
    if (limits && cellCount > limits.maxCells) {
      throw sheetError(413, 'TOO_MANY_CELLS', 'The workbook has too many cells');
    }
    if (limits && columnIndex >= limits.maxColumns) {
      throw sheetError(413, 'TOO_MANY_COLUMNS', 'The sheet has too many columns');
    }
    place(columnIndex, toCell(cellType, value, formula, cellStyle));
    cell = null;
  }

  function toCell(type, raw, expression, style) {
    const trailing = expression ? expression : undefined;

    // A formula whose result was never cached — which is what a file written
    // by a library rather than by Excel usually looks like. Dropping it would
    // turn the cell blank and lose the only thing it contained.
    if (trailing && raw === '') return makeCell('string', `=${trailing}`, trailing);

    if (type === 's') {
      const index = Number(raw);
      return makeCell('string', sharedStrings[index] ?? '', trailing);
    }
    if (type === 'inlineStr' || type === 'str') {
      return makeCell('string', raw, trailing);
    }
    if (type === 'b') {
      return makeCell('boolean', raw === '1' || raw === 'true', trailing);
    }
    if (type === 'e') {
      // An error result is text: there is nothing else honest to show.
      return makeCell('string', raw, trailing);
    }
    if (raw === '') return { ...EMPTY_CELL };

    const numeric = Number(raw);
    if (!Number.isFinite(numeric)) return makeCell('string', raw, trailing);
    if (dateStyles[style]) {
      return makeCell('date', serialToDate(numeric).toISOString(), trailing);
    }
    return makeCell('number', numeric, trailing);
  }

  // Rows skipped over are real: a sheet may start at row 5.
  for (let i = 0; i < rows.length; i += 1) if (!rows[i]) rows[i] = [];
  return rows;
}

/**
 * Read an .xlsx into a workbook.
 *
 * @param {string} absolute path to the file
 * @param {{limits?: object}} [options]
 */
export async function readXlsx(absolute, { limits = DEFAULT_LIMITS } = {}) {
  const archive = await ZipArchive.open(absolute);
  try {
    const workbookXml = await readPart(archive, 'xl/workbook.xml');
    if (!workbookXml) {
      throw sheetError(422, 'NOT_A_WORKBOOK', 'The file has no xl/workbook.xml — it is not an Excel workbook');
    }

    const sharedStrings = parseSharedStrings(await readPart(archive, 'xl/sharedStrings.xml'));
    const dateStyles = parseStyles(await readPart(archive, 'xl/styles.xml'));
    const rels = parseRels(await readPart(archive, 'xl/_rels/workbook.xml.rels'));
    const declared = parseWorkbook(workbookXml);

    if (declared.length > limits.maxSheets) {
      throw sheetError(413, 'TOO_MANY_SHEETS', 'The workbook has too many sheets');
    }

    const sheets = [];
    for (const [index, entry] of declared.entries()) {
      const target = entry.relationship ? rels.get(entry.relationship) : null;
      const part = target
        ? `xl/${String(target).replace(/^\/?xl\//, '').replace(/^\//, '')}`
        : `xl/worksheets/sheet${index + 1}.xml`;
      const xml = (await readPart(archive, part)) ?? (await readPart(archive, `xl/worksheets/sheet${index + 1}.xml`));
      sheets.push({
        name: entry.name,
        rows: xml ? parseSheet(xml, { sharedStrings, dateStyles, limits }) : [],
      });
    }

    return { sheets, meta: { format: 'xlsx' } };
  } finally {
    await archive.close();
  }
}

/** Escape a sheet name for the workbook part; Excel forbids these outright. */
function safeSheetName(name, index) {
  const cleaned = String(name ?? '')
    .replace(/[\\/?*[\]:]/g, ' ')
    .trim()
    .slice(0, 31);
  return cleaned || `Sheet${index + 1}`;
}

/**
 * Write a workbook as .xlsx.
 *
 * Text goes into a shared string table rather than inline. Both are legal, but
 * the shared table is what every producer emits, so it is the better-trodden
 * path through other people's readers — and it is smaller whenever a value
 * repeats, which in a spreadsheet it usually does.
 */
export async function writeXlsx(workbook, destination) {
  const strings = [];
  const stringIndex = new Map();
  const internString = (text) => {
    const existing = stringIndex.get(text);
    if (existing !== undefined) return existing;
    const index = strings.length;
    strings.push(text);
    stringIndex.set(text, index);
    return index;
  };

  const sheetParts = workbook.sheets.map((sheet, sheetIndex) => {
    const width = sheetWidth(sheet);
    const rowsXml = [];

    sheet.rows.forEach((row, rowIndex) => {
      const cellsXml = [];
      row.forEach((cell, columnIndex) => {
        if (!cell || cell.type === 'empty' || cell.value === null || cell.value === '') return;
        const reference = toReference(rowIndex, columnIndex);
        const formulaXml = cell.formula ? element('f', {}, escapeText(cell.formula)) : '';

        if (cell.type === 'number') {
          cellsXml.push(element('c', { r: reference }, formulaXml + element('v', {}, escapeText(cell.value))));
        } else if (cell.type === 'boolean') {
          cellsXml.push(
            element('c', { r: reference, t: 'b' }, formulaXml + element('v', {}, cell.value ? '1' : '0'))
          );
        } else if (cell.type === 'date') {
          const date = new Date(cell.value);
          const serial = Number.isNaN(date.getTime()) ? 0 : dateToSerial(date);
          // Style 1 is the date format declared in styles.xml below.
          cellsXml.push(
            element('c', { r: reference, s: '1' }, formulaXml + element('v', {}, escapeText(serial)))
          );
        } else {
          const index = internString(String(cell.value));
          cellsXml.push(
            element('c', { r: reference, t: 's' }, formulaXml + element('v', {}, String(index)))
          );
        }
      });
      if (cellsXml.length > 0) {
        rowsXml.push(element('row', { r: String(rowIndex + 1) }, cellsXml));
      }
    });

    const dimension =
      sheet.rows.length > 0 && width > 0
        ? element('dimension', { ref: `A1:${toReference(sheet.rows.length - 1, Math.max(0, width - 1))}` })
        : element('dimension', { ref: 'A1' });

    return {
      name: safeSheetName(sheet.name, sheetIndex),
      part: `xl/worksheets/sheet${sheetIndex + 1}.xml`,
      xml:
        XML_DECLARATION +
        element(
          'worksheet',
          { xmlns: 'http://schemas.openxmlformats.org/spreadsheetml/2006/main' },
          dimension + element('sheetData', {}, rowsXml)
        ),
    };
  });

  const sharedStringsXml =
    XML_DECLARATION +
    element(
      'sst',
      {
        xmlns: 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
        count: String(strings.length),
        uniqueCount: String(strings.length),
      },
      strings.map((text) => element('si', {}, element('t', { 'xml:space': 'preserve' }, escapeText(text))))
    );

  const workbookXml =
    XML_DECLARATION +
    element(
      'workbook',
      {
        xmlns: 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
        'xmlns:r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
      },
      element(
        'sheets',
        {},
        sheetParts.map((sheet, index) =>
          element('sheet', { name: sheet.name, sheetId: String(index + 1), 'r:id': `rId${index + 1}` })
        )
      )
    );

  const workbookRels =
    XML_DECLARATION +
    element(
      'Relationships',
      { xmlns: 'http://schemas.openxmlformats.org/package/2006/relationships' },
      sheetParts
        .map((sheet, index) =>
          element('Relationship', {
            Id: `rId${index + 1}`,
            Type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet',
            Target: `worksheets/sheet${index + 1}.xml`,
          })
        )
        .concat(
          element('Relationship', {
            Id: `rId${sheetParts.length + 1}`,
            Type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles',
            Target: 'styles.xml',
          }),
          element('Relationship', {
            Id: `rId${sheetParts.length + 2}`,
            Type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings',
            Target: 'sharedStrings.xml',
          })
        )
    );

  // Two cell formats: the general one, and an ISO-ish date at index 1. The
  // font/fill/border tables are required to exist even when nothing uses them.
  const stylesXml =
    XML_DECLARATION +
    element(
      'styleSheet',
      { xmlns: 'http://schemas.openxmlformats.org/spreadsheetml/2006/main' },
      element('numFmts', { count: '1' }, element('numFmt', { numFmtId: '164', formatCode: 'yyyy-mm-dd hh:mm:ss' })) +
        element('fonts', { count: '1' }, element('font', {}, element('sz', { val: '11' }) + element('name', { val: 'Calibri' }))) +
        element('fills', { count: '1' }, element('fill', {}, element('patternFill', { patternType: 'none' }))) +
        element('borders', { count: '1' }, element('border', {}, '')) +
        element('cellStyleXfs', { count: '1' }, element('xf', { numFmtId: '0', fontId: '0', fillId: '0', borderId: '0' })) +
        element(
          'cellXfs',
          { count: '2' },
          element('xf', { numFmtId: '0', fontId: '0', fillId: '0', borderId: '0', xfId: '0' }) +
            element('xf', {
              numFmtId: '164',
              fontId: '0',
              fillId: '0',
              borderId: '0',
              xfId: '0',
              applyNumberFormat: '1',
            })
        ) +
        // openpyxl warns and Excel repairs when this is missing, even though
        // nothing here uses a named style: the part is expected to exist.
        element(
          'cellStyles',
          { count: '1' },
          element('cellStyle', { name: 'Normal', xfId: '0', builtinId: '0' })
        )
    );

  const contentTypes =
    CONTENT_TYPES +
    sheetParts
      .map((sheet) =>
        element('Override', {
          PartName: `/${sheet.part}`,
          ContentType:
            'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml',
        })
      )
      .join('') +
    '</Types>';

  const now = new Date();
  const entries = [
    { relative: '[Content_Types].xml', content: Buffer.from(contentTypes, 'utf8') },
    { relative: '_rels/.rels', content: Buffer.from(ROOT_RELS, 'utf8') },
    { relative: 'xl/workbook.xml', content: Buffer.from(workbookXml, 'utf8') },
    { relative: 'xl/_rels/workbook.xml.rels', content: Buffer.from(workbookRels, 'utf8') },
    { relative: 'xl/styles.xml', content: Buffer.from(stylesXml, 'utf8') },
    { relative: 'xl/sharedStrings.xml', content: Buffer.from(sharedStringsXml, 'utf8') },
    ...sheetParts.map((sheet) => ({
      relative: sheet.part,
      content: Buffer.from(sheet.xml, 'utf8'),
    })),
  ].map((entry) => ({ ...entry, modified: now }));

  await pipeline(createZipStream(entries), createWriteStream(destination));
}

export { cellText };
