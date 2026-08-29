import fs from 'node:fs/promises';

import { CompoundFile, buildCompoundFileFrom } from '../sheet/cfb.js';
import { DEFAULT_DOC_LIMITS, docError, makeRun, normaliseRuns } from './model.js';

/**
 * doc — the Word 97–2003 binary format, read without a dependency.
 *
 * This is the least forgiving format in the project. A .doc is an OLE2
 * container (which this codebase already reads, for .xls) holding a
 * `WordDocument` stream and a table stream, and the text inside it is *not*
 * contiguous: it is scattered through the file and reassembled through a piece
 * table, so a naive "pull the printable bytes out" reader produces text in the
 * wrong order the moment a document has been edited and saved more than once.
 *
 * Formatting is stored apart from the text again, in 512-byte pages called
 * FKPs indexed by byte offset, which is why bold has to be looked up per
 * character rather than read alongside it.
 *
 * References: [MS-DOC], the published Word binary format specification.
 */

/** Word writes these as 8-bit text; the high half is CP1252, not Latin-1. */
const CP1252_HIGH = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026,
  0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160,
  0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019,
  0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
  0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153,
  0x9e: 0x017e, 0x9f: 0x0178,
};

const decodeByte = (byte) => String.fromCharCode(CP1252_HIGH[byte] ?? byte);

/** Pair indexes into FibRgFcLcb97, which is a flat array of fc/lcb pairs. */
const PAIR = {
  stshf: 1,
  plcfBteChpx: 12,
  plcfBtePapx: 13,
  sttbfFfn: 15,
  dop: 31,
  clx: 33,
};

/**
 * The File Information Block: where everything else is.
 *
 * The fixed-size parts are read by their declared lengths rather than by
 * hardcoded offsets, because the FIB grew between Word versions and a file
 * from Word 2003 has a longer property table than one from Word 97.
 */
function parseFib(word) {
  if (word.length < 0x0100) {
    throw docError(422, 'NOT_A_DOC', 'The file is too small to be a Word document');
  }
  if (word.readUInt16LE(0) !== 0xa5ec) {
    throw docError(422, 'NOT_A_DOC', 'This is not a Word 97–2003 document');
  }

  const nFib = word.readUInt16LE(2);
  const flags = word.readUInt16LE(0x0a);
  if ((flags & 0x0100) !== 0) {
    throw docError(422, 'DOC_ENCRYPTED', 'The document is password-protected');
  }
  if (nFib < 193) {
    // Word 6/95 has a different FIB with no property table; nothing below
    // would find the right bytes, so it is refused rather than misread.
    throw docError(422, 'DOC_TOO_OLD', 'Word 6.0/95 is not supported — re-save it in Word 97 or later');
  }

  let offset = 32;
  const csw = word.readUInt16LE(offset);
  offset += 2;
  offset += csw * 2;
  const cslw = word.readUInt16LE(offset);
  offset += 2;
  const fibRgLw = offset;
  offset += cslw * 4;
  const cbRgFcLcb = word.readUInt16LE(offset);
  offset += 2;
  const fibRgFcLcb = offset;

  if (fibRgFcLcb + cbRgFcLcb * 8 > word.length) {
    throw docError(422, 'DOC_TRUNCATED', 'The document is corrupt: the offset table runs past the end of the file');
  }

  const pair = (index) => {
    if (index >= cbRgFcLcb) return { fc: 0, lcb: 0 };
    return {
      fc: word.readUInt32LE(fibRgFcLcb + index * 8),
      lcb: word.readUInt32LE(fibRgFcLcb + index * 8 + 4),
    };
  };

  return {
    nFib,
    tableStream: (flags & 0x0200) !== 0 ? '1Table' : '0Table',
    ccpText: cslw >= 4 ? word.readInt32LE(fibRgLw + 12) : 0,
    pair,
  };
}

/**
 * The piece table: which stretch of the file holds which stretch of the text.
 *
 * The CLX is a run of records; the one that matters is the Pcdt, and the
 * others (property groups from a fast save) are skipped by their own lengths.
 */
