import { Lexer, decodeStream, isDict, isName } from './objects.js';

/**
 * Reading the text off a PDF page.
 *
 * A PDF has no paragraphs, no words and often no spaces. It has drawing
 * operators that place runs of glyph codes at coordinates, and the codes mean
 * whatever the font in force says they mean — frequently not Unicode, and for
 * subsetted fonts frequently nothing at all without the font's own translation
 * table.
 *
 * So extraction is three separate problems: decode the codes through the right
 * table, follow the text matrix to know where each run landed, and then infer
 * from geometry alone where the lines and spaces are. The last one is why the
 * result is an approximation and is presented as one.
 */

const CP1252_HIGH = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026,
  0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160,
  0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019,
  0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
  0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153,
  0x9e: 0x017e, 0x9f: 0x0178,
};

/** Glyph names that are not simply their character, for /Differences. */
const GLYPH_NAMES = {
  space: ' ', exclam: '!', quotedbl: '"', numbersign: '#', dollar: '$', percent: '%',
  ampersand: '&', quotesingle: "'", quoteright: '’', quoteleft: '‘',
  parenleft: '(', parenright: ')', asterisk: '*', plus: '+', comma: ',', hyphen: '-',
  period: '.', slash: '/', zero: '0', one: '1', two: '2', three: '3', four: '4',
  five: '5', six: '6', seven: '7', eight: '8', nine: '9', colon: ':', semicolon: ';',
  less: '<', equal: '=', greater: '>', question: '?', at: '@', bracketleft: '[',
  backslash: '\\', bracketright: ']', asciicircum: '^', underscore: '_',
  grave: '`', braceleft: '{', bar: '|', braceright: '}', asciitilde: '~',
  quotedblleft: '“', quotedblright: '”', endash: '–', emdash: '—',
  bullet: '•', ellipsis: '…', fi: 'ﬁ', fl: 'ﬂ', dagger: '†',
  daggerdbl: '‡', perthousand: '‰', quotesinglbase: '‚',
  quotedblbase: '„', guilsinglleft: '‹', guilsinglright: '›',
  trademark: '™', currency: '¤', section: '§', paragraph: '¶',
  degree: '°', plusminus: '±', multiply: '×', divide: '÷',
  nbspace: ' ', euro: '€', sterling: '£', yen: '¥', cent: '¢',
};

function glyphToText(glyph) {
  if (GLYPH_NAMES[glyph]) return GLYPH_NAMES[glyph];
  if (glyph.length === 1) return glyph;
  let match = /^uni([0-9a-fA-F]{4,6})$/.exec(glyph);
  if (match) return String.fromCodePoint(Number.parseInt(match[1], 16));
  match = /^u([0-9a-fA-F]{4,6})$/.exec(glyph);
  if (match) return String.fromCodePoint(Number.parseInt(match[1], 16));
  return '';
}

/**
 * A font's translation table, built from whichever source the font offers.
 *
 * /ToUnicode is authoritative when present and is the only thing that works
 * for a subsetted font, whose codes are arbitrary.
 */
function parseToUnicode(data) {
  const map = new Map();
  const lexer = new Lexer(data, 0);
  let operands = [];

  const asCode = (value) => {
    if (value?.type !== 'string') return null;
    let code = 0;
    for (const byte of value.value) code = code * 256 + byte;
    return { code, bytes: value.value.length };
  };
  const asText = (value) => {
    if (value?.type !== 'string') return '';
    // Destination values are UTF-16BE, and may be several code units for a
    // ligature that expands to more than one character.
    let out = '';
    for (let i = 0; i + 1 < value.value.length; i += 2) {
      out += String.fromCharCode(value.value.readUInt16BE(i));
    }
    if (value.value.length === 1) out = String.fromCharCode(value.value[0]);
    return out;
  };

  let codeBytes = 0;
  for (let guard = 0; guard < 2_000_000; guard += 1) {
    const token = lexer.parseObject();
    if (token === undefined) break;
    if (token?.type !== 'keyword') {
      operands.push(token);
      if (operands.length > 1000) operands = operands.slice(-16);
      continue;
    }

    if (token.value === 'endcodespacerange') {
      for (const operand of operands) {
        const code = asCode(operand);
        if (code) codeBytes = Math.max(codeBytes, code.bytes);
      }
    } else if (token.value === 'endbfchar') {
      for (let i = 0; i + 1 < operands.length; i += 2) {
        const source = asCode(operands[i]);
        if (!source) continue;
        codeBytes = Math.max(codeBytes, source.bytes);
        map.set(source.code, asText(operands[i + 1]));
      }
    } else if (token.value === 'endbfrange') {
      for (let i = 0; i + 2 < operands.length; i += 3) {
        const low = asCode(operands[i]);
        const high = asCode(operands[i + 1]);
        const target = operands[i + 2];
        if (!low || !high) continue;
        codeBytes = Math.max(codeBytes, low.bytes);
        const span = Math.min(high.code - low.code, 65535);

        if (Array.isArray(target)) {
          for (let k = 0; k <= span && k < target.length; k += 1) {
            map.set(low.code + k, asText(target[k]));
          }
        } else {
          const base = asText(target);
          if (!base) continue;
          const last = base.charCodeAt(base.length - 1);
          for (let k = 0; k <= span; k += 1) {
            map.set(low.code + k, base.slice(0, -1) + String.fromCharCode(last + k));
          }
        }
      }
    }
    operands = [];
  }
  return { map, codeBytes };
}

