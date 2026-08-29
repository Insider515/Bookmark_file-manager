import fs from 'node:fs/promises';

import { CompoundFile, buildCompoundFile } from './cfb.js';
import { DEFAULT_LIMITS, EMPTY_CELL, cellText, makeCell, sheetError } from './model.js';
import { dateToSerial, serialToDate } from './xlsx.js';

/**
 * xls — BIFF8, the binary format Excel used until 2007.
 *
 * The file is a stream of records inside an OLE2 container (see cfb.js). Each
 * record is a 2-byte type, a 2-byte length, and that many bytes; a record may
 * not exceed 8224 bytes of data, so anything longer continues into CONTINUE
 * records that a reader has to stitch back together.
 *
 * Formulas are read as the *result* the file has cached, not as their text:
 * BIFF8 stores an expression as a stream of RPN tokens, and turning those back
 * into "=B2*2" is a decompiler this project has no reason to carry. A cell
 * whose formula was never evaluated therefore reads as empty, which is exactly
 * what the file holds for it.
 *
 * Otherwise only values are handled. Formatting, charts, merged ranges,
 * validation and macros are skipped on read and **not written back** — the same caveat as
 * xlsx, and the caller warns about it before overwriting a file it did not
 * create.
 */

const RECORD = {
  FORMULA: 0x0006,
  EOF: 0x000a,
  CALCCOUNT: 0x000c,
  BOUNDSHEET: 0x0085,
  CONTINUE: 0x003c,
  SST: 0x00fc,
  LABELSST: 0x00fd,
  MULRK: 0x00bd,
  MULBLANK: 0x00be,
  BLANK: 0x0201,
  NUMBER: 0x0203,
  LABEL: 0x0204,
  BOOLERR: 0x0205,
  STRING: 0x0207,
  RK: 0x027e,
  BOF: 0x0809,
  DIMENSIONS: 0x0200,
  ROW: 0x0208,
  XF: 0x00e0,
  FORMAT: 0x041e,
  CODEPAGE: 0x0042,
  DATEMODE: 0x0022,
  WINDOW1: 0x003d,
  FONT: 0x0031,
  STYLE: 0x0293,
  EXTSST: 0x00ff,
};

/** Data bytes one record may hold before it has to continue. */
const MAX_RECORD = 8224;

/** Built-in number-format ids that mean a date, as in xlsx. */
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

function looksLikeDateFormat(code) {
  if (!code) return false;
  const stripped = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '');
  return /[ymdhs]/i.test(stripped);
}

/**
 * Decode a BIFF8 Unicode string.
 *
 * The encoding is per-string, not per-file: one flags byte says whether the
 * characters are 8-bit (a Latin-1 subset) or 16-bit, and rich-text runs and
 * "phonetic" data may follow the characters. Getting the skip lengths wrong
 * desynchronises everything after it, which is why the byte count consumed is
 * returned rather than assumed.
 */
function readUnicodeString(buffer, offset, lengthBytes = 2) {
  const charCount =
    lengthBytes === 2 ? buffer.readUInt16LE(offset) : buffer.readUInt8(offset);
  let cursor = offset + lengthBytes;
  const flags = buffer.readUInt8(cursor);
  cursor += 1;

  const wide = (flags & 0x01) !== 0;
  const rich = (flags & 0x08) !== 0;
  const extended = (flags & 0x04) !== 0;

  let runCount = 0;
  let extSize = 0;
  if (rich) {
    runCount = buffer.readUInt16LE(cursor);
    cursor += 2;
  }
  if (extended) {
    extSize = buffer.readUInt32LE(cursor);
    cursor += 4;
  }

  const byteLength = wide ? charCount * 2 : charCount;
  const raw = buffer.subarray(cursor, cursor + byteLength);
  const text = wide ? raw.toString('utf16le') : decodeLatin(raw);
  cursor += byteLength;
  cursor += runCount * 4 + extSize;

  return { text, length: cursor - offset };
}

