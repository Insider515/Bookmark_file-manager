import fs from 'node:fs/promises';
import path from 'node:path';

import { readCsv, writeCsv } from './csv.js';
import { readXlsx, writeXlsx } from './xlsx.js';
import { readOds, writeOds } from './ods.js';
import { readXls, writeXls } from './xls.js';
import {
  DEFAULT_LIMITS,
  assertWithinLimits,
  cellText,
  coerceCell,
  emptyWorkbook,
  sheetError,
  trimWorkbook,
} from './model.js';

export { DEFAULT_LIMITS, cellText, coerceCell, emptyWorkbook, trimWorkbook } from './model.js';
export { readCsv, writeCsv } from './csv.js';
export { readXlsx, writeXlsx } from './xlsx.js';
export { readOds, writeOds } from './ods.js';
export { readXls, writeXls } from './xls.js';

/**
 * The spreadsheet formats this router reads and writes, all of them without a
 * dependency.
 *
 * csv is plain text. xlsx and ods are ZIP archives of XML, which this project
 * already has both halves of. xls is BIFF8 records inside an OLE2 container,
 * which is the only one that needed building from nothing.
 *
 * Every format here is read *and* written: unlike the archive formats, none of
 * these is encumbered by a patent or a licence that would make writing it
 * impossible.
 */
export const SHEET_FORMATS = {
  csv: {
    id: 'csv',
    label: 'CSV',
    // Not `.txt`: a text file is text, and claiming it here would send every
    // note and readme to the spreadsheet grid instead of the code editor.
    extensions: ['csv', 'tsv'],
    /** One sheet only — the format has nowhere to put a second. */
    singleSheet: true,
  },
  xlsx: {
    id: 'xlsx',
    label: 'Excel (xlsx)',
    extensions: ['xlsx', 'xlsm'],
    singleSheet: false,
  },
  xls: {
    id: 'xls',
    label: 'Excel 97–2003 (xls)',
    extensions: ['xls'],
    singleSheet: false,
  },
  ods: {
    id: 'ods',
    label: 'OpenDocument (ods)',
    extensions: ['ods'],
    singleSheet: false,
  },
};

export const SHEET_FORMAT_IDS = Object.keys(SHEET_FORMATS);

const BY_EXTENSION = (() => {
  const pairs = [];
  for (const format of Object.values(SHEET_FORMATS)) {
    for (const extension of format.extensions) pairs.push([extension, format.id]);
  }
  return pairs;
})();

/** The format a filename claims, or null. */
export function sheetFormatOf(name) {
  const lower = String(name).toLowerCase();
  for (const [extension, id] of BY_EXTENSION) {
    if (lower.endsWith(`.${extension}`)) return SHEET_FORMATS[id];
  }
  return null;
}

export function isSheetName(name) {
  return sheetFormatOf(name) !== null;
}

