import zlib from 'node:zlib';

/**
 * The PDF object layer: reading the eight object types the format is built
 * from, and writing them back.
 *
 * PDF is not a markup format with a schema; it is a graph of numbered objects
 * with a byte-offset index at the end of the file. Everything above this
 * module — pages, text, page operations — is a matter of walking that graph,
 * so the parsing has to be exact about the awkward corners: strings with
 * balanced parentheses inside them, dictionaries that turn into streams, and
 * numbers that are really references to other objects.
 */

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMITER = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

const isRegular = (byte) => byte !== undefined && !WHITESPACE.has(byte) && !DELIMITER.has(byte);

export const name = (value) => ({ type: 'name', value });
export const str = (value, hex = false) => ({ type: 'string', value: Buffer.from(value), hex });
export const dict = (map = {}) => ({ type: 'dict', map });
export const ref = (num, gen = 0) => ({ type: 'ref', num, gen });
export const stream = (map, raw) => ({ type: 'stream', map, raw });

export const isDict = (value) => value?.type === 'dict' || value?.type === 'stream';
export const isName = (value, expected) =>
  value?.type === 'name' && (expected === undefined || value.value === expected);
export const isRef = (value) => value?.type === 'ref';

/** A sentinel for the closing tokens, which are not objects. */
const CLOSE = Symbol('close');

export class Lexer {
  constructor(buffer, position = 0) {
    this.buffer = buffer;
    this.pos = position;
  }

  skip() {
    const { buffer } = this;
    for (;;) {
      while (this.pos < buffer.length && WHITESPACE.has(buffer[this.pos])) this.pos += 1;
      if (buffer[this.pos] !== 0x25) return; // '%' begins a comment
      while (this.pos < buffer.length && buffer[this.pos] !== 0x0a && buffer[this.pos] !== 0x0d) {
        this.pos += 1;
      }
    }
  }

  /** The next keyword, for the tokens that are bare words. */
  peekKeyword() {
    const start = this.pos;
    this.skip();
    let end = this.pos;
    while (isRegular(this.buffer[end])) end += 1;
    const word = this.buffer.toString('latin1', this.pos, end);
    this.pos = start;
    return word;
  }

  readKeyword() {
    this.skip();
    let end = this.pos;
    while (isRegular(this.buffer[end])) end += 1;
    const word = this.buffer.toString('latin1', this.pos, end);
    this.pos = end;
    return word;
  }