function parsePieceTable(table, fc, lcb) {
  let index = fc;
  const end = Math.min(fc + lcb, table.length);

  while (index < end) {
    const kind = table[index];
    if (kind === 0x01) {
      // Prc: a group of properties, not text. Skip it by its length.
      if (index + 3 > end) break;
      index += 3 + table.readUInt16LE(index + 1);
      continue;
    }
    if (kind !== 0x02) break;

    if (index + 5 > end) break;
    const size = table.readUInt32LE(index + 1);
    const plc = table.subarray(index + 5, Math.min(index + 5 + size, table.length));
    // A PLC is (n+1) 4-byte positions followed by n fixed-size records; here
    // the records are 8 bytes, so n falls out of the total length.
    const count = Math.floor((plc.length - 4) / 12);
    if (count <= 0) break;

    const pieces = [];
    for (let i = 0; i < count; i += 1) {
      const cpStart = plc.readUInt32LE(i * 4);
      const cpEnd = plc.readUInt32LE((i + 1) * 4);
      const raw = plc.readUInt32LE((count + 1) * 4 + i * 8 + 2);
      const compressed = (raw & 0x40000000) !== 0;
      pieces.push({
        cpStart,
        cpEnd,
        // A compressed piece stores 8-bit text at half the recorded offset.
        offset: compressed ? (raw & 0x3fffffff) / 2 : raw & 0x3fffffff,
        compressed,
      });
    }
    return pieces;
  }
  return [];
}

/**
 * Reassemble the text, keeping each character's byte offset.
 *
 * The offsets are what formatting is looked up by, so they have to survive
 * alongside the characters rather than being recomputed from the string.
 */
function readText(word, pieces, ccpText) {
  const chars = [];
  const offsets = [];

  for (const piece of pieces) {
    const count = Math.max(0, piece.cpEnd - piece.cpStart);
    for (let i = 0; i < count; i += 1) {
      if (piece.compressed) {
        const at = piece.offset + i;
        if (at >= word.length) break;
        chars.push(decodeByte(word[at]));
        offsets.push(at);
      } else {
        const at = piece.offset + i * 2;
        if (at + 1 >= word.length) break;
        chars.push(String.fromCharCode(word.readUInt16LE(at)));
        offsets.push(at);
      }
    }
    if (ccpText > 0 && chars.length >= ccpText) break;
  }
  return { chars, offsets };
}

/** Decode one sprm's operand length from its opcode. See [MS-DOC] 2.6.1. */
function operandLength(sprm, buffer, at) {
  switch ((sprm >> 13) & 0x07) {
    case 0:
    case 1:
      return 1;
    case 2:
    case 4:
    case 5:
      return 2;
    case 3:
      return 4;
    case 7:
      return 3;
    default: {
      // Variable length, given by a leading byte — except for two opcodes
      // whose length byte is itself preceded by other data.
      if (sprm === 0xd608 || sprm === 0xd609) {
        return at + 1 < buffer.length ? 1 + buffer.readUInt16LE(at) : 1;
      }
      return at < buffer.length ? 1 + buffer[at] : 1;
    }
  }
}

const SPRM_BOLD = 0x0835;
const SPRM_ITALIC = 0x0836;
const SPRM_UNDERLINE = 0x2a3e;
const SPRM_ILVL = 0x260a;
const SPRM_ILFO = 0x460b;

/** Read the character marks out of a property group. */
function marksFrom(grpprl) {
  const marks = {};
  let at = 0;
  while (at + 2 <= grpprl.length) {
    const sprm = grpprl.readUInt16LE(at);
    at += 2;
    const size = operandLength(sprm, grpprl, at);
    const operand = grpprl.subarray(at, at + size);
    at += size;
    if (operand.length === 0) continue;

    // A toggle operand of 0 turns the mark off, 1 on; 128/129 mean "inherit"
    // and "invert what the style says", which without style resolution are
    // best read as on — the common case is a style that is not bold.
    const on = operand[0] === 1 || operand[0] === 129;
    if (sprm === SPRM_BOLD && on) marks.bold = true;
    else if (sprm === SPRM_ITALIC && on) marks.italic = true;
    else if (sprm === SPRM_UNDERLINE && operand[0] !== 0) marks.underline = true;
  }
  return marks;
}

/** Read the paragraph-level hints this model can use. */
function paragraphHints(grpprl) {
  const hints = {};
  let at = 0;
  while (at + 2 <= grpprl.length) {
    const sprm = grpprl.readUInt16LE(at);
    at += 2;
    const size = operandLength(sprm, grpprl, at);
    const operand = grpprl.subarray(at, at + size);
    at += size;
    if (sprm === SPRM_ILVL && operand.length >= 1) hints.ilvl = operand[0];
    else if (sprm === SPRM_ILFO && operand.length >= 2) hints.ilfo = operand.readUInt16LE(0);
  }
  return hints;
}

