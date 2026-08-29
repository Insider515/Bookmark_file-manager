import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

import { createZipStream } from '../zip.js';
import { ZipArchive } from '../archive/zip-read.js';
import { XML_DECLARATION, element, escapeText, localName, parseXml } from '../sheet/xml.js';
import {
  DEFAULT_DOC_LIMITS,
  blockText,
  docError,
  isPristine,
  makeRun,
  normaliseRuns,
} from './model.js';

/**
 * docx — WordprocessingML, read and written without a dependency.
 *
 * A .docx is a ZIP whose `word/document.xml` holds a `<w:body>` of block
 * elements. The two that matter are `<w:p>` (a paragraph, containing `<w:r>`
 * runs of text with `<w:rPr>` marks) and `<w:tbl>` (a table). Everything else
 * — section properties, bookmarks, fields, drawings — sits alongside them.
 *
 * The reader keeps every top-level body element's *source XML*, and the writer
 * puts back the original for anything that was not edited. That is what lets
 * a document with tables, images and styles survive having one sentence
 * changed; see the note in ./model.js.
 */

const CONTENT_TYPES =
  `${XML_DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '</Types>';

const ROOT_RELS =
  `${XML_DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  '</Relationships>';

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

/** Heading styles are conventionally named; the number is the level. */
/** Body elements that are structure rather than content. */
const STRUCTURAL = new Set([
  'sectPr',
  'bookmarkStart',
  'bookmarkEnd',
  'proofErr',
  'commentRangeStart',
  'commentRangeEnd',
  'permStart',
  'permEnd',
]);

/** What the editor calls the elements it cannot show. */
const LABELS = {
  tbl: '[table]',
  sdt: '[form field]',
  customXml: '[markup]',
};

const HEADING_STYLE = /^heading\s*([1-6])$/i;

/**
 * List styles.
 *
 * A list item does not always carry `<w:numPr>` inline — when the numbering
 * comes from the named style, the paragraph itself says nothing but its style
 * name, and a reader that only looks for numPr sees a plain paragraph.
 */
const LIST_STYLE = /^list(?:paragraph|bullet|number|continue)?\s*(\d*)$/i;

async function readPart(archive, name) {
  const entry = archive.entries.find((item) => item.name === name);
  if (!entry) return null;
  const chunks = [];
  for await (const chunk of await archive.createEntryStream(entry)) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Split `<w:body>` into its top-level children, keeping each one's raw XML.
 *
 * Done by scanning rather than by building a tree: the raw source of every
 * element has to survive intact, and a tree would have to be re-serialised to
 * get it back — which is exactly the lossy step this avoids.
 */
function splitBody(xml) {
  const bodyStart = xml.search(/<w:body[\s>]/);
  if (bodyStart === -1) return { before: xml, elements: [], after: '' };
  const openEnd = xml.indexOf('>', bodyStart) + 1;
  const bodyEnd = xml.lastIndexOf('</w:body>');
  if (bodyEnd === -1) return { before: xml, elements: [], after: '' };

  const before = xml.slice(0, openEnd);
  const after = xml.slice(bodyEnd);
  const body = xml.slice(openEnd, bodyEnd);

  const elements = [];
  let index = 0;
  while (index < body.length) {
    const open = body.indexOf('<', index);
    if (open === -1) break;
    const close = body.indexOf('>', open);
    if (close === -1) break;

    const head = body.slice(open + 1, close);
    const name = head.split(/[\s/>]/)[0];
    if (head.endsWith('/')) {
      elements.push({ name, raw: body.slice(open, close + 1) });
      index = close + 1;
      continue;
    }

    // Find the matching close, counting nesting of the same element name.
    const openPattern = new RegExp(`<${name}(?=[\\s/>])`, 'g');
    const closeTag = `</${name}>`;
    let depth = 1;
    let cursor = close + 1;
    while (depth > 0 && cursor < body.length) {
      const nextClose = body.indexOf(closeTag, cursor);
      if (nextClose === -1) break;
      openPattern.lastIndex = cursor;
      let nested = 0;
      let match;
      while ((match = openPattern.exec(body)) !== null && match.index < nextClose) nested += 1;
      depth += nested - 1;
      cursor = nextClose + closeTag.length;
    }
    elements.push({ name, raw: body.slice(open, cursor) });
    index = cursor;
  }

  return { before, elements, after };
}

/** Parse one `<w:p>` into runs, its style, and its list level. */
function parseParagraph(xml) {
  const runs = [];
  let style = null;
  let numbered = null;
  let listLevel = 0;

  let inProperties = false;
  let inRunProperties = false;
  let inText = false;
  let inDeleted = false;
  let marks = {};
  let text = '';

  parseXml(xml, {
    onOpen: (rawName, attributes, selfClosing) => {
      const tag = localName(rawName);
      if (tag === 'pPr') inProperties = true;
      else if (tag === 'rPr') inRunProperties = true;
      else if (tag === 'pStyle' && inProperties) style = attributes['w:val'] ?? null;
      else if (tag === 'numPr' && inProperties) numbered = true;
      else if (tag === 'ilvl' && inProperties) listLevel = Number(attributes['w:val'] ?? 0) || 0;
      else if (tag === 'del' || tag === 'delText') inDeleted = true;
      else if (inRunProperties) {
        // `<w:b/>` means on; `<w:b w:val="0"/>` means explicitly off.
        const on = attributes['w:val'] !== '0' && attributes['w:val'] !== 'false';
        if (tag === 'b') marks.bold = on;
        else if (tag === 'i') marks.italic = on;
        else if (tag === 'u') marks.underline = on && attributes['w:val'] !== 'none';
      } else if (tag === 't') {
        inText = true;
        text = '';
      } else if (tag === 'br' || tag === 'cr') {
        runs.push(makeRun('\n', marks));
      } else if (tag === 'tab' && selfClosing) {
        runs.push(makeRun('\t', marks));
      }
    },
    onText: (chunk) => {
      if (inText && !inDeleted) text += chunk;
    },
    onClose: (rawName) => {
      const tag = localName(rawName);
      if (tag === 'pPr') inProperties = false;
      else if (tag === 'rPr') inRunProperties = false;
      else if (tag === 'del' || tag === 'delText') inDeleted = false;
      else if (tag === 't') {
        if (text) runs.push(makeRun(text, marks));
        inText = false;
        text = '';
      } else if (tag === 'r') {
        marks = {};
      }
    },
  });

  const heading = style ? HEADING_STYLE.exec(style) : null;
  if (heading) {
    return { type: 'heading', level: Number(heading[1]), runs: normaliseRuns(runs), style };
  }
  const listStyle = style ? LIST_STYLE.exec(style.replace(/\s+/g, '')) : null;
  if (numbered || listStyle) {
    const level = numbered
      ? listLevel + 1
      : Math.max(1, Number(listStyle?.[1]) || 1);
    return {
      type: 'listItem',
      level,
      ordered: /number/i.test(style ?? ''),
      runs: normaliseRuns(runs),
      style,
    };
  }
  return { type: 'paragraph', runs: normaliseRuns(runs), style };
}

/** Read a .docx into the neutral document. */
export async function readDocx(absolute, { limits = DEFAULT_DOC_LIMITS } = {}) {
  const archive = await ZipArchive.open(absolute);
  try {
    const xml = await readPart(archive, 'word/document.xml');
    if (!xml) {
      throw docError(422, 'NOT_A_DOCUMENT', 'The file has no word/document.xml — it is not a Word document');
    }

    const { before, elements, after } = splitBody(xml);
    const blocks = [];

    for (const item of elements) {
      const name = localName(item.name);
      if (name === 'p') {
        const parsed = parseParagraph(item.raw);
        blocks.push({
          ...parsed,
          raw: item.raw,
          // A copy of the runs as read, so the writer can tell whether the
          // block still matches the markup it came from.
          original: parsed.runs.map((run) => ({ ...run })),
        });
      } else {
        // A table, a section break, a bookmark — not modelled, but kept whole
        // so saving cannot lose it. The purely structural ones are carried
        // silently: showing a reader "[sectPr]" among their paragraphs tells
        // them nothing and suggests something is wrong with their document.
        blocks.push({
          type: 'opaque',
          name,
          raw: item.raw,
          runs: [makeRun(LABELS[name] ?? `[${name}]`)],
          readOnly: true,
          hidden: STRUCTURAL.has(name),
        });
      }
      if (blocks.length > limits.maxBlocks) {
        throw docError(413, 'TOO_MANY_BLOCKS', 'The document has too many blocks');
      }
    }

    // A stable handle for each block, so an edited document can be matched
    // back to the file it came from without the client having to carry the
    // original markup there and back.
    blocks.forEach((block, index) => { block.id = index; });

    return {
      blocks,
      meta: { format: 'docx', shell: { before, after } },
    };
  } finally {
    await archive.close();
  }
}

/** One run as WordprocessingML. */
function runXml(run) {
  const marks = [];
  if (run.bold) marks.push(element('w:b', {}));
  if (run.italic) marks.push(element('w:i', {}));
  if (run.underline) marks.push(element('w:u', { 'w:val': 'single' }));
  const properties = marks.length > 0 ? element('w:rPr', {}, marks.join('')) : '';

  // A run's text may hold newlines and tabs, which are elements of their own.
  const parts = [];
  const pieces = String(run.text).split(/(\n|\t)/);
  for (const piece of pieces) {
    if (piece === '') continue;
    if (piece === '\n') parts.push(element('w:br', {}));
    else if (piece === '\t') parts.push(element('w:tab', {}));
    else parts.push(element('w:t', { 'xml:space': 'preserve' }, escapeText(piece)));
  }
  return element('w:r', {}, properties + parts.join(''));
}

/** One block as a `<w:p>`, keeping its paragraph properties where known. */
function paragraphXml(block) {
  let properties = '';
  if (block.type === 'heading') {
    properties = element('w:pPr', {}, element('w:pStyle', { 'w:val': `Heading${block.level ?? 1}` }));
  } else if (block.type === 'listItem') {
    properties = element(
      'w:pPr',
      {},
      element('w:pStyle', { 'w:val': 'ListParagraph' }) +
        element(
          'w:numPr',
          {},
          element('w:ilvl', { 'w:val': String(Math.max(0, (block.level ?? 1) - 1)) }) +
            element('w:numId', { 'w:val': '1' })
        )
    );
  } else if (block.style) {
    properties = element('w:pPr', {}, element('w:pStyle', { 'w:val': block.style }));
  }

  const runs = normaliseRuns(block.runs ?? []).map((run) => runXml(run));
  return element('w:p', {}, properties + runs.join(''));
}

/**
 * Write the document back.
 *
 * A block that still matches what was read goes out as its original XML; only
 * edited blocks are regenerated. Opaque blocks — tables and everything else —
 * always go out untouched, because nothing here can edit them anyway.
 */
export async function writeDocx(document, destination) {
  const shell = document.meta?.shell;
  const body = document.blocks
    .map((block) => {
      if (block.type === 'opaque') return block.raw ?? '';
      if (isPristine(block)) return block.raw;
      return paragraphXml(block);
    })
    .join('');

  const xml = shell
    ? `${shell.before}${body}${shell.after}`
    : XML_DECLARATION +
      element(
        'w:document',
        { 'xmlns:w': W_NS },
        element('w:body', {}, body)
      );

  const now = new Date();
  const entries = [
    { relative: '[Content_Types].xml', content: Buffer.from(CONTENT_TYPES, 'utf8') },
    { relative: '_rels/.rels', content: Buffer.from(ROOT_RELS, 'utf8') },
    { relative: 'word/document.xml', content: Buffer.from(xml, 'utf8') },
  ].map((entry) => ({ ...entry, modified: now }));

  await pipeline(createZipStream(entries), createWriteStream(destination));
}

/**
 * Rewrite only `word/document.xml` inside an existing package.
 *
 * The right way to save an edit: everything else in the archive — styles,
 * numbering, fonts, embedded images, relationships — is copied across
 * verbatim. Rebuilding the package from scratch, as writeDocx does when there
 * is nothing to copy from, would throw all of that away.
 */
export async function updateDocx(document, source, destination) {
  const shell = document.meta?.shell;
  const body = document.blocks
    .map((block) => {
      if (block.type === 'opaque') return block.raw ?? '';
      if (isPristine(block)) return block.raw;
      return paragraphXml(block);
    })
    .join('');

  if (!shell) {
    await writeDocx(document, destination);
    return;
  }
  const xml = `${shell.before}${body}${shell.after}`;

  const archive = await ZipArchive.open(source);
  try {
    const entries = [];
    for (const entry of archive.entries) {
      if (entry.isDirectory) continue;
      if (entry.name === 'word/document.xml') {
        entries.push({ relative: entry.name, content: Buffer.from(xml, 'utf8'), modified: entry.mtime });
        continue;
      }
      const chunks = [];
      for await (const chunk of await archive.createEntryStream(entry)) chunks.push(chunk);
      entries.push({ relative: entry.name, content: Buffer.concat(chunks), modified: entry.mtime });
    }
    await pipeline(createZipStream(entries), createWriteStream(destination));
  } finally {
    await archive.close();
  }
}

export { blockText };
