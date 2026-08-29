import { EMPTY_CELL, cellText, coerceCell, sheetError } from './model.js';

/**
 * CSV, read and written the way the files in the wild actually look.
 *
 * RFC 4180 describes comma-separated, double-quoted, CRLF-terminated records
 * and almost nothing exports exactly that. What arrives instead is semicolons
 * (any locale where the comma is a decimal separator), tabs, a byte-order
 * mark, LF endings, and — often enough to matter — windows-1251 rather than
 * UTF-8. So the delimiter, the line ending and the encoding are all detected
 * on the way in and *preserved* on the way out: someone whose colleagues open
 * the file in Excel on a Russian Windows should get their file back the way
 * they gave it, not silently re-encoded.
 */

/** Candidate delimiters, in the order they are guessed. */
const DELIMITERS = [',', ';', '\t', '|'];

/** Fallbacks tried when the bytes are not valid UTF-8, most likely first. */
const FALLBACK_ENCODINGS = ['windows-1251', 'windows-1252'];

/**
 * Work out the encoding and decode.
 *
 * A BOM settles it outright. Otherwise UTF-8 is tried strictly — invalid bytes
 * throw rather than turning into replacement characters — and only when that
 * fails do the single-byte encodings get a turn. Guessing between *those* is
 * not really possible, so the first that decodes wins and the choice is
 * recorded, which at least makes a wrong guess visible and reversible.
 */
export function decodeText(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { text: buffer.subarray(3).toString('utf8'), encoding: 'utf-8', bom: true };
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return {
      text: new TextDecoder('utf-16le').decode(buffer.subarray(2)),
      encoding: 'utf-16le',
      bom: true,
    };
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return {
      text: new TextDecoder('utf-16be').decode(buffer.subarray(2)),
      encoding: 'utf-16be',
      bom: true,
    };
  }

  try {
    return {
      text: new TextDecoder('utf-8', { fatal: true }).decode(buffer),
      encoding: 'utf-8',
      bom: false,
    };
  } catch {
    // Not UTF-8. Fall through to the single-byte encodings.
  }

  for (const encoding of FALLBACK_ENCODINGS) {
    try {
      return { text: new TextDecoder(encoding, { fatal: true }).decode(buffer), encoding, bom: false };
    } catch {
      // Try the next.
    }
  }
  // windows-1252 maps every byte, so this is unreachable in practice; keeping
  // a definite answer beats throwing on a file that is merely unusual.
  return { text: buffer.toString('latin1'), encoding: 'windows-1252', bom: false };
}

/** Encode back, honouring whatever the file used. */
export function encodeText(text, { encoding = 'utf-8', bom = false } = {}) {
  if (encoding === 'utf-8') {
    const body = Buffer.from(text, 'utf8');
    return bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body;
  }
  if (encoding === 'utf-16le' || encoding === 'utf-16be') {
    const le = Buffer.from(text, 'utf16le');
    const body = encoding === 'utf-16le' ? le : le.swap16();
    const mark = encoding === 'utf-16le' ? [0xff, 0xfe] : [0xfe, 0xff];
    return bom ? Buffer.concat([Buffer.from(mark), body]) : body;
  }
  // Node cannot *encode* to the single-byte pages, only decode from them.
  // Rather than mangle the text, the file is written as UTF-8 and the caller
  // is told, which is the one outcome that loses nothing.
  return { rewritten: 'utf-8', buffer: Buffer.from(text, 'utf8') };
}

/**
 * Guess the delimiter by seeing which one yields a consistent column count.
 *
 * Counting occurrences alone picks the wrong character often — a file full of
 * prose with commas in it beats a semicolon-separated one on raw count. What
 * distinguishes the real delimiter is that it splits every line into the same
 * number of fields.
 */