/**
 * Walk the bin table to a flat list of formatted ranges.
 *
 * Properties live in 512-byte pages ("FKPs") scattered through the document
 * stream; the bin table in the table stream says which page numbers to visit.
 * Each page then maps byte ranges to property groups.
 */
function readFkps(word, table, fc, lcb, kind) {
  const ranges = [];
  if (lcb < 4 || fc + lcb > table.length) return ranges;

  const plc = table.subarray(fc, fc + lcb);
  const count = Math.floor((plc.length - 4) / 8);
  for (let i = 0; i < count; i += 1) {
    const page = plc.readUInt32LE((count + 1) * 4 + i * 4) & 0x003fffff;
    const start = page * 512;
    if (start + 512 > word.length) continue;
    const fkp = word.subarray(start, start + 512);

    const runs = fkp[511];
    const stride = kind === 'papx' ? 13 : 1;
    if ((runs + 1) * 4 + runs * stride > 511) continue;

    for (let run = 0; run < runs; run += 1) {
      const from = fkp.readUInt32LE(run * 4);
      const to = fkp.readUInt32LE((run + 1) * 4);
      const word0 = fkp[(runs + 1) * 4 + run * stride];
      if (word0 === 0) {
        ranges.push({ from, to, grpprl: Buffer.alloc(0), istd: 0 });
        continue;
      }

      const at = word0 * 2;
      if (kind === 'papx') {
        // A PAPX records its length in words, and a zero there means the real
        // length is in the following byte — a compression that only exists
        // because these pages are a fixed 512 bytes.
        let length = fkp[at] * 2;
        let base = at + 1;
        if (fkp[at] === 0) {
          length = fkp[at + 1] * 2;
          base = at + 2;
        } else {
          length -= 1;
        }
        if (base + length > 512 || length < 2) continue;
        ranges.push({
          from,
          to,
          istd: fkp.readUInt16LE(base),
          grpprl: Buffer.from(fkp.subarray(base + 2, base + length)),
        });
      } else {
        const length = fkp[at];
        if (at + 1 + length > 512) continue;
        ranges.push({ from, to, istd: 0, grpprl: Buffer.from(fkp.subarray(at + 1, at + 1 + length)) });
      }
    }
  }
  ranges.sort((a, b) => a.from - b.from);
  return ranges;
}

/** The range covering a byte offset, by binary search. */
function rangeAt(ranges, offset) {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (offset < ranges[mid].from) high = mid - 1;
    else if (offset >= ranges[mid].to) low = mid + 1;
    else return ranges[mid];
  }
  return null;
}

/**
 * The stylesheet, for the one thing this model needs from it: which style
 * index means "heading 1".
 *
 * Built-in styles are identified by a numeric id rather than their name, which
 * is what makes this work for a document written in any language.
 */
function readStyles(table, fc, lcb) {
  const styles = [];
  if (lcb < 2 || fc + lcb > table.length) return styles;

  const stsh = table.subarray(fc, fc + lcb);
  const cbStshi = stsh.readUInt16LE(0);
  let at = 2 + cbStshi;

  while (at + 2 <= stsh.length) {
    const cbStd = stsh.readUInt16LE(at);
    at += 2;
    if (cbStd === 0) {
      styles.push(null);
      continue;
    }
    if (at + cbStd > stsh.length) break;
    const std = stsh.subarray(at, at + cbStd);
    at += cbStd;

    const sti = std.length >= 2 ? std.readUInt16LE(0) & 0x0fff : 0xfff;
    let name = '';
    if (std.length >= 12) {
      const cch = std.readUInt16LE(10);
      if (cch > 0 && 12 + cch * 2 <= std.length) {
        name = std.subarray(12, 12 + cch * 2).toString('utf16le');
      }
    }
    styles.push({ sti, name });
  }
  return styles;
}

const LIST_NAME = /^(list|список)/i;