function buildFont(doc, fontDict) {
  const font = {
    twoByte: false,
    toUnicode: null,
    differences: new Map(),
    winAnsi: false,
    widths: new Map(),
    defaultWidth: 0.5,
  };
  if (!isDict(fontDict)) return font;

  const subtype = doc.get(fontDict, 'Subtype');
  const composite = isName(subtype, 'Type0');
  let descendant = null;
  if (composite) {
    const list = doc.get(fontDict, 'DescendantFonts');
    descendant = Array.isArray(list) ? doc.resolve(list[0]) : null;
    font.twoByte = true;
  }

  const toUnicode = doc.get(fontDict, 'ToUnicode');
  if (toUnicode?.type === 'stream') {
    const parsed = parseToUnicode(decodeStream(toUnicode, (value) => doc.resolve(value)));
    font.toUnicode = parsed.map;
    if (parsed.codeBytes === 2) font.twoByte = true;
    if (parsed.codeBytes === 1 && !composite) font.twoByte = false;
  }

  const encoding = doc.get(fontDict, 'Encoding');
  if (isName(encoding, 'WinAnsiEncoding') || isName(encoding, 'MacRomanEncoding')) {
    font.winAnsi = true;
  } else if (isName(encoding) && /Identity/.test(encoding.value)) {
    font.twoByte = true;
  } else if (isDict(encoding)) {
    if (isName(doc.get(encoding, 'BaseEncoding'), 'WinAnsiEncoding')) font.winAnsi = true;
    const differences = doc.get(encoding, 'Differences');
    if (Array.isArray(differences)) {
      let code = 0;
      for (const item of differences) {
        const value = doc.resolve(item);
        if (typeof value === 'number') code = value;
        else if (isName(value)) {
          font.differences.set(code, glyphToText(value.value));
          code += 1;
        }
      }
    }
  }

  // Widths, so the gaps between runs can be told from the spaces inside them.
  if (composite && isDict(descendant)) {
    const dw = doc.get(descendant, 'DW');
    font.defaultWidth = (typeof dw === 'number' ? dw : 1000) / 1000;
    const w = doc.get(descendant, 'W');
    if (Array.isArray(w)) {
      for (let i = 0; i < w.length; ) {
        const first = doc.resolve(w[i]);
        const second = doc.resolve(w[i + 1]);
        if (Array.isArray(second)) {
          second.forEach((width, k) => {
            const value = doc.resolve(width);
            if (typeof value === 'number') font.widths.set(first + k, value / 1000);
          });
          i += 2;
        } else {
          const width = doc.resolve(w[i + 2]);
          if (typeof width === 'number' && typeof second === 'number') {
            for (let code = first; code <= second && code - first < 65536; code += 1) {
              font.widths.set(code, width / 1000);
            }
          }
          i += 3;
        }
      }
    }
  } else {
    const firstChar = doc.get(fontDict, 'FirstChar');
    const widths = doc.get(fontDict, 'Widths');
    if (Array.isArray(widths) && typeof firstChar === 'number') {
      widths.forEach((width, i) => {
        const value = doc.resolve(width);
        if (typeof value === 'number') font.widths.set(firstChar + i, value / 1000);
      });
    }
  }

  return font;
}

