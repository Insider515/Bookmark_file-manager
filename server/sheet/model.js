/**
 * The neutral workbook every format is read into and written out of.
 *
 * Four formats meet here — csv, xlsx, ods and xls — and pairing them off
 * directly would mean twelve conversions. One shape in the middle makes it
 * four readers and four writers, and means the editor in the browser only ever
 * deals with one thing.
 *
 * A workbook is:
 *
 *   { sheets: [ { name, rows: [ [cell, ...], ... ] } ], meta }
 *
 * and a cell is `{ type, value, formula? }`. `value` holds the typed value —
 * a number stays a number — while `formula` keeps the text of a formula whose
 * result the value already is. Nothing here evaluates formulas: a spreadsheet
 * file stores the last computed result alongside the expression, and showing
 * that is honest, whereas recomputing it would need an engine this project has
 * no business carrying.
 */

/** Cell kinds. `empty` is distinct from an empty string: one was never filled. */
export const CELL_TYPES = ['empty', 'string', 'number', 'boolean', 'date'];

export const EMPTY_CELL = Object.freeze({ type: 'empty', value: null });

/** Upper bounds, so a malformed file cannot ask for unbounded memory. */
export const DEFAULT_LIMITS = {
  maxSheets: 64,
  maxRows: 100000,
  maxColumns: 1024,
  maxCells: 2000000,
  /** Characters in one cell. */
  maxCellLength: 32767,
};

export function makeCell(type, value, formula) {
  const cell = { type, value };
  if (formula) cell.formula = formula;
  return cell;
}

/**
 * Turn what a user typed into a typed cell.
 *
 * The rules are the ones every spreadsheet uses and users expect: a leading
 * `=` is a formula, something that parses cleanly as a number is a number, and
 * everything else is text. Deliberately *not* clever about it — guessing dates
 * out of "01/02/03" gets the day and month wrong half the world over, so a
 * date only appears here when the file said so.
 */
export function coerceCell(text) {
  if (text === null || text === undefined) return { ...EMPTY_CELL };
  const value = String(text);
  if (value === '') return { ...EMPTY_CELL };

  if (value.startsWith('=')) {
    // The result is unknown until something computes it; the text is kept and
    // the displayed value is the formula itself.
    return { type: 'string', value, formula: value.slice(1) };
  }

  const trimmed = value.trim();
  if (trimmed !== '' && /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) {
    const parsed = Number(trimmed);
    // Beyond this a double silently loses digits, and "12345678901234567890"
    // coming back as a different number is worse than keeping it as text.
    if (Number.isFinite(parsed) && Math.abs(parsed) <= Number.MAX_SAFE_INTEGER) {
      return { type: 'number', value: parsed };
    }
  }

  if (trimmed === 'TRUE' || trimmed === 'FALSE') {
    return { type: 'boolean', value: trimmed === 'TRUE' };
  }

  return { type: 'string', value };
}

/** What a cell shows. Formulas display as their text, since nothing evaluates. */
export function cellText(cell) {
  if (!cell || cell.type === 'empty' || cell.value === null) return '';
  if (cell.formula) return `=${cell.formula}`;
  if (cell.type === 'boolean') return cell.value ? 'TRUE' : 'FALSE';
  return String(cell.value);
}

/** An empty workbook with one sheet, for creating a file from nothing. */
export function emptyWorkbook(sheetName = 'Sheet1') {
  return { sheets: [{ name: sheetName, rows: [] }], meta: {} };
}

/**
 * Trim trailing empty cells and rows.
 *
 * Worth doing on the way out: a grid edited in the browser is rectangular,
 * and writing its blank right-hand columns would turn a three-column sheet
 * into a twenty-six-column one every time it was saved.
 */
export function trimWorkbook(workbook) {
  for (const sheet of workbook.sheets) {
    for (const row of sheet.rows) {
      while (row.length > 0 && isBlank(row[row.length - 1])) row.pop();
    }
    while (sheet.rows.length > 0 && sheet.rows[sheet.rows.length - 1].length === 0) {
      sheet.rows.pop();
    }
  }
  return workbook;
}

export function isBlank(cell) {
  return !cell || cell.type === 'empty' || cell.value === null || cell.value === '';
}

/** Widest row in a sheet, which is how many columns it has. */
export function sheetWidth(sheet) {
  let width = 0;
  for (const row of sheet.rows) if (row.length > width) width = row.length;
  return width;
}

/**
 * Check a workbook against the limits, throwing rather than truncating.
 *
 * Silently dropping the tail of someone's spreadsheet and calling it a save is
 * the worst available outcome, so this refuses instead.
 */
export function assertWithinLimits(workbook, limits = DEFAULT_LIMITS) {
  if (workbook.sheets.length > limits.maxSheets) {
    throw sheetError(413, 'TOO_MANY_SHEETS', `More than ${limits.maxSheets} sheets is not supported`);
  }
  let cells = 0;
  for (const sheet of workbook.sheets) {
    if (sheet.rows.length > limits.maxRows) {
      throw sheetError(413, 'TOO_MANY_ROWS', `More than ${limits.maxRows} rows is not supported`);
    }
    for (const row of sheet.rows) {
      if (row.length > limits.maxColumns) {
        throw sheetError(413, 'TOO_MANY_COLUMNS', `More than ${limits.maxColumns} columns is not supported`);
      }
      cells += row.length;
      if (cells > limits.maxCells) {
        throw sheetError(413, 'TOO_MANY_CELLS', `More than ${limits.maxCells} cells is not supported`);
      }
      for (const cell of row) {
        if (cell?.type === 'string' && String(cell.value).length > limits.maxCellLength) {
          throw sheetError(413, 'CELL_TOO_LONG', 'The cell value is too large');
        }
      }
    }
  }
  return workbook;
}

export function sheetError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

/**
 * A1-style reference from zero-based indices: (0, 0) is "A1", (0, 26) is "AA1".
 * Needed by the xlsx writer, which addresses every cell by name.
 */
export function toReference(rowIndex, columnIndex) {
  let column = '';
  let n = columnIndex;
  do {
    column = String.fromCharCode(65 + (n % 26)) + column;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return `${column}${rowIndex + 1}`;
}

/** The inverse: "AA12" back to {row: 11, column: 26}. Null when unparsable. */
export function fromReference(reference) {
  const match = /^([A-Za-z]+)(\d+)$/.exec(String(reference).trim());
  if (!match) return null;
  let column = 0;
  for (const char of match[1].toUpperCase()) {
    column = column * 26 + (char.charCodeAt(0) - 64);
  }
  return { row: Number.parseInt(match[2], 10) - 1, column: column - 1 };
}