export async function readDoc(absolute, { limits = DEFAULT_DOC_LIMITS } = {}) {
  const stat = await fs.stat(absolute);
  if (stat.size > limits.maxBytes) {
    throw docError(413, 'DOCUMENT_TOO_LARGE', 'The document is too large');
  }

  const buffer = await fs.readFile(absolute);
  if (!CompoundFile.isCompoundFile(buffer)) {
    throw docError(422, 'NOT_A_DOC', 'This is not a Word 97–2003 document');
  }

  const container = new CompoundFile(buffer);
  const word = container.read('WordDocument');
  if (!word) {
    throw docError(422, 'NOT_A_DOC', 'The container has no WordDocument stream');
  }

  const fib = parseFib(word);
  const table = container.read(fib.tableStream) ?? Buffer.alloc(0);

  const clx = fib.pair(PAIR.clx);
  const pieces = parsePieceTable(table, clx.fc, clx.lcb);
  if (pieces.length === 0) {
    throw docError(422, 'DOC_NO_TEXT', 'The document has no piece table — the file is corrupt');
  }

  const { chars, offsets } = readText(word, pieces, fib.ccpText);
  if (chars.length > limits.maxCharacters) {
    throw docError(413, 'DOCUMENT_TOO_LONG', 'The document is too large');
  }

  const stshf = fib.pair(PAIR.stshf);
  const bteChpx = fib.pair(PAIR.plcfBteChpx);
  const btePapx = fib.pair(PAIR.plcfBtePapx);
  const styles = readStyles(table, stshf.fc, stshf.lcb);
  const chpx = readFkps(word, table, bteChpx.fc, bteChpx.lcb, 'chpx');
  const papx = readFkps(word, table, btePapx.fc, btePapx.lcb, 'papx');

  const blocks = [];
  let runs = [];
  let text = '';
  let marks = {};
  let inField = 0; // >0 while inside a field's instruction, which is not text
  let inTable = false;

  const flushRun = () => {
    if (text) runs.push(makeRun(text, marks));
    text = '';
  };

  const flushBlock = (markOffset) => {
    flushRun();
    const paragraph = markOffset === null ? null : rangeAt(papx, markOffset);
    const style = paragraph ? styles[paragraph.istd] : null;
    const hints = paragraph ? paragraphHints(paragraph.grpprl) : {};

    let block;
    if (style && style.sti >= 1 && style.sti <= 9) {
      block = { type: 'heading', level: Math.min(6, style.sti), runs: normaliseRuns(runs) };
    } else if (hints.ilfo > 0 || (style && LIST_NAME.test(style.name))) {
      block = { type: 'listItem', level: (hints.ilvl ?? 0) + 1, ordered: false, runs: normaliseRuns(runs) };
    } else {
      block = { type: 'paragraph', runs: normaliseRuns(runs) };
    }
    if (inTable) block.inTable = true;
    if (style?.name) block.style = style.name;

    blocks.push(block);
    runs = [];
    inTable = false;
    if (blocks.length > limits.maxBlocks) {
      throw docError(413, 'TOO_MANY_BLOCKS', 'The document has too many paragraphs');
    }
  };

  const limit = fib.ccpText > 0 ? Math.min(chars.length, fib.ccpText) : chars.length;
  for (let i = 0; i < limit; i += 1) {
    const char = chars[i];
    const code = char.charCodeAt(0);
    const offset = offsets[i];

    if (code === 0x13) {
      inField += 1;
      continue;
    }
    if (code === 0x14) {
      // The instruction ends and the visible result begins.
      inField = Math.max(0, inField - 1);
      continue;
    }
    if (code === 0x15) {
      inField = Math.max(0, inField - 1);
      continue;
    }
    if (inField > 0) continue;

    if (code === 0x0d) {
      flushBlock(offset);
      continue;
    }
    if (code === 0x07) {
      // End of a table cell or row; each cell reads as its own paragraph.
      inTable = true;
      flushBlock(offset);
      continue;
    }
    if (code === 0x0b) {
      text += '\n';
      continue;
    }
    // Anchors for pictures, footnotes and drawings carry no text of their own.
    if (code <= 0x08 || code === 0x0c || code === 0x0e || code === 0x1e) continue;
    if (code === 0x1f) continue;

    const next = rangeAt(chpx, offset);
    const nextMarks = next ? marksFrom(next.grpprl) : {};
    if (
      Boolean(nextMarks.bold) !== Boolean(marks.bold) ||
      Boolean(nextMarks.italic) !== Boolean(marks.italic) ||
      Boolean(nextMarks.underline) !== Boolean(marks.underline)
    ) {
      flushRun();
      marks = nextMarks;
    }
    text += char === ' ' ? ' ' : char;
  }
  flushRun();
  if (runs.length > 0) flushBlock(null);

  // Word keeps a final paragraph mark that is structure, not content.
  if (blocks.length > 1) {
    const last = blocks[blocks.length - 1];
    if ((last.runs ?? []).every((run) => run.text === '')) blocks.pop();
  }
  if (blocks.length === 0) blocks.push({ type: 'paragraph', runs: [makeRun('')] });

  blocks.forEach((block, index) => { block.id = index; });
  return { blocks, meta: { format: 'doc', nFib: fib.nFib } };
}