/** BIFF8's 8-bit strings are code page 1252 for the characters that matter. */
function decodeLatin(buffer) {
  return buffer.toString('latin1');
}

/**
 * RK is a packed number: two flag bits in the low end, the value in the rest.
 * It exists because most spreadsheet numbers are small integers or two-decimal
 * money, and a full IEEE double for each would double the file.
 */
function decodeRk(value) {
  let result;
  if (value & 0x02) {
    // The top 30 bits are a signed integer.
    result = value >> 2;
  } else {
    // The top 30 bits are the *high* half of a double, the rest zero.
    const bytes = Buffer.alloc(8);
    bytes.writeInt32LE(value & 0xfffffffc, 4);
    result = bytes.readDoubleLE(0);
  }
  return value & 0x01 ? result / 100 : result;
}

/** The inverse, when the number fits; null when a full double is needed. */
function encodeRk(value) {
  if (Number.isInteger(value) && value >= -(1 << 29) && value < 1 << 29) {
    return ((value << 2) | 0x02) >>> 0;
  }
  const hundredths = value * 100;
  if (
    Number.isInteger(hundredths) &&
    hundredths >= -(1 << 29) &&
    hundredths < 1 << 29
  ) {
    return (((hundredths << 2) | 0x02) | 0x01) >>> 0;
  }
  // A double whose low 34 bits are zero survives the truncation exactly.
  const bytes = Buffer.alloc(8);
  bytes.writeDoubleLE(value, 0);
  if (bytes.readUInt32LE(0) === 0 && (bytes.readUInt32LE(4) & 0x03) === 0) {
    return bytes.readUInt32LE(4) >>> 0;
  }
  return null;
}

/** Walk the record stream, stitching CONTINUE records onto their owner. */
function* records(stream) {
  let offset = 0;
  while (offset + 4 <= stream.length) {
    const type = stream.readUInt16LE(offset);
    const length = stream.readUInt16LE(offset + 2);
    if (offset + 4 + length > stream.length) return;

    let data = stream.subarray(offset + 4, offset + 4 + length);
    offset += 4 + length;

    // SST is the record that routinely continues; a reader that ignores this
    // sees a truncated string table and every LABELSST after it points at
    // nothing.
    if (type === RECORD.SST) {
      const parts = [data];
      const boundaries = [];
      while (offset + 4 <= stream.length && stream.readUInt16LE(offset) === RECORD.CONTINUE) {
        const continueLength = stream.readUInt16LE(offset + 2);
        boundaries.push(parts.reduce((sum, part) => sum + part.length, 0));
        parts.push(stream.subarray(offset + 4, offset + 4 + continueLength));
        offset += 4 + continueLength;
      }
      yield { type, data: Buffer.concat(parts), boundaries };
      continue;
    }

    yield { type, data, boundaries: [] };
  }
}

/**
 * The shared string table.
 *
 * The hard part is CONTINUE. When a string runs past the end of a record it
 * resumes in the next one — and the first byte there is a *flags* byte, not
 * string data. It even re-declares the width, so the same string can be 8-bit
 * in one record and 16-bit in the next.
 *
 * Concatenating the records and reading straight through therefore reads that
 * flags byte as a character, and every string after it comes out shifted. The
 * boundaries have to be known and stepped over, which is what the walk below
 * does.
 *
 * @param {Buffer} data the records' payloads, concatenated
 * @param {number[]} boundaries absolute offsets where each continuation began
 */