  #readName() {
    this.pos += 1; // '/'
    const bytes = [];
    while (isRegular(this.buffer[this.pos])) {
      let byte = this.buffer[this.pos];
      if (byte === 0x23 && this.pos + 2 < this.buffer.length) {
        // '#' introduces a two-digit hex escape, which is how a name holds a
        // space or a slash.
        const hex = this.buffer.toString('latin1', this.pos + 1, this.pos + 3);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          byte = parseInt(hex, 16);
          this.pos += 2;
        }
      }
      bytes.push(byte);
      this.pos += 1;
    }
    return name(Buffer.from(bytes).toString('latin1'));
  }

  #readLiteralString() {
    this.pos += 1; // '('
    const bytes = [];
    let depth = 1;
    while (this.pos < this.buffer.length) {
      const byte = this.buffer[this.pos];
      if (byte === 0x5c) {
        // Backslash escapes, including the three-digit octal form and the
        // line continuation that produces no character at all.
        this.pos += 1;
        const next = this.buffer[this.pos];
        this.pos += 1;
        if (next === 0x6e) bytes.push(0x0a);
        else if (next === 0x72) bytes.push(0x0d);
        else if (next === 0x74) bytes.push(0x09);
        else if (next === 0x62) bytes.push(0x08);
        else if (next === 0x66) bytes.push(0x0c);
        else if (next >= 0x30 && next <= 0x37) {
          let value = next - 0x30;
          for (let i = 0; i < 2; i += 1) {
            const digit = this.buffer[this.pos];
            if (digit === undefined || digit < 0x30 || digit > 0x37) break;
            value = value * 8 + (digit - 0x30);
            this.pos += 1;
          }
          bytes.push(value & 0xff);
        } else if (next === 0x0a) {
          // continuation
        } else if (next === 0x0d) {
          if (this.buffer[this.pos] === 0x0a) this.pos += 1;
        } else if (next !== undefined) {
          bytes.push(next);
        }
        continue;
      }
      if (byte === 0x28) depth += 1;
      if (byte === 0x29) {
        depth -= 1;
        if (depth === 0) {
          this.pos += 1;
          break;
        }
      }
      bytes.push(byte);
      this.pos += 1;
    }
    return { type: 'string', value: Buffer.from(bytes), hex: false };
  }

  #readHexString() {
    this.pos += 1; // '<'
    const digits = [];
    while (this.pos < this.buffer.length && this.buffer[this.pos] !== 0x3e) {
      const char = String.fromCharCode(this.buffer[this.pos]);
      if (/[0-9a-fA-F]/.test(char)) digits.push(char);
      this.pos += 1;
    }
    this.pos += 1; // '>'
    if (digits.length % 2 === 1) digits.push('0');
    return { type: 'string', value: Buffer.from(digits.join(''), 'hex'), hex: true };
  }

  #readDict() {
    this.pos += 2; // '<<'
    const map = {};
    for (;;) {
      this.skip();
      if (this.pos >= this.buffer.length) break;
      if (this.buffer[this.pos] === 0x3e && this.buffer[this.pos + 1] === 0x3e) {
        this.pos += 2;
        break;
      }
      if (this.buffer[this.pos] !== 0x2f) {
        // Not a name where a key must be: the dictionary is malformed, and
        // guessing past it would invent structure that is not there.
        const value = this.parseObject();
        if (value === CLOSE || value === undefined) break;
        continue;
      }
      const key = this.#readName().value;
      const value = this.parseObject();
      if (value === CLOSE) break;
      map[key] = value;
    }

    // A dictionary followed by the `stream` keyword owns the bytes after it.
    const save = this.pos;
    this.skip();
    if (this.buffer.toString('latin1', this.pos, this.pos + 6) === 'stream') {
      this.pos += 6;
      if (this.buffer[this.pos] === 0x0d) this.pos += 1;
      if (this.buffer[this.pos] === 0x0a) this.pos += 1;
      const start = this.pos;

      let length = typeof map.Length === 'number' ? map.Length : -1;
      const endsHere = (at) => {
        const probe = this.buffer.toString('latin1', at, at + 20).replace(/^[\r\n \t]*/, '');
        return probe.startsWith('endstream');
      };
      if (length < 0 || start + length > this.buffer.length || !endsHere(start + length)) {
        // /Length can be an indirect reference, or simply wrong. The keyword
        // that closes the stream is authoritative either way.
        const at = this.buffer.indexOf('endstream', start, 'latin1');
        length = at === -1 ? this.buffer.length - start : at - start;
        // The EOL before `endstream` belongs to the format, not the data.
        if (this.buffer[start + length - 1] === 0x0a) length -= 1;
        if (this.buffer[start + length - 1] === 0x0d) length -= 1;
      }

      const raw = this.buffer.subarray(start, start + length);
      this.pos = start + length;
      const at = this.buffer.indexOf('endstream', this.pos, 'latin1');
      this.pos = at === -1 ? this.buffer.length : at + 9;
      return stream(map, raw);
    }
    this.pos = save;
    return dict(map);
  }

  #readNumberOrRef() {
    const start = this.pos;
    if (this.buffer[this.pos] === 0x2b || this.buffer[this.pos] === 0x2d) this.pos += 1;
    while (isRegular(this.buffer[this.pos])) this.pos += 1;
    const text = this.buffer.toString('latin1', start, this.pos);
    const value = Number.parseFloat(text);
    const number = Number.isFinite(value) ? value : 0;

    // `12 0 R` is a reference; `12 0` is two numbers. Only reading ahead tells
    // them apart, so the position is restored when the third token is not R.
    if (Number.isInteger(number) && number >= 0) {
      const save = this.pos;
      this.skip();
      const genStart = this.pos;
      while (isRegular(this.buffer[this.pos])) this.pos += 1;
      const genText = this.buffer.toString('latin1', genStart, this.pos);
      if (/^\d+$/.test(genText)) {
        this.skip();
        if (this.buffer[this.pos] === 0x52 && !isRegular(this.buffer[this.pos + 1])) {
          this.pos += 1;
          return ref(number, Number.parseInt(genText, 10));
        }
      }
      this.pos = save;
    }
    return number;
  }

  parseObject() {
    this.skip();
    if (this.pos >= this.buffer.length) return undefined;
    const byte = this.buffer[this.pos];

    if (byte === 0x2f) return this.#readName();
    if (byte === 0x28) return this.#readLiteralString();
    if (byte === 0x3c) {
      return this.buffer[this.pos + 1] === 0x3c ? this.#readDict() : this.#readHexString();
    }
    if (byte === 0x5b) {
      this.pos += 1;
      const items = [];
      for (;;) {
        this.skip();
        if (this.pos >= this.buffer.length) break;
        if (this.buffer[this.pos] === 0x5d) {
          this.pos += 1;
          break;
        }
        const item = this.parseObject();
        if (item === CLOSE || item === undefined) break;
        items.push(item);
      }
      return items;
    }
    if (byte === 0x5d || byte === 0x3e || byte === 0x29 || byte === 0x7d) {
      this.pos += 1;
      return CLOSE;
    }
    if ((byte >= 0x30 && byte <= 0x39) || byte === 0x2b || byte === 0x2d || byte === 0x2e) {
      return this.#readNumberOrRef();
    }

    const word = this.readKeyword();
    if (word === 'true') return true;
    if (word === 'false') return false;
    if (word === 'null') return null;
    if (word === '') {
      this.pos += 1;
      return CLOSE;
    }
    return { type: 'keyword', value: word };
  }
}