function decodeCodes(font, bytes) {
  const codes = [];
  if (font.twoByte) {
    for (let i = 0; i + 1 < bytes.length; i += 2) codes.push(bytes.readUInt16BE(i));
    if (bytes.length % 2 === 1) codes.push(bytes[bytes.length - 1]);
  } else {
    for (const byte of bytes) codes.push(byte);
  }
  return codes;
}

function codeToText(font, code) {
  if (font.toUnicode) {
    const mapped = font.toUnicode.get(code);
    if (mapped !== undefined) return mapped;
    // A subsetted font with a partial table: anything missing is a glyph
    // whose meaning the file does not record.
    if (font.twoByte) return '';
  }
  if (font.differences.has(code)) return font.differences.get(code);
  if (font.twoByte) return code > 0 && code < 0x10000 ? String.fromCharCode(code) : '';
  if (code >= 0x80 && code <= 0x9f) return String.fromCharCode(CP1252_HIGH[code] ?? code);
  return String.fromCharCode(code);
}

const multiply = (a, b) => [
  a[0] * b[0] + a[1] * b[2],
  a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2],
  a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4],
  a[4] * b[1] + a[5] * b[3] + b[5],
];

const IDENTITY = [1, 0, 0, 1, 0, 0];

/**
 * Run a content stream, collecting every run of text with where it landed.
 */
function collect(doc, content, resources, ctm, items, depth, fontCache) {
  if (depth > 8) return;

  const lexer = new Lexer(content, 0);
  let operands = [];
  const stack = [];
  let matrix = ctm;

  let tm = IDENTITY;
  let tlm = IDENTITY;
  let leading = 0;
  let charSpacing = 0;
  let wordSpacing = 0;
  let horizontal = 1;
  let rise = 0;
  let fontSize = 0;
  let font = null;

  const fontsDict = doc.get(resources, 'Font');
  const xobjects = doc.get(resources, 'XObject');

  const number = (value, fallback = 0) => (typeof value === 'number' ? value : fallback);

  const show = (bytes) => {
    if (!font || bytes.length === 0) return;
    const codes = decodeCodes(font, bytes);
    let text = '';
    let advance = 0;
    for (const code of codes) {
      text += codeToText(font, code);
      const width = font.widths.get(code) ?? font.defaultWidth;
      const extra = charSpacing + (!font.twoByte && code === 32 ? wordSpacing : 0);
      advance += (width * fontSize + extra) * horizontal;
    }

    if (text.trim() !== '' || text.includes(' ')) {
      const render = multiply([fontSize * horizontal, 0, 0, fontSize, 0, rise], multiply(tm, matrix));
      items.push({
        x: render[4],
        y: render[5],
        width: advance * Math.hypot(matrix[0], matrix[1] || 0),
        size: Math.abs(fontSize * Math.hypot(matrix[2] || 0, matrix[3])) || 1,
        text,
      });
    }
    tm = multiply([1, 0, 0, 1, advance, 0], tm);
  };

  for (let guard = 0; guard < 5_000_000; guard += 1) {
    const token = lexer.parseObject();
    if (token === undefined) break;
    if (token?.type !== 'keyword') {
      operands.push(token);
      if (operands.length > 64) operands = operands.slice(-32);
      continue;
    }

    const op = token.value;
    const last = operands[operands.length - 1];

    switch (op) {
      case 'q':
        stack.push(matrix);
        break;
      case 'Q':
        matrix = stack.pop() ?? matrix;
        break;
      case 'cm':
        if (operands.length >= 6) {
          matrix = multiply(operands.slice(-6).map((value) => number(value)), matrix);
        }
        break;
      case 'BT':
        tm = IDENTITY;
        tlm = IDENTITY;
        break;
      case 'ET':
        break;
      case 'Tf':
        fontSize = number(last);
        if (operands.length >= 2) {
          const key = operands[operands.length - 2];
          if (isName(key) && isDict(fontsDict)) {
            if (!fontCache.has(key.value)) {
              fontCache.set(key.value, buildFont(doc, doc.get(fontsDict, key.value)));
            }
            font = fontCache.get(key.value);
          }
        }
        break;
      case 'TL':
        leading = number(last);
        break;
      case 'Tc':
        charSpacing = number(last);
        break;
      case 'Tw':
        wordSpacing = number(last);
        break;
      case 'Tz':
        horizontal = number(last, 100) / 100;
        break;
      case 'Ts':
        rise = number(last);
        break;
      case 'Td':
        if (operands.length >= 2) {
          tlm = multiply([1, 0, 0, 1, number(operands[operands.length - 2]), number(last)], tlm);
          tm = tlm;
        }
        break;
      case 'TD':
        if (operands.length >= 2) {
          leading = -number(last);
          tlm = multiply([1, 0, 0, 1, number(operands[operands.length - 2]), number(last)], tlm);
          tm = tlm;
        }
        break;
      case 'Tm':
        if (operands.length >= 6) {
          tlm = operands.slice(-6).map((value) => number(value));
          tm = tlm;
        }
        break;
      case 'T*':
        tlm = multiply([1, 0, 0, 1, 0, -leading], tlm);
        tm = tlm;
        break;
      case 'Tj':
        if (last?.type === 'string') show(last.value);
        break;
      case "'":
        tlm = multiply([1, 0, 0, 1, 0, -leading], tlm);
        tm = tlm;
        if (last?.type === 'string') show(last.value);
        break;
      case '"':
        if (operands.length >= 3) {
          wordSpacing = number(operands[operands.length - 3]);
          charSpacing = number(operands[operands.length - 2]);
        }
        tlm = multiply([1, 0, 0, 1, 0, -leading], tlm);
        tm = tlm;
        if (last?.type === 'string') show(last.value);
        break;
      case 'TJ':
        if (Array.isArray(last)) {
          for (const item of last) {
            if (item?.type === 'string') show(item.value);
            else if (typeof item === 'number') {
              // A positive kern moves left; this is where inter-word gaps in
              // a justified line actually live.
              tm = multiply([1, 0, 0, 1, (-item / 1000) * fontSize * horizontal, 0], tm);
            }
          }
        }
        break;
      case 'Do': {
        if (!isName(last) || !isDict(xobjects)) break;
        const xobject = doc.get(xobjects, last.value);
        if (xobject?.type !== 'stream' || !isName(doc.get(xobject, 'Subtype'), 'Form')) break;
        const formMatrix = doc.get(xobject, 'Matrix');
        const inner = Array.isArray(formMatrix) && formMatrix.length === 6
          ? multiply(formMatrix.map((value) => number(doc.resolve(value))), matrix)
          : matrix;
        collect(
          doc,
          decodeStream(xobject, (value) => doc.resolve(value)),
          doc.get(xobject, 'Resources') ?? resources,
          inner,
          items,
          depth + 1,
          new Map()
        );
        break;
      }
      case 'BI': {
        // An inline image's data is raw bytes that would be read as operators.
        const at = content.indexOf('EI', lexer.pos, 'latin1');
        lexer.pos = at === -1 ? content.length : at + 2;
        break;
      }
      default:
        break;
    }
    operands = [];
  }
}