function parseSst(data, boundaries) {
  const strings = [];
  if (data.length < 8) return strings;
  const uniqueCount = data.readUInt32LE(4);
  const boundarySet = new Set(boundaries);
  let offset = 8;

  /** Bytes until the next continuation begins, or to the end. */
  const untilBoundary = (from) => {
    let nearest = data.length;
    for (const boundary of boundaries) {
      if (boundary > from && boundary < nearest) nearest = boundary;
    }
    return nearest - from;
  };

  for (let index = 0; index < uniqueCount && offset + 3 <= data.length; index += 1) {
    const charCount = data.readUInt16LE(offset);
    let cursor = offset + 2;
    let flags = data.readUInt8(cursor);
    cursor += 1;
    let wide = (flags & 0x01) !== 0;
    const rich = (flags & 0x08) !== 0;
    const extended = (flags & 0x04) !== 0;

    let runCount = 0;
    let extSize = 0;
    if (rich) {
      runCount = data.readUInt16LE(cursor);
      cursor += 2;
    }
    if (extended) {
      extSize = data.readUInt32LE(cursor);
      cursor += 4;
    }

    let remaining = charCount;
    let text = '';
    while (remaining > 0 && cursor < data.length) {
      const available = untilBoundary(cursor);
      const wanted = wide ? remaining * 2 : remaining;
      const take = Math.min(available, wanted);
      const chunk = data.subarray(cursor, cursor + take);
      text += wide ? chunk.toString('utf16le') : chunk.toString('latin1');
      remaining -= wide ? Math.floor(take / 2) : take;
      cursor += take;

      if (remaining > 0) {
        // The string continues in the next record, which restates the width.
        if (!boundarySet.has(cursor)) break; // malformed; stop rather than loop
        flags = data.readUInt8(cursor);
        cursor += 1;
        wide = (flags & 0x01) !== 0;
      }
    }

    strings.push(text);
    offset = cursor + runCount * 4 + extSize;
  }
  return strings;
}

function parseFormats(stream) {
  const formats = new Map();
  const xfFormatIds = [];
  for (const { type, data } of records(stream)) {
    if (type === RECORD.FORMAT && data.length >= 4) {
      const id = data.readUInt16LE(0);
      const { text } = readUnicodeString(data, 2, 2);
      formats.set(id, text);
    } else if (type === RECORD.XF && data.length >= 4) {
      xfFormatIds.push(data.readUInt16LE(2));
    } else if (type === RECORD.BOUNDSHEET) {
      // The globals are done once sheet definitions start.
      break;
    }
  }
  return { formats, xfFormatIds };
}

/** Read an .xls into a workbook. */
export async function readXls(absolute, { limits = DEFAULT_LIMITS } = {}) {
  const buffer = await fs.readFile(absolute);
  if (!CompoundFile.isCompoundFile(buffer)) {
    throw sheetError(422, 'NOT_A_WORKBOOK', 'The file is not an Excel workbook (no OLE2 container)');
  }

  const container = new CompoundFile(buffer);
  const stream = container.read('Workbook') ?? container.read('Book');
  if (!stream) {
    throw sheetError(422, 'NOT_A_WORKBOOK', 'The container has no Workbook stream');
  }

  // First pass: globals — string table, number formats, sheet directory.
  let sharedStrings = [];
  const sheetDirectory = [];
  const { formats, xfFormatIds } = parseFormats(stream);

  for (const { type, data, boundaries } of records(stream)) {
    if (type === RECORD.SST) {
      sharedStrings = parseSst(data, boundaries);
    } else if (type === RECORD.BOUNDSHEET && data.length >= 6) {
      const position = data.readUInt32LE(0);
      const { text } = readUnicodeString(data, 6, 1);
      sheetDirectory.push({ name: text, position });
    } else if (type === RECORD.EOF && sheetDirectory.length > 0) {
      break; // end of the globals substream
    }
  }

  if (sheetDirectory.length === 0) {
    throw sheetError(422, 'NOT_A_WORKBOOK', 'The workbook has no sheets');
  }
  if (sheetDirectory.length > limits.maxSheets) {
    throw sheetError(413, 'TOO_MANY_SHEETS', 'The workbook has too many sheets');
  }

  const isDate = (xfIndex) => {
    const formatId = xfFormatIds[xfIndex];
    if (formatId === undefined) return false;
    return BUILTIN_DATE_FORMATS.has(formatId) || looksLikeDateFormat(formats.get(formatId));
  };

  const sheets = sheetDirectory.map((entry) =>
    readSheet(stream.subarray(entry.position), {
      name: entry.name,
      sharedStrings,
      isDate,
      limits,
    })
  );

  return { sheets, meta: { format: 'xls' } };
}