export function detectDelimiter(text) {
  const lines = text.split(/\r\n|\n|\r/).filter((line) => line.trim() !== '').slice(0, 20);
  if (lines.length === 0) return ',';

  let best = ',';
  let bestScore = -1;
  for (const delimiter of DELIMITERS) {
    const counts = lines.map((line) => splitLine(line, delimiter).length);
    const first = counts[0];
    if (first < 2) continue;
    const consistent = counts.every((count) => count === first);
    // Consistency first, then the number of columns as a tie-break.
    const score = (consistent ? 1000 : 0) + first;
    if (score > bestScore) {
      bestScore = score;
      best = delimiter;
    }
  }
  return best;
}

/** Split one line, respecting quotes. Used only for delimiter detection. */
function splitLine(line, delimiter) {
  const fields = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else quoted = false;
      } else current += char;
    } else if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      fields.push(current);
      current = '';
    } else current += char;
  }
  fields.push(current);
  return fields;
}

/**
 * Parse a whole CSV document into rows of raw strings.
 *
 * Quoted fields may contain the delimiter, newlines and doubled quotes, so
 * this cannot be done line by line — the parser has to carry the quoted state
 * across line breaks.
 */
export function parseCsv(text, { delimiter = ',', limits } = {}) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let cells = 0;

  const endField = () => {
    row.push(field);
    field = '';
    cells += 1;
    if (limits && cells > limits.maxCells) {
      throw sheetError(413, 'TOO_MANY_CELLS', 'The file holds too many cells');
    }
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
    if (limits && rows.length > limits.maxRows) {
      throw sheetError(413, 'TOO_MANY_ROWS', 'The file holds too many rows');
    }
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"' && field === '') {
      quoted = true;
    } else if (char === delimiter) {
      endField();
    } else if (char === '\r') {
      if (text[i + 1] === '\n') i += 1;
      endRow();
    } else if (char === '\n') {
      endRow();
    } else {
      field += char;
    }
  }

  // A file ending in a newline has no trailing empty record; one that does not
  // still has its last row to flush.
  if (field !== '' || row.length > 0) endRow();
  return rows;
}

/** Quote a field only when it would otherwise be misread. */
function quoteField(value, delimiter) {
  const needsQuotes =
    value.includes(delimiter) ||
    value.includes('"') ||
    value.includes('\n') ||
    value.includes('\r') ||
    value !== value.trim();
  if (!needsQuotes) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

export function serializeCsv(rows, { delimiter = ',', newline = '\r\n' } = {}) {
  return rows
    .map((row) => row.map((value) => quoteField(String(value ?? ''), delimiter)).join(delimiter))
    .join(newline);
}

/**
 * Read a CSV buffer into a workbook.
 *
 * Everything learned about the file — its delimiter, line ending, encoding and
 * byte-order mark — is kept in `meta` so writing it back reproduces the same
 * shape rather than imposing this project's preferences on someone else's file.
 */
export function readCsv(buffer, { limits, name = 'CSV' } = {}) {
  const { text, encoding, bom } = decodeText(buffer);
  const delimiter = detectDelimiter(text);
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const rows = parseCsv(text, { delimiter, limits });

  return {
    sheets: [
      {
        name,
        rows: rows.map((row) => row.map((value) => (value === '' ? { ...EMPTY_CELL } : coerceCell(value)))),
      },
    ],
    meta: { format: 'csv', delimiter, newline, encoding, bom },
  };
}

/**
 * Write a workbook back as CSV.
 *
 * Only the first sheet: the format has no way to hold a second, and quietly
 * dropping the others would lose data without saying so — the caller checks
 * for that and refuses.
 */
export function writeCsv(workbook) {
  const meta = workbook.meta ?? {};
  const sheet = workbook.sheets[0] ?? { rows: [] };
  const text = serializeCsv(
    sheet.rows.map((row) => row.map((cell) => cellText(cell))),
    { delimiter: meta.delimiter ?? ',', newline: meta.newline ?? '\r\n' }
  );

  const encoded = encodeText(text, { encoding: meta.encoding ?? 'utf-8', bom: meta.bom ?? false });
  if (Buffer.isBuffer(encoded)) return { buffer: encoded, rewritten: null };
  return { buffer: encoded.buffer, rewritten: encoded.rewritten };
}