/* ------------------------------------------------------------------------ *
 * Writing
 *
 * Unlike docx and odt, there is no original markup to fall back on here: a
 * .doc is rebuilt from nothing every time it is saved. So this half writes a
 * complete, minimal Word 97 document — stylesheet, piece table, property
 * pages, section and font tables — and the caller is told what a document of
 * this shape cannot carry.
 * ------------------------------------------------------------------------ */

/** Text begins on a sector boundary, past the header block. */
const TEXT_START = 0x800;
const FKP_SIZE = 512;

const SPRM_BOLD_SET = Buffer.from([0x35, 0x08, 0x01]);
const SPRM_ITALIC_SET = Buffer.from([0x36, 0x08, 0x01]);
const SPRM_UNDERLINE_SET = Buffer.from([0x3e, 0x2a, 0x01]);

/** sprmPDxaLeft — the indent that stands in for a list marker. */
const indentSprm = (twips) => {
  const out = Buffer.alloc(4);
  out.writeUInt16LE(0x840f, 0);
  out.writeInt16LE(twips, 2);
  return out;
};

/** sprmCHps — font size in half-points. */
const sizeSprm = (halfPoints) => {
  const out = Buffer.alloc(4);
  out.writeUInt16LE(0x4a43, 0);
  out.writeUInt16LE(halfPoints, 2);
  return out;
};

function chpxFor(run) {
  const parts = [];
  if (run.bold) parts.push(SPRM_BOLD_SET);
  if (run.italic) parts.push(SPRM_ITALIC_SET);
  if (run.underline) parts.push(SPRM_UNDERLINE_SET);
  return Buffer.concat(parts);
}

/**
 * Lay the document out as one flat run of UTF-16 text, remembering where each
 * formatting run and each paragraph begins.
 *
 * Word marks the end of a paragraph with a carriage return that is part of the
 * text, so the paragraph's own properties are found by the position of that
 * mark rather than of its first character.
 */
function layOutText(blocks) {
  const units = [];
  const runs = [];
  const paragraphs = [];

  for (const block of blocks) {
    const start = units.length;
    for (const run of normaliseRuns(block.runs ?? [])) {
      const from = units.length;
      const text = String(run.text);
      for (let i = 0; i < text.length; i += 1) {
        const code = text.charCodeAt(i);
        // A newline inside a paragraph is a line break, and no other control
        // character may reach the file: 0x0D and 0x07 are structure.
        if (code === 0x0a) units.push(0x0b);
        else if (code === 0x09) units.push(0x09);
        else if (code < 0x20) continue;
        else units.push(code);
      }
      if (units.length > from) runs.push({ from, to: units.length, chpx: chpxFor(run) });
    }
    units.push(0x0d);

    let istd = 0;
    let grpprl = Buffer.alloc(0);
    if (block.type === 'heading') {
      istd = Math.min(9, Math.max(1, Number(block.level) || 1));
    } else if (block.type === 'listItem') {
      // Numbering tables are not written, so the level survives as an indent.
      grpprl = indentSprm(360 * Math.min(9, Math.max(1, Number(block.level) || 1)));
    }
    paragraphs.push({ from: start, to: units.length, istd, grpprl });
  }

  if (units.length === 0) units.push(0x0d);
  return { units, runs, paragraphs };
}

/** Fill the gaps so every byte of text is covered by exactly one range. */
function fillGaps(ranges, from, to, empty) {
  const out = [];
  let cursor = from;
  for (const range of ranges) {
    if (range.from > cursor) out.push({ from: cursor, to: range.from, ...empty });
    out.push(range);
    cursor = range.to;
  }
  if (cursor < to) out.push({ from: cursor, to, ...empty });
  return out;
}

/**
 * Pack formatted ranges into 512-byte property pages.
 *
 * The page size is fixed by the format, so how many ranges fit depends on how
 * large their property groups are; identical groups on one page are stored
 * once, which is what keeps an ordinary document to a handful of pages.
 */