function readSheet(stream, { name, sharedStrings, isDate, limits }) {
  const rows = [];
  let cellCount = 0;
  let pendingFormulaCell = null;

  const place = (rowIndex, columnIndex, cell) => {
    if (limits && rowIndex >= limits.maxRows) {
      throw sheetError(413, 'TOO_MANY_ROWS', 'The sheet has too many rows');
    }
    if (limits && columnIndex >= limits.maxColumns) {
      throw sheetError(413, 'TOO_MANY_COLUMNS', 'The sheet has too many columns');
    }
    cellCount += 1;
    if (limits && cellCount > limits.maxCells) {
      throw sheetError(413, 'TOO_MANY_CELLS', 'The workbook has too many cells');
    }
    while (rows.length <= rowIndex) rows.push([]);
    const row = rows[rowIndex];
    while (row.length < columnIndex) row.push({ ...EMPTY_CELL });
    row[columnIndex] = cell;
  };

  const numberCell = (rowIndex, columnIndex, xfIndex, value) =>
    place(
      rowIndex,
      columnIndex,
      isDate(xfIndex)
        ? makeCell('date', serialToDate(value).toISOString())
        : makeCell('number', value)
    );

  let started = false;
  for (const { type, data } of records(stream)) {
    if (type === RECORD.BOF) {
      if (started) break; // the next substream: this sheet is done
      started = true;
      continue;
    }
    if (type === RECORD.EOF) break;

    switch (type) {
      case RECORD.LABELSST: {
        const index = data.readUInt32LE(6);
        place(
          data.readUInt16LE(0),
          data.readUInt16LE(2),
          makeCell('string', sharedStrings[index] ?? '')
        );
        break;
      }
      case RECORD.LABEL: {
        const { text } = readUnicodeString(data, 6, 2);
        place(data.readUInt16LE(0), data.readUInt16LE(2), makeCell('string', text));
        break;
      }
      case RECORD.NUMBER: {
        numberCell(data.readUInt16LE(0), data.readUInt16LE(2), data.readUInt16LE(4), data.readDoubleLE(6));
        break;
      }
      case RECORD.RK: {
        numberCell(
          data.readUInt16LE(0),
          data.readUInt16LE(2),
          data.readUInt16LE(4),
          decodeRk(data.readInt32LE(6))
        );
        break;
      }
      case RECORD.MULRK: {
        const rowIndex = data.readUInt16LE(0);
        const firstColumn = data.readUInt16LE(2);
        const count = (data.length - 6) / 6;
        for (let i = 0; i < count; i += 1) {
          const base = 4 + i * 6;
          numberCell(rowIndex, firstColumn + i, data.readUInt16LE(base), decodeRk(data.readInt32LE(base + 2)));
        }
        break;
      }
      case RECORD.BOOLERR: {
        const isError = data.readUInt8(7) === 1;
        place(
          data.readUInt16LE(0),
          data.readUInt16LE(2),
          isError
            ? makeCell('string', `#ERR${data.readUInt8(6)}`)
            : makeCell('boolean', data.readUInt8(6) !== 0)
        );
        break;
      }
      case RECORD.FORMULA: {
        const rowIndex = data.readUInt16LE(0);
        const columnIndex = data.readUInt16LE(2);
        const xfIndex = data.readUInt16LE(4);
        // The cached result: a double, unless the two sentinel bytes at the end
        // mark it as a string, boolean or error instead.
        const marker = data.readUInt16LE(12);
        if (marker === 0xffff) {
          // The first byte says which kind of non-numeric result this is.
          // 3 means "empty", which is what a writer stores for a formula it
          // never evaluated — treating it as an error, as an earlier version
          // did, turned every uncalculated formula into "#ERR0".
          const kind = data.readUInt8(6);
          if (kind === 0) {
            // The text arrives in the STRING record that follows.
            pendingFormulaCell = { rowIndex, columnIndex };
          } else if (kind === 1) {
            place(rowIndex, columnIndex, makeCell('boolean', data.readUInt8(8) !== 0));
          } else if (kind === 2) {
            place(rowIndex, columnIndex, makeCell('string', `#ERR${data.readUInt8(8)}`));
          } else {
            place(rowIndex, columnIndex, { ...EMPTY_CELL });
          }
        } else {
          numberCell(rowIndex, columnIndex, xfIndex, data.readDoubleLE(6));
        }
        break;
      }
      case RECORD.STRING: {
        if (pendingFormulaCell) {
          const { text } = readUnicodeString(data, 0, 2);
          place(pendingFormulaCell.rowIndex, pendingFormulaCell.columnIndex, makeCell('string', text));
          pendingFormulaCell = null;
        }
        break;
      }
      case RECORD.BLANK:
      case RECORD.MULBLANK:
        break; // nothing to store
      default:
        break;
    }
  }

  return { name, rows };
}