/* ------------------------------------------------------------------ decoding */

/**
 * Undo a predictor.
 *
 * Flate on its own rarely compresses tabular data well, so PDF applies the
 * same row filters PNG uses first. Cross-reference streams almost always use
 * this, which makes it load-bearing rather than optional.
 */
function unpredict(data, parms) {
  const predictor = parms.Predictor ?? 1;
  if (predictor <= 1) return data;

  const colours = parms.Colors ?? 1;
  const bits = parms.BitsPerComponent ?? 8;
  const columns = parms.Columns ?? 1;
  const pixel = Math.ceil((colours * bits) / 8);
  const rowLength = Math.ceil((colours * bits * columns) / 8);

  if (predictor === 2) {
    if (bits !== 8) return data;
    for (let row = 0; row + rowLength <= data.length; row += rowLength) {
      for (let i = pixel; i < rowLength; i += 1) {
        data[row + i] = (data[row + i] + data[row + i - pixel]) & 0xff;
      }
    }
    return data;
  }

  const rows = Math.floor(data.length / (rowLength + 1));
  const out = Buffer.alloc(rows * rowLength);
  let previous = Buffer.alloc(rowLength);
  for (let row = 0; row < rows; row += 1) {
    const tag = data[row * (rowLength + 1)];
    const source = data.subarray(row * (rowLength + 1) + 1, (row + 1) * (rowLength + 1));
    const current = Buffer.from(source);
    for (let i = 0; i < rowLength; i += 1) {
      const left = i >= pixel ? current[i - pixel] : 0;
      const up = previous[i];
      const upLeft = i >= pixel ? previous[i - pixel] : 0;
      switch (tag) {
        case 1: current[i] = (current[i] + left) & 0xff; break;
        case 2: current[i] = (current[i] + up) & 0xff; break;
        case 3: current[i] = (current[i] + ((left + up) >> 1)) & 0xff; break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          const best = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
          current[i] = (current[i] + best) & 0xff;
          break;
        }
        default: break;
      }
    }
    current.copy(out, row * rowLength);
    previous = current;
  }
  return out;
}