function packFkps(ranges, kind) {
  const pages = [];
  let index = 0;

  while (index < ranges.length) {
    const page = Buffer.alloc(FKP_SIZE);
    const stride = kind === 'papx' ? 13 : 1;
    const placed = [];
    const blobs = new Map();
    let blobBytes = 0;

    while (index + placed.length < ranges.length) {
      const range = ranges[index + placed.length];
      const grpprl = kind === 'papx' ? range.grpprl : range.chpx;
      const key = `${kind === 'papx' ? range.istd : ''}:${grpprl.toString('hex')}`;
      const count = placed.length + 1;
      const header = (count + 1) * 4 + count * stride;

      let size;
      if (kind === 'papx') {
        const length = 2 + grpprl.length;
        size = (length % 2 === 1 ? 1 : 2) + length;
      } else {
        size = 1 + grpprl.length;
      }
      size += size % 2;

      const extra = blobs.has(key) ? 0 : size;
      if (header + blobBytes + extra > FKP_SIZE - 1) break;
      if (!blobs.has(key)) {
        blobs.set(key, { grpprl, istd: range.istd ?? 0, size });
        blobBytes += size;
      }
      placed.push({ range, key });
    }

    if (placed.length === 0) {
      throw docError(500, 'DOC_BLOCK_TOO_COMPLEX', 'A paragraph carries formatting too complex for .doc');
    }

    // Property groups are written from the end of the page downwards; the
    // offsets recorded for them are halved, so each must start on an even byte.
    let cursor = FKP_SIZE - 1;
    cursor -= cursor % 2;
    for (const blob of blobs.values()) {
      cursor -= blob.size;
      blob.offset = cursor;
      if (kind === 'papx') {
        const length = 2 + blob.grpprl.length;
        if (length % 2 === 1) {
          page[cursor] = (length + 1) / 2;
          page.writeUInt16LE(blob.istd, cursor + 1);
          blob.grpprl.copy(page, cursor + 3);
        } else {
          page[cursor] = 0;
          page[cursor + 1] = length / 2;
          page.writeUInt16LE(blob.istd, cursor + 2);
          blob.grpprl.copy(page, cursor + 4);
        }
      } else {
        page[cursor] = blob.grpprl.length;
        blob.grpprl.copy(page, cursor + 1);
      }
    }

    placed.forEach((entry, i) => {
      page.writeUInt32LE(entry.range.fcFrom, i * 4);
      const at = (placed.length + 1) * 4 + i * stride;
      page[at] = blobs.get(entry.key).offset / 2;
    });
    page.writeUInt32LE(placed[placed.length - 1].range.fcTo, placed.length * 4);
    page[FKP_SIZE - 1] = placed.length;

    pages.push({ page, from: placed[0].range.fcFrom, to: placed[placed.length - 1].range.fcTo });
    index += placed.length;
  }
  return pages;
}

/** The bin table that says which pages to visit and what they cover. */
function buildBinTable(pages, firstPageNumber) {
  const out = Buffer.alloc((pages.length + 1) * 4 + pages.length * 4);
  pages.forEach((page, i) => {
    out.writeUInt32LE(page.from, i * 4);
    out.writeUInt32LE(firstPageNumber + i, (pages.length + 1) * 4 + i * 4);
  });
  out.writeUInt32LE(pages[pages.length - 1].to, pages.length * 4);
  return out;
}

/** One style, in the shape the stylesheet stores them. */
function buildStd({ sti, name, istdBase, istdNext, papx, chpx }) {
  const nameChars = Buffer.from(name, 'utf16le');
  const base = Buffer.alloc(10);
  base.writeUInt16LE(sti & 0x0fff, 0);
  base.writeUInt16LE(1 | (istdBase << 4), 2); // stk 1 = paragraph style
  base.writeUInt16LE(2 | (istdNext << 4), 4); // cupx 2 = one PAPX and one CHPX

  const xstz = Buffer.alloc(2 + nameChars.length + 2);
  xstz.writeUInt16LE(name.length, 0);
  nameChars.copy(xstz, 2);

  const upxPapx = Buffer.alloc(2 + 2 + papx.length);
  upxPapx.writeUInt16LE(2 + papx.length, 0);
  upxPapx.writeUInt16LE(sti, 2);
  papx.copy(upxPapx, 4);
  const papxPad = upxPapx.length % 2;

  const upxChpx = Buffer.alloc(2 + chpx.length);
  upxChpx.writeUInt16LE(chpx.length, 0);
  chpx.copy(upxChpx, 2);
  const chpxPad = upxChpx.length % 2;

  base.writeUInt16LE(10 + xstz.length, 6); // bchUpe: where the property groups start
  const std = Buffer.concat([
    base,
    xstz,
    upxPapx,
    Buffer.alloc(papxPad),
    upxChpx,
    Buffer.alloc(chpxPad),
  ]);

  const out = Buffer.alloc(2 + std.length);
  out.writeUInt16LE(std.length, 0);
  std.copy(out, 2);
  return out;
}