// ---------------------------------------------------------------- writing

/** One record, or a record plus CONTINUEs when the data is too long. */
function writeRecord(parts, type, data) {
  if (data.length <= MAX_RECORD) {
    const header = Buffer.alloc(4);
    header.writeUInt16LE(type, 0);
    header.writeUInt16LE(data.length, 2);
    parts.push(header, data);
    return;
  }
  let offset = 0;
  let first = true;
  while (offset < data.length) {
    const chunk = data.subarray(offset, offset + MAX_RECORD);
    const header = Buffer.alloc(4);
    header.writeUInt16LE(first ? type : RECORD.CONTINUE, 0);
    header.writeUInt16LE(chunk.length, 2);
    parts.push(header, chunk);
    offset += chunk.length;
    first = false;
  }
}

/** A BIFF8 string: character count, a flags byte, then UTF-16 characters. */
function encodeUnicodeString(text, lengthBytes = 2) {
  const characters = Buffer.from(String(text), 'utf16le');
  const header = Buffer.alloc(lengthBytes + 1);
  const charCount = characters.length / 2;
  if (lengthBytes === 2) header.writeUInt16LE(charCount, 0);
  else header.writeUInt8(Math.min(charCount, 255), 0);
  // Always 16-bit: choosing per string would save a little space and cost a
  // whole class of encoding bug.
  header.writeUInt8(0x01, lengthBytes);
  return Buffer.concat([header, characters]);
}

/**
 * The shared string table.
 *
 * Records are broken only *between* strings wherever possible, because a
 * string split across a CONTINUE has to repeat its flags byte in the
 * continuation — a rule that is easy to get subtly wrong. A string too long to
 * fit a record on its own is split properly, with that byte.
 */
function buildSst(strings, parts) {
  const header = Buffer.alloc(8);
  header.writeUInt32LE(strings.length, 0);
  header.writeUInt32LE(strings.length, 4);

  const chunks = [];
  let body = [header];
  let size = header.length;

  for (const text of strings) {
    const encoded = encodeUnicodeString(text, 2);

    if (encoded.length <= MAX_RECORD) {
      // Break only *between* strings where possible: a split string has to
      // repeat its flags byte in the continuation, and not splitting avoids
      // that rule entirely.
      if (size + encoded.length > MAX_RECORD) {
        chunks.push(Buffer.concat(body));
        body = [];
        size = 0;
      }
      body.push(encoded);
      size += encoded.length;
      continue;
    }

    // Longer than a whole record on its own: split it properly, on a
    // character boundary, repeating the flags byte in each continuation.
    const characters = encoded.subarray(3);
    const firstRoom = MAX_RECORD - size - 3;
    const firstTake = firstRoom - (firstRoom % 2);
    body.push(encoded.subarray(0, 3 + firstTake));
    chunks.push(Buffer.concat(body));
    body = [];
    size = 0;

    let offset = firstTake;
    while (offset < characters.length) {
      const room = MAX_RECORD - 1;
      const take = Math.min(room - (room % 2), characters.length - offset);
      chunks.push(
        Buffer.concat([Buffer.from([0x01]), characters.subarray(offset, offset + take)])
      );
      offset += take;
    }
  }
  if (body.length > 0) chunks.push(Buffer.concat(body));

  chunks.forEach((chunk, index) => {
    const recordHeader = Buffer.alloc(4);
    recordHeader.writeUInt16LE(index === 0 ? RECORD.SST : RECORD.CONTINUE, 0);
    recordHeader.writeUInt16LE(chunk.length, 2);
    parts.push(recordHeader, chunk);
  });
}