function ascii85(data) {
  const out = [];
  let tuple = 0;
  let count = 0;
  for (let i = 0; i < data.length; i += 1) {
    const byte = data[i];
    if (WHITESPACE.has(byte)) continue;
    if (byte === 0x7e) break; // '~>' ends the data
    if (byte === 0x7a && count === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    if (byte < 0x21 || byte > 0x75) continue;
    tuple = tuple * 85 + (byte - 0x21);
    count += 1;
    if (count === 5) {
      out.push((tuple >>> 24) & 0xff, (tuple >>> 16) & 0xff, (tuple >>> 8) & 0xff, tuple & 0xff);
      tuple = 0;
      count = 0;
    }
  }
  if (count > 0) {
    for (let i = count; i < 5; i += 1) tuple = tuple * 85 + 84;
    const bytes = [(tuple >>> 24) & 0xff, (tuple >>> 16) & 0xff, (tuple >>> 8) & 0xff, tuple & 0xff];
    out.push(...bytes.slice(0, count - 1));
  }
  return Buffer.from(out);
}

function runLength(data) {
  const out = [];
  let i = 0;
  while (i < data.length) {
    const tag = data[i];
    i += 1;
    if (tag === 128) break;
    if (tag < 128) {
      for (let k = 0; k <= tag; k += 1) out.push(data[i + k]);
      i += tag + 1;
    } else {
      for (let k = 0; k < 257 - tag; k += 1) out.push(data[i]);
      i += 1;
    }
  }
  return Buffer.from(out);
}

function lzw(data, early = 1) {
  const out = [];
  let table = [];
  const reset = () => {
    table = [];
    for (let i = 0; i < 256; i += 1) table.push([i]);
    table.push(null, null);
  };
  reset();

  let width = 9;
  let buffer = 0;
  let bits = 0;
  let previous = null;
  for (let i = 0; i < data.length; i += 1) {
    buffer = (buffer << 8) | data[i];
    bits += 8;
    while (bits >= width) {
      const code = (buffer >> (bits - width)) & ((1 << width) - 1);
      bits -= width;
      if (code === 256) {
        reset();
        width = 9;
        previous = null;
        continue;
      }
      if (code === 257) return Buffer.from(out);

      let entry;
      if (code < table.length && table[code]) entry = table[code];
      else if (previous) entry = [...previous, previous[0]];
      else continue;

      out.push(...entry);
      if (previous) table.push([...previous, entry[0]]);
      previous = entry;
      if (table.length + early >= 1 << width && width < 12) width += 1;
    }
  }
  return Buffer.from(out);
}

const inflate = (data) => {
  try {
    return zlib.inflateSync(data);
  } catch {
    // Truncated or slightly malformed streams are common in the wild and
    // still decode usefully up to the damage.
    try {
      return zlib.inflateSync(data, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
    } catch {
      try {
        return zlib.inflateRawSync(data.subarray(1), { finishFlush: zlib.constants.Z_SYNC_FLUSH });
      } catch {
        return Buffer.alloc(0);
      }
    }
  }
};

/** Image filters are left encoded: this module has no business decoding them. */
export const IMAGE_FILTERS = new Set(['DCTDecode', 'JPXDecode', 'JBIG2Decode', 'CCITTFaxDecode']);

/**
 * A stream's bytes with its filters applied.
 *
 * @param {object} object the stream object
 * @param {(value: unknown) => unknown} resolve follows indirect references
 */
export function decodeStream(object, resolve = (value) => value) {
  if (object?.type !== 'stream') return Buffer.alloc(0);

  let data = object.raw;
  const filterValue = resolve(object.map.Filter);
  const filters = filterValue === undefined || filterValue === null
    ? []
    : Array.isArray(filterValue)
      ? filterValue
      : [filterValue];

  const parmsValue = resolve(object.map.DecodeParms ?? object.map.DP);
  const parmsList = Array.isArray(parmsValue) ? parmsValue : [parmsValue];

  filters.forEach((filter, index) => {
    const filterName = resolve(filter)?.value;
    if (!filterName || IMAGE_FILTERS.has(filterName)) return;

    const parmsObject = resolve(parmsList[index]);
    const parms = {};
    if (isDict(parmsObject)) {
      for (const [key, value] of Object.entries(parmsObject.map)) {
        const resolved = resolve(value);
        if (typeof resolved === 'number') parms[key] = resolved;
      }
    }

    if (filterName === 'FlateDecode' || filterName === 'Fl') {
      data = unpredict(inflate(data), parms);
    } else if (filterName === 'LZWDecode' || filterName === 'LZW') {
      data = unpredict(lzw(data, parms.EarlyChange ?? 1), parms);
    } else if (filterName === 'ASCII85Decode' || filterName === 'A85') {
      data = ascii85(data);
    } else if (filterName === 'ASCIIHexDecode' || filterName === 'AHx') {
      const text = data.toString('latin1').replace(/[^0-9a-fA-F]/g, '');
      data = Buffer.from(text.length % 2 ? `${text}0` : text, 'hex');
    } else if (filterName === 'RunLengthDecode' || filterName === 'RL') {
      data = runLength(data);
    }
  });
  return data;
}

/* ------------------------------------------------------------------ writing */

const NAME_ESCAPE = /[^\x21-\x7e]|[#()<>[\]{}/%]/g;

const formatNumber = (value) => {
  if (Number.isInteger(value)) return String(value);
  // Six places is past what any PDF coordinate needs and keeps the exponent
  // notation JavaScript would otherwise produce out of the file.
  return String(Number(value.toFixed(6)));
};

/** One object as the bytes a PDF file holds. */
export function serialize(object) {
  if (object === null || object === undefined) return Buffer.from('null');
  if (typeof object === 'boolean') return Buffer.from(object ? 'true' : 'false');
  if (typeof object === 'number') return Buffer.from(formatNumber(object));
  if (Array.isArray(object)) {
    const parts = object.map((item) => serialize(item));
    return Buffer.concat([Buffer.from('['), joinWithSpaces(parts), Buffer.from(']')]);
  }

  switch (object.type) {
    case 'name':
      return Buffer.from(
        `/${object.value.replace(NAME_ESCAPE, (char) =>
          `#${char.charCodeAt(0).toString(16).padStart(2, '0')}`
        )}`
      );
    case 'ref':
      return Buffer.from(`${object.num} ${object.gen} R`);
    case 'keyword':
      return Buffer.from(object.value);
    case 'string': {
      if (object.hex) return Buffer.from(`<${object.value.toString('hex')}>`);
      const escaped = [];
      for (const byte of object.value) {
        if (byte === 0x28 || byte === 0x29 || byte === 0x5c) escaped.push(0x5c, byte);
        else if (byte === 0x0d) escaped.push(0x5c, 0x72);
        else escaped.push(byte);
      }
      return Buffer.concat([Buffer.from('('), Buffer.from(escaped), Buffer.from(')')]);
    }
    case 'dict':
    case 'stream': {
      const parts = [Buffer.from('<<')];
      for (const [key, value] of Object.entries(object.map)) {
        if (value === undefined) continue;
        parts.push(Buffer.from(`/${key.replace(NAME_ESCAPE, (char) =>
          `#${char.charCodeAt(0).toString(16).padStart(2, '0')}`)} `));
        parts.push(serialize(value));
        parts.push(Buffer.from(' '));
      }
      parts.push(Buffer.from('>>'));
      if (object.type === 'stream') {
        parts.push(Buffer.from('\nstream\n'), object.raw, Buffer.from('\nendstream'));
      }
      return Buffer.concat(parts);
    }
    default:
      return Buffer.from('null');
  }
}

function joinWithSpaces(parts) {
  const out = [];
  parts.forEach((part, index) => {
    if (index > 0) out.push(Buffer.from(' '));
    out.push(part);
  });
  return Buffer.concat(out);
}