/** Sizes for the built-in heading styles, in half-points. */
const HEADING_SIZES = [32, 28, 26, 24, 22, 20, 20, 20, 20];

function buildStsh() {
  const styles = [
    buildStd({ sti: 0, name: 'Normal', istdBase: 0x0fff, istdNext: 0, papx: Buffer.alloc(0), chpx: Buffer.alloc(0) }),
  ];
  for (let level = 1; level <= 9; level += 1) {
    styles.push(
      buildStd({
        sti: level,
        name: `heading ${level}`,
        istdBase: 0,
        istdNext: 0,
        papx: Buffer.alloc(0),
        chpx: Buffer.concat([SPRM_BOLD_SET, sizeSprm(HEADING_SIZES[level - 1])]),
      })
    );
  }
  // Word reserves the first fifteen slots for built-in styles; the unused ones
  // are written as empty rather than left out, so the indexes stay put.
  const total = 15;
  while (styles.length < total) styles.push(Buffer.from([0x00, 0x00]));

  const stshi = Buffer.alloc(18);
  stshi.writeUInt16LE(total, 0);
  stshi.writeUInt16LE(0x000a, 2); // cbSTDBaseInFile
  stshi.writeUInt16LE(0x0001, 4); // style names are written out
  stshi.writeUInt16LE(total, 6);
  stshi.writeUInt16LE(total, 8);

  const header = Buffer.alloc(2);
  header.writeUInt16LE(stshi.length, 0);
  return Buffer.concat([header, stshi, ...styles]);
}

/** The font table, with the one font this writer refers to. */
function buildSttbfFfn(name) {
  const xsz = Buffer.from(`${name}\0`, 'utf16le');
  const ffn = Buffer.alloc(40 + xsz.length);
  ffn[0] = ffn.length - 1; // cbFfnM1
  ffn.writeUInt16LE(400, 2); // wWeight: regular
  xsz.copy(ffn, 40);

  const out = Buffer.alloc(4 + 1 + ffn.length);
  out.writeUInt16LE(1, 0); // one font
  out.writeUInt16LE(0, 2); // no extra data per entry
  out[4] = ffn.length;
  ffn.copy(out, 5);
  return out;
}

/** The section table: one section covering the whole document. */
function buildPlcfSed(ccpText) {
  const out = Buffer.alloc(8 + 12);
  out.writeUInt32LE(0, 0);
  out.writeUInt32LE(ccpText, 4);
  out.writeUInt16LE(0, 8);
  out.writeInt32LE(-1, 10); // default section properties
  out.writeUInt16LE(0, 14);
  out.writeInt32LE(-1, 16);
  return out;
}

/** The piece table: one piece, the whole text, uncompressed UTF-16. */
function buildClx(ccpText) {
  const plc = Buffer.alloc(8 + 8);
  plc.writeUInt32LE(0, 0);
  plc.writeUInt32LE(ccpText, 4);
  plc.writeUInt32LE(TEXT_START, 10); // bit 30 clear: two bytes per character
  const out = Buffer.alloc(5 + plc.length);
  out[0] = 0x02;
  out.writeUInt32LE(plc.length, 1);
  plc.copy(out, 5);
  return out;
}

/**
 * Write a document as a Word 97–2003 binary file.
 *
 * @returns {Promise<{warnings: string[]}>}
 */