/**
 * Write a workbook as .xls.
 *
 * Two passes are unavoidable: BOUNDSHEET records in the globals must carry the
 * byte offset of each sheet's substream, and those offsets depend on how long
 * the globals turned out to be. The globals are therefore built once with
 * placeholder offsets, measured, and the offsets patched in afterwards.
 */
export async function writeXls(workbook, destination) {
  const strings = [];
  const stringIndex = new Map();
  const intern = (text) => {
    const existing = stringIndex.get(text);
    if (existing !== undefined) return existing;
    const index = strings.length;
    strings.push(text);
    stringIndex.set(text, index);
    return index;
  };

  // --- sheet substreams (also fills the string table) ----------------------
  const sheetStreams = workbook.sheets.map((sheet) => {
    const parts = [];
    const bof = Buffer.alloc(16);
    bof.writeUInt16LE(0x0600, 0); // BIFF8
    bof.writeUInt16LE(0x0010, 2); // worksheet substream
    writeRecord(parts, RECORD.BOF, bof);

    const width = sheet.rows.reduce((max, row) => Math.max(max, row.length), 0);
    const dimensions = Buffer.alloc(14);
    dimensions.writeUInt32LE(0, 0);
    dimensions.writeUInt32LE(sheet.rows.length, 4);
    dimensions.writeUInt16LE(0, 8);
    dimensions.writeUInt16LE(width, 10);
    writeRecord(parts, RECORD.DIMENSIONS, dimensions);

    sheet.rows.forEach((row, rowIndex) => {
      row.forEach((cell, columnIndex) => {
        if (!cell || cell.type === 'empty' || cell.value === null || cell.value === '') return;

        if (cell.type === 'number' || cell.type === 'date') {
          const value =
            cell.type === 'date' ? dateToSerial(new Date(cell.value)) : Number(cell.value);
          if (!Number.isFinite(value)) return;
          const xf = cell.type === 'date' ? 16 : 15; // see the XF table below
          const rk = cell.type === 'date' ? null : encodeRk(value);
          if (rk !== null) {
            const data = Buffer.alloc(10);
            data.writeUInt16LE(rowIndex, 0);
            data.writeUInt16LE(columnIndex, 2);
            data.writeUInt16LE(xf, 4);
            data.writeUInt32LE(rk, 6);
            writeRecord(parts, RECORD.RK, data);
          } else {
            const data = Buffer.alloc(14);
            data.writeUInt16LE(rowIndex, 0);
            data.writeUInt16LE(columnIndex, 2);
            data.writeUInt16LE(xf, 4);
            data.writeDoubleLE(value, 6);
            writeRecord(parts, RECORD.NUMBER, data);
          }
          return;
        }

        if (cell.type === 'boolean') {
          const data = Buffer.alloc(8);
          data.writeUInt16LE(rowIndex, 0);
          data.writeUInt16LE(columnIndex, 2);
          data.writeUInt16LE(15, 4);
          data.writeUInt8(cell.value ? 1 : 0, 6);
          data.writeUInt8(0, 7);
          writeRecord(parts, RECORD.BOOLERR, data);
          return;
        }

        const data = Buffer.alloc(10);
        data.writeUInt16LE(rowIndex, 0);
        data.writeUInt16LE(columnIndex, 2);
        data.writeUInt16LE(15, 4);
        data.writeUInt32LE(intern(cellText(cell)), 6);
        writeRecord(parts, RECORD.LABELSST, data);
      });
    });

    writeRecord(parts, RECORD.EOF, Buffer.alloc(0));
    return Buffer.concat(parts);
  });

  // --- globals -------------------------------------------------------------
  const buildGlobals = (offsets) => {
    const parts = [];
    const bof = Buffer.alloc(16);
    bof.writeUInt16LE(0x0600, 0);
    bof.writeUInt16LE(0x0005, 2); // workbook globals
    writeRecord(parts, RECORD.BOF, bof);

    const codepage = Buffer.alloc(2);
    codepage.writeUInt16LE(0x04b0, 0); // UTF-16
    writeRecord(parts, RECORD.CODEPAGE, codepage);

    const dateMode = Buffer.alloc(2);
    dateMode.writeUInt16LE(0, 0); // 1900 date system
    writeRecord(parts, RECORD.DATEMODE, dateMode);

    // One font is the minimum a reader will accept.
    const font = Buffer.alloc(14);
    font.writeUInt16LE(200, 0); // height, twentieths of a point
    font.writeUInt16LE(0, 2);
    font.writeUInt16LE(0x7fff, 4);
    font.writeUInt16LE(400, 6);
    writeRecord(parts, RECORD.FONT, Buffer.concat([font, encodeUnicodeString('Arial', 1)]));

    // A date format, referenced by the XF at index 16.
    const formatId = 164;
    const format = Buffer.alloc(2);
    format.writeUInt16LE(formatId, 0);
    writeRecord(
      parts,
      RECORD.FORMAT,
      Buffer.concat([format, encodeUnicodeString('YYYY-MM-DD HH:MM:SS', 2)])
    );

    // XF 0..14 are the styles Excel expects to exist; 15 is the general cell
    // format and 16 the date one. Writing fewer makes some readers reject the
    // file outright.
    const makeXf = (numberFormat, isStyle) => {
      const xf = Buffer.alloc(20);
      xf.writeUInt16LE(0, 0); // font
      xf.writeUInt16LE(numberFormat, 2);
      xf.writeUInt16LE(isStyle ? 0xfff5 : 0x0001, 4);
      xf.writeUInt16LE(0x0020, 6);
      return xf;
    };
    for (let i = 0; i < 15; i += 1) writeRecord(parts, RECORD.XF, makeXf(0, true));
    writeRecord(parts, RECORD.XF, makeXf(0, false)); // index 15: general
    writeRecord(parts, RECORD.XF, makeXf(formatId, false)); // index 16: date

    workbook.sheets.forEach((sheet, index) => {
      const head = Buffer.alloc(6);
      head.writeUInt32LE(offsets[index] ?? 0, 0);
      head.writeUInt16LE(0, 4); // visible worksheet
      writeRecord(
        parts,
        RECORD.BOUNDSHEET,
        Buffer.concat([head, encodeUnicodeString(String(sheet.name ?? `Sheet${index + 1}`), 1)])
      );
    });

    buildSst(strings, parts);
    writeRecord(parts, RECORD.EOF, Buffer.alloc(0));
    return Buffer.concat(parts);
  };

  // First with placeholders to learn the length, then again with the real
  // offsets — the globals' own size is what those offsets are measured from.
  const probe = buildGlobals(workbook.sheets.map(() => 0));
  const offsets = [];
  let position = probe.length;
  for (const stream of sheetStreams) {
    offsets.push(position);
    position += stream.length;
  }
  const globals = buildGlobals(offsets);
  if (globals.length !== probe.length) {
    throw sheetError(500, 'XLS_LAYOUT', 'The sheet offsets could not be reconciled');
  }

  const workbookStream = Buffer.concat([globals, ...sheetStreams]);
  await fs.writeFile(destination, buildCompoundFile('Workbook', workbookStream));
}