/** Signatures that settle what a file really is, whatever it is called. */
async function sniff(absolute) {
  let head = Buffer.alloc(0);
  try {
    const handle = await fs.open(absolute, 'r');
    try {
      const buffer = Buffer.alloc(8);
      const { bytesRead } = await handle.read(buffer, 0, 8, 0);
      head = buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
  if (head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b) return 'zip';
  if (
    head.length >= 8 &&
    head[0] === 0xd0 &&
    head[1] === 0xcf &&
    head[2] === 0x11 &&
    head[3] === 0xe0
  ) {
    return 'ole2';
  }
  return 'text';
}

/**
 * Reading and writing workbooks, and saying which formats are available.
 *
 * A thin layer: the work is in the per-format modules. What lives here is the
 * decision of *which* one to use, and the limits that keep a malformed file
 * from being believed.
 */
export class SheetService {
  #limits;

  constructor({ limits = {} } = {}) {
    this.#limits = { ...DEFAULT_LIMITS, ...limits };
  }

  get limits() {
    return this.#limits;
  }

  /**
   * All four formats, read and write, always. Reported in the same shape as
   * the archive capabilities so the widget can treat them alike — but here
   * nothing depends on what happens to be installed.
   */
  capabilities() {
    const result = {};
    for (const id of SHEET_FORMAT_IDS) {
      const format = SHEET_FORMATS[id];
      result[id] = {
        read: true,
        write: true,
        label: format.label,
        extensions: format.extensions,
        singleSheet: format.singleSheet,
      };
    }
    return result;
  }

  /**
   * Which format a file is.
   *
   * The name is the starting point, but the bytes overrule it where they
   * disagree in a way that matters: a `.xls` that is really a zip is an xlsx
   * someone renamed, and reading it as BIFF8 would fail confusingly. The one
   * thing the bytes cannot settle is xlsx versus ods — both are zips — so the
   * name decides between those.
   */
  async detect(absolute, name) {
    const byName = sheetFormatOf(name);
    const shape = await sniff(absolute);

    if (shape === 'ole2') return SHEET_FORMATS.xls;
    if (shape === 'zip') {
      if (byName && (byName.id === 'xlsx' || byName.id === 'ods')) return byName;
      return SHEET_FORMATS.xlsx;
    }
    if (shape === 'text') {
      // A text file named .xls or .xlsx is neither; treat it as delimited text
      // rather than failing, which is what such files almost always are.
      return SHEET_FORMATS.csv;
    }
    return byName;
  }

  /** Read a file into a workbook. */
  async read(absolute, name) {
    const format = await this.detect(absolute, name);
    if (!format) {
      throw sheetError(415, 'NOT_A_SHEET', 'This file is not a spreadsheet');
    }

    const limits = this.#limits;
    let workbook;
    if (format.id === 'csv') {
      const buffer = await fs.readFile(absolute);
      workbook = readCsv(buffer, { limits, name: path.basename(name, path.extname(name)) || 'CSV' });
    } else if (format.id === 'xlsx') {
      workbook = await readXlsx(absolute, { limits });
    } else if (format.id === 'ods') {
      workbook = await readOds(absolute, { limits });
    } else {
      workbook = await readXls(absolute, { limits });
    }

    assertWithinLimits(workbook, limits);
    workbook.meta = { ...workbook.meta, format: format.id };
    return workbook;
  }

  /**
   * Write a workbook back.
   *
   * @param {string} absolute destination
   * @param {string} name used to pick the format when none is given
   * @param {object} workbook
   * @param {{format?: string}} [options]
   * @returns {Promise<{format: string, warnings: string[]}>}
   */
  async write(absolute, name, workbook, { format: formatId } = {}) {
    const format = formatId ? SHEET_FORMATS[formatId] : sheetFormatOf(name);
    if (!format) {
      throw sheetError(415, 'NOT_A_SHEET', 'Unknown spreadsheet format');
    }

    const prepared = trimWorkbook({
      sheets: (workbook.sheets ?? []).map((sheet, index) => ({
        name: String(sheet.name ?? `Sheet${index + 1}`),
        rows: (sheet.rows ?? []).map((row) => (row ?? []).map((cell) => normaliseCell(cell))),
      })),
      meta: workbook.meta ?? {},
    });
    if (prepared.sheets.length === 0) prepared.sheets.push({ name: 'Sheet1', rows: [] });
    assertWithinLimits(prepared, this.#limits);

    const warnings = [];
    if (format.singleSheet && prepared.sheets.length > 1) {
      // Refused rather than silently truncated: dropping someone's second
      // sheet on save and reporting success is the worst available outcome.
      throw sheetError(
        400,
        'SINGLE_SHEET_FORMAT',
        `${format.label} stores only one sheet, and the workbook has ${prepared.sheets.length}. Save it as xlsx or ods.`
      );
    }

    if (format.id === 'csv') {
      const { buffer, rewritten } = writeCsv(prepared);
      if (rewritten) {
        // Node decodes the single-byte code pages but cannot encode to them.
        warnings.push(
          `The file was in ${prepared.meta.encoding}; it was saved as ${rewritten}, because Node cannot write that encoding.`
        );
      }
      await fs.writeFile(absolute, buffer);
    } else if (format.id === 'xlsx') {
      await writeXlsx(prepared, absolute);
    } else if (format.id === 'ods') {
      await writeOds(prepared, absolute);
    } else {
      await writeXls(prepared, absolute);
    }

    return { format: format.id, warnings };
  }
}

/**
 * Bring a cell from the client back to the shape the writers expect.
 *
 * The editor sends what the user typed, so the type is inferred here rather
 * than trusted: a client that claimed `type: 'number'` with a value of
 * `"; DROP"` would otherwise reach a writer that formats it as a number.
 */
function normaliseCell(cell) {
  if (cell === null || cell === undefined) return coerceCell('');
  if (typeof cell === 'string') return coerceCell(cell);
  if (typeof cell === 'object') {
    // A date is the one type that cannot be recovered from its text, so it is
    // taken at face value when the client says so and the value parses.
    if (cell.type === 'date' && cell.value) {
      const parsed = new Date(cell.value);
      if (!Number.isNaN(parsed.getTime())) {
        return { type: 'date', value: parsed.toISOString(), ...(cell.formula ? { formula: String(cell.formula) } : {}) };
      }
    }
    return coerceCell(cell.text !== undefined ? cell.text : cellText(cell));
  }
  return coerceCell(String(cell));
}

export { sheetError };