/**
 * Turn placed runs into lines.
 *
 * Nothing in the file says where a line ends, so it is decided by geometry:
 * runs sharing a baseline are one line, and a horizontal gap wider than a
 * space is a space.
 */
function layOut(items) {
  if (items.length === 0) return '';

  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  let current = null;

  for (const item of sorted) {
    const tolerance = Math.max(2, item.size * 0.5);
    if (current && Math.abs(current.y - item.y) <= tolerance) {
      current.items.push(item);
    } else {
      current = { y: item.y, items: [item] };
      lines.push(current);
    }
  }

  return lines
    .map((line) => {
      const ordered = line.items.sort((a, b) => a.x - b.x);
      let text = '';
      let previousEnd = null;
      for (const item of ordered) {
        if (previousEnd !== null) {
          const gap = item.x - previousEnd;
          if (gap > item.size * 0.2 && !text.endsWith(' ') && !item.text.startsWith(' ')) {
            text += ' ';
          }
        }
        text += item.text;
        previousEnd = item.x + item.width;
      }
      return text.replace(/\s+$/, '');
    })
    .filter((line, index, all) => line !== '' || (index > 0 && all[index - 1] !== ''))
    .join('\n');
}

/** The text of one page, as close to reading order as geometry allows. */
export function extractPageText(doc, page) {
  const items = [];
  try {
    collect(
      doc,
      doc.content(page),
      doc.resolve(page.node.map.Resources ?? page.inherited.Resources),
      IDENTITY,
      items,
      0,
      new Map()
    );
  } catch {
    return '';
  }
  return layOut(items);
}