export async function writeDoc(document, destination) {
  const blocks = (document.blocks ?? []).filter((block) => !block.hidden);
  const { units, runs, paragraphs } = layOutText(blocks);
  const ccpText = units.length;

  const text = Buffer.alloc(ccpText * 2);
  units.forEach((unit, i) => text.writeUInt16LE(unit, i * 2));
  const fcMac = TEXT_START + text.length;

  const toFc = (range) => ({
    ...range,
    fcFrom: TEXT_START + range.from * 2,
    fcTo: TEXT_START + range.to * 2,
  });

  const chpxRanges = fillGaps(runs, 0, ccpText, { chpx: Buffer.alloc(0) }).map(toFc);
  const papxRanges = paragraphs.map(toFc);

  const chpxPages = packFkps(chpxRanges, 'chpx');
  const papxPages = packFkps(papxRanges, 'papx');

  // Property pages live in the document stream, on page boundaries after the
  // text; the bin tables in the table stream point at them by page number.
  const textPages = Math.ceil(text.length / FKP_SIZE);
  const firstChpxPage = TEXT_START / FKP_SIZE + textPages;
  const firstPapxPage = firstChpxPage + chpxPages.length;

  const wordStream = Buffer.concat([
    Buffer.alloc(TEXT_START),
    text,
    Buffer.alloc(textPages * FKP_SIZE - text.length),
    ...chpxPages.map((page) => page.page),
    ...papxPages.map((page) => page.page),
  ]);

  // --- the table stream, laid out in one pass so offsets are known ---------
  const parts = [];
  let cursor = 0;
  const put = (buffer) => {
    const fc = cursor;
    parts.push(buffer);
    cursor += buffer.length;
    return { fc, lcb: buffer.length };
  };

  const stshf = put(buildStsh());
  const plcfSed = put(buildPlcfSed(ccpText));
  const sttbfFfn = put(buildSttbfFfn('Times New Roman'));
  const bteChpx = put(buildBinTable(chpxPages, firstChpxPage));
  const btePapx = put(buildBinTable(papxPages, firstPapxPage));
  const dop = put(Buffer.alloc(500));
  const clx = put(buildClx(ccpText));
  const tableStream = Buffer.concat(parts);

  // --- the File Information Block ------------------------------------------
  const fib = wordStream.subarray(0, TEXT_START);
  fib.writeUInt16LE(0xa5ec, 0);
  fib.writeUInt16LE(193, 2); // Word 97
  fib.writeUInt16LE(0x0409, 6); // language
  fib.writeUInt16LE(0x1200, 0x0a); // extended characters; properties in 1Table
  fib.writeUInt16LE(191, 0x0c); // nFibBack

  fib.writeUInt16LE(14, 0x20); // csw
  const fibRgLw = 0x22 + 14 * 2 + 2;
  fib.writeUInt16LE(22, fibRgLw - 2); // cslw
  fib.writeUInt32LE(wordStream.length, fibRgLw + 0); // cbMac
  // Word 6 kept the text bounds here and some readers still consult them.
  fib.writeUInt32LE(TEXT_START, fibRgLw + 4);
  fib.writeUInt32LE(fcMac, fibRgLw + 8);
  fib.writeUInt32LE(ccpText, fibRgLw + 12);

  const cbRgFcLcb = 0x005d;
  const fibRgFcLcb = fibRgLw + 22 * 4 + 2;
  fib.writeUInt16LE(cbRgFcLcb, fibRgFcLcb - 2);
  const setPair = (index, pair) => {
    fib.writeUInt32LE(pair.fc, fibRgFcLcb + index * 8);
    fib.writeUInt32LE(pair.lcb, fibRgFcLcb + index * 8 + 4);
  };
  setPair(PAIR.stshf, stshf);
  setPair(6, plcfSed);
  setPair(PAIR.sttbfFfn, sttbfFfn);
  setPair(PAIR.plcfBteChpx, bteChpx);
  setPair(PAIR.plcfBtePapx, btePapx);
  setPair(PAIR.dop, dop);
  setPair(PAIR.clx, clx);
  fib.writeUInt16LE(0, fibRgFcLcb + cbRgFcLcb * 8); // cswNew

  await fs.writeFile(
    destination,
    buildCompoundFileFrom([
      { name: 'WordDocument', content: wordStream },
      { name: '1Table', content: tableStream },
    ])
  );

  const warnings = [];
  if (blocks.some((block) => block.type === 'listItem')) {
    warnings.push('.doc was written without a numbering table: list markers were kept as indentation.');
  }
  if (blocks.some((block) => block.inTable || block.type === 'opaque')) {
    warnings.push('Tables and text boxes are not carried over when saving to .doc — their content was kept as plain paragraphs.');
  }
  return { warnings };
}
