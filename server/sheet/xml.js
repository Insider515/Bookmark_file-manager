/**
 * A small XML reader and writer, enough for spreadsheet parts and no more.
 *
 * xlsx and ods are ZIP archives full of XML, and this project already owns a
 * ZIP reader and writer — so the only thing standing between it and those two
 * formats is XML. A general parser would be the wrong tool: these documents are
 * machine-written, never carry DTDs worth honouring, and the parts that matter
 * are a handful of element and attribute names.
 *
 * Deliberately unsupported: DTDs, entity declarations, and namespace
 * resolution — prefixes are kept verbatim and matched on their local name,
 * which is all these formats need.
 */

/** The five predefined entities; numeric references are handled separately. */
const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function decodeEntities(text) {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    return ENTITIES[body] ?? match;
  });
}

/**
 * Control characters XML 1.0 forbids outright.
 *
 * Dropped rather than escaped, because there is no escape that would make them
 * legal: a cell carrying a stray 0x00 would otherwise produce a file that no
 * spreadsheet will open at all.
 */
const FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

/** Escape for element text. */
export function escapeText(value) {
  return String(value)
    .replace(FORBIDDEN, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Escape for a double-quoted attribute value. */
export function escapeAttribute(value) {
  return escapeText(value).replace(/"/g, '&quot;').replace(/\n/g, '&#10;');
}

/** The part of a qualified name after the colon. */
export function localName(name) {
  const colon = name.indexOf(':');
  return colon === -1 ? name : name.slice(colon + 1);
}

/**
 * Walk an XML document, calling back as elements open and close.
 *
 * Streaming rather than tree-building: a worksheet can be tens of megabytes of
 * XML while the caller wants a few of its elements, and nothing is retained
 * that the callback does not keep for itself.
 *
 * @param {string} xml
 * @param {{onOpen?: (name: string, attributes: object, selfClosing: boolean) => void,
 *          onClose?: (name: string) => void,
 *          onText?: (text: string) => void}} handlers
 */
export function parseXml(xml, handlers) {
  const { onOpen, onClose, onText } = handlers;
  let index = 0;
  const length = xml.length;

  while (index < length) {
    const open = xml.indexOf('<', index);
    if (open === -1) {
      if (onText && index < length) onText(decodeEntities(xml.slice(index)));
      return;
    }
    if (open > index && onText) onText(decodeEntities(xml.slice(index, open)));

    if (xml.startsWith('<!--', open)) {
      const end = xml.indexOf('-->', open + 4);
      index = end === -1 ? length : end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', open)) {
      const end = xml.indexOf(']]>', open + 9);
      // CDATA is literal: entity decoding would corrupt it.
      if (onText) onText(xml.slice(open + 9, end === -1 ? length : end));
      index = end === -1 ? length : end + 3;
      continue;
    }
    if (xml.startsWith('<?', open) || xml.startsWith('<!', open)) {
      const end = xml.indexOf('>', open);
      index = end === -1 ? length : end + 1;
      continue;
    }

    const close = findTagEnd(xml, open);
    if (close === -1) return;
    const raw = xml.slice(open + 1, close);
    index = close + 1;

    if (raw[0] === '/') {
      if (onClose) onClose(raw.slice(1).trim());
      continue;
    }

    const selfClosing = raw.endsWith('/');
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const nameEnd = findNameEnd(body);
    const name = (nameEnd === -1 ? body : body.slice(0, nameEnd)).trim();
    const attributes = nameEnd === -1 ? {} : parseAttributes(body.slice(nameEnd));

    if (onOpen) onOpen(name, attributes, selfClosing);
    if (selfClosing && onClose) onClose(name);
  }
}

/** The `>` that ends a tag, skipping any inside quoted attribute values. */
function findTagEnd(xml, from) {
  let quote = null;
  for (let i = from + 1; i < xml.length; i += 1) {
    const char = xml[i];
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '>') {
      return i;
    }
  }
  return -1;
}

function findNameEnd(body) {
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') return i;
  }
  return -1;
}

function parseAttributes(text) {
  const attributes = {};
  const pattern = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    attributes[match[1]] = decodeEntities(match[3] ?? match[4] ?? '');
  }
  return attributes;
}

/** Build an element. `children` is a pre-escaped string, or an array of them. */
export function element(name, attributes = {}, children = null) {
  const parts = [`<${name}`];
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null) continue;
    parts.push(` ${key}="${escapeAttribute(value)}"`);
  }
  if (children === null || children === '') {
    parts.push('/>');
    return parts.join('');
  }
  parts.push('>');
  parts.push(Array.isArray(children) ? children.join('') : children);
  parts.push(`</${name}>`);
  return parts.join('');
}

export const XML_DECLARATION =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
