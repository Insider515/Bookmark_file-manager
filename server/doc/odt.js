import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

import { createZipStream } from '../zip.js';
import { ZipArchive } from '../archive/zip-read.js';
import { XML_DECLARATION, element, escapeText, localName, parseXml } from '../sheet/xml.js';
import { DEFAULT_DOC_LIMITS, docError, isPristine, makeRun, normaliseRuns } from './model.js';

/**
 * odt — OpenDocument Text, read and written without a dependency.
 *
 * Same package shape as ods: a ZIP whose `content.xml` holds the body. The
 * difference from docx that matters is where formatting lives. WordprocessingML
 * puts bold on the run itself; OpenDocument puts a *style name* on the span and
 * defines that style elsewhere, in `<office:automatic-styles>`. So reading
 * "which words are bold" means reading the style table first and resolving
 * names through it — a span alone says nothing.
 *
 * As with docx, every top-level body element keeps its source XML and only
 * edited blocks are regenerated, so tables, frames and images survive an edit
 * to the paragraph next to them.
 */

const MIMETYPE = 'application/vnd.oasis.opendocument.text';

const NS = {
  office: 'urn:oasis:names:tc:opendocument:xmlns:office:1.0',
  text: 'urn:oasis:names:tc:opendocument:xmlns:text:1.0',
  style: 'urn:oasis:names:tc:opendocument:xmlns:style:1.0',
  fo: 'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0',
  table: 'urn:oasis:names:tc:opendocument:xmlns:table:1.0',
  manifest: 'urn:oasis:names:tc:opendocument:xmlns:manifest:1.0',
};

/** Style names this writer generates, one per mark combination it can produce. */
const MARK_STYLES = [
  { name: 'FSFM_B', bold: true },
  { name: 'FSFM_I', italic: true },
  { name: 'FSFM_U', underline: true },
  { name: 'FSFM_BI', bold: true, italic: true },
  { name: 'FSFM_BU', bold: true, underline: true },
  { name: 'FSFM_IU', italic: true, underline: true },
  { name: 'FSFM_BIU', bold: true, italic: true, underline: true },
];

const styleFor = (run) =>
  MARK_STYLES.find(
    (style) =>
      Boolean(style.bold) === Boolean(run.bold) &&
      Boolean(style.italic) === Boolean(run.italic) &&
      Boolean(style.underline) === Boolean(run.underline)
  )?.name ?? null;

const MANIFEST =
  XML_DECLARATION +
  element(
    'manifest:manifest',
    { 'xmlns:manifest': NS.manifest, 'manifest:version': '1.3' },
    element('manifest:file-entry', {
      'manifest:full-path': '/',
      'manifest:version': '1.3',
      'manifest:media-type': MIMETYPE,
    }) +
      element('manifest:file-entry', {
        'manifest:full-path': 'content.xml',
        'manifest:media-type': 'text/xml',
      })
  );

async function readPart(archive, name) {
  const entry = archive.entries.find((item) => item.name === name);
  if (!entry) return null;
  const chunks = [];
  for await (const chunk of await archive.createEntryStream(entry)) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * The automatic style table: which style names mean bold, italic, underline.
 *
 * Without this a span carries only a name like "T3" and its formatting is
 * unknowable.
 */
function parseStyles(xml) {
  const marks = new Map();
  let current = null;

  parseXml(xml, {
    onOpen: (rawName, attributes) => {
      const tag = localName(rawName);
      if (tag === 'style') {
        current = attributes['style:name'] ?? null;
      } else if (tag === 'text-properties' && current) {
        const entry = {};
        const weight = attributes['fo:font-weight'];
        const posture = attributes['fo:font-style'];
        const underline = attributes['style:text-underline-style'];
        if (weight && weight !== 'normal') entry.bold = true;
        if (posture && posture !== 'normal') entry.italic = true;
        if (underline && underline !== 'none') entry.underline = true;
        if (Object.keys(entry).length > 0) marks.set(current, entry);
      }
    },
    onClose: (rawName) => {
      if (localName(rawName) === 'style') current = null;
    },
  });
  return marks;
}

/** Split `<office:text>` into its top-level children, keeping their raw XML. */
function splitBody(xml) {
  const start = xml.search(/<office:text[\s>]/);
  if (start === -1) return { before: xml, elements: [], after: '' };
  const openEnd = xml.indexOf('>', start) + 1;
  const end = xml.lastIndexOf('</office:text>');
  if (end === -1) return { before: xml, elements: [], after: '' };

  const before = xml.slice(0, openEnd);
  const after = xml.slice(end);
  const body = xml.slice(openEnd, end);

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

/** Parse one paragraph or heading into runs. */
function parseParagraph(xml, styleMarks) {
  const runs = [];
  const spanStack = [];
  let text = '';
  let outlineLevel = 0;
  let paragraphStyle = null;

  const currentMarks = () => Object.assign({}, ...spanStack);

  const flush = () => {
    if (text) runs.push(makeRun(text, currentMarks()));
    text = '';
  };

  parseXml(xml, {
    onOpen: (rawName, attributes, selfClosing) => {
      const tag = localName(rawName);
      if (tag === 'h' || tag === 'p') {
        outlineLevel = Number(attributes['text:outline-level'] ?? 0) || 0;
        paragraphStyle = attributes['text:style-name'] ?? null;
      } else if (tag === 'span') {
        flush();
        spanStack.push(styleMarks.get(attributes['text:style-name']) ?? {});
      } else if (tag === 's') {
        text += ' '.repeat(Number(attributes['text:c'] ?? 1) || 1);
      } else if (tag === 'tab') {
        text += '\t';
      } else if (tag === 'line-break') {
        text += '\n';
      }
      if (selfClosing && tag === 'span') spanStack.pop();
    },
    onText: (chunk) => {
      text += chunk;
    },
    onClose: (rawName) => {
      const tag = localName(rawName);
      if (tag === 'span') {
        flush();
        spanStack.pop();
      }
    },
  });
  flush();

  const isHeading = /<text:h[\s>]/.test(xml);
  if (isHeading) {
    return {
      type: 'heading',
      level: Math.min(6, Math.max(1, outlineLevel || 1)),
      runs: normaliseRuns(runs),
      style: paragraphStyle,
    };
  }
  return { type: 'paragraph', runs: normaliseRuns(runs), style: paragraphStyle };
}

export async function readOdt(absolute, { limits = DEFAULT_DOC_LIMITS } = {}) {
  const archive = await ZipArchive.open(absolute);
  try {
    const xml = await readPart(archive, 'content.xml');
    if (!xml) {
      throw docError(422, 'NOT_A_DOCUMENT', 'The file has no content.xml — it is not an ODF document');
    }

    const styleMarks = parseStyles(xml);
    const { before, elements, after } = splitBody(xml);
    const blocks = [];

    const addParagraph = (raw) => {
      const parsed = parseParagraph(raw, styleMarks);
      blocks.push({ ...parsed, raw, original: parsed.runs.map((run) => ({ ...run })) });
    };

    for (const item of elements) {
      const name = localName(item.name);
      if (name === 'p' || name === 'h') {
        addParagraph(item.raw);
      } else if (name === 'list') {
        // A list is a container of paragraphs; keeping it whole would make its
        // items uneditable, so the items are surfaced and the list is rebuilt
        // around them on save, from the run of list blocks itself.
        const inner = [...item.raw.matchAll(/<text:p[\s>][\s\S]*?<\/text:p>|<text:p\/>/g)];
        if (inner.length === 0) {
          blocks.push({ type: 'opaque', name, raw: item.raw, runs: [makeRun('[list]')], readOnly: true });
        } else {
          for (const match of inner) {
            const parsed = parseParagraph(match[0], styleMarks);
            blocks.push({
              type: 'listItem',
              level: 1,
              ordered: false,
              runs: parsed.runs,
              raw: match[0],
              original: parsed.runs.map((run) => ({ ...run })),
              inList: item.raw,
            });
          }
        }
      } else {
        blocks.push({
          type: 'opaque',
          name,
          raw: item.raw,
          runs: [makeRun(name === 'table' ? '[table]' : `[${name}]`)],
          readOnly: true,
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

    return { blocks, meta: { format: 'odt', shell: { before, after } } };
  } finally {
    await archive.close();
  }
}

/** One run as OpenDocument, wrapped in a span when it carries marks. */
function runXml(run) {
  const pieces = String(run.text).split(/(\n|\t)/);
  const inner = pieces
    .map((piece) => {
      if (piece === '') return '';
      if (piece === '\n') return element('text:line-break', {});
      if (piece === '\t') return element('text:tab', {});
      return escapeText(piece);
    })
    .join('');

  const style = styleFor(run);
  return style ? element('text:span', { 'text:style-name': style }, inner) : inner;
}

function paragraphXml(block) {
  const runs = normaliseRuns(block.runs ?? []).map((run) => runXml(run)).join('');
  if (block.type === 'heading') {
    return element(
      'text:h',
      { 'text:style-name': block.style ?? 'Heading', 'text:outline-level': String(block.level ?? 1) },
      runs
    );
  }
  return element(
    'text:p',
    { 'text:style-name': block.style ?? (block.type === 'listItem' ? 'List_20_Paragraph' : 'Standard') },
    runs
  );
}

/** Serialise the body, rebuilding lists around their items. */
function bodyXml(blocks) {
  const out = [];
  let listBuffer = null;
  let listSource = '';

  const closeList = () => {
    if (!listBuffer) return;
    // The original list element's opening tag is reused where there was one,
    // so its numbering style survives; a list created here gets a plain one.
    const openTag = /^<text:list[^>]*>/.exec(listSource)?.[0] ?? '<text:list>';
    out.push(
      openTag + listBuffer.map((item) => element('text:list-item', {}, item)).join('') + '</text:list>'
    );
    listBuffer = null;
    listSource = '';
  };

  for (const block of blocks) {
    if (block.hidden) continue;
    if (block.type === 'opaque') {
      closeList();
      out.push(block.raw ?? '');
      continue;
    }

    const xml = isPristine(block) ? block.raw : paragraphXml(block);

    // A run of list items is one list. Driving this off the blocks themselves
    // rather than off markers left by the reader is what makes a document
    // created from nothing come out with its lists intact.
    if (block.type === 'listItem') {
      if (!listBuffer) {
        listBuffer = [];
        listSource = block.inList ?? '';
      }
      listBuffer.push(xml);
      continue;
    }

    closeList();
    out.push(xml);
  }
  closeList();
  return out.join('');
}

/** The automatic styles this writer's spans refer to. */
function markStylesXml() {
  return MARK_STYLES.map((style) =>
    element(
      'style:style',
      { 'style:name': style.name, 'style:family': 'text' },
      element('style:text-properties', {
        'fo:font-weight': style.bold ? 'bold' : null,
        'style:font-weight-asian': style.bold ? 'bold' : null,
        'fo:font-style': style.italic ? 'italic' : null,
        'style:text-underline-style': style.underline ? 'solid' : null,
        'style:text-underline-width': style.underline ? 'auto' : null,
        'style:text-underline-color': style.underline ? 'font-color' : null,
      })
    )
  ).join('');
}

export async function writeOdt(document, destination) {
  const body = bodyXml(document.blocks);
  const content =
    XML_DECLARATION +
    element(
      'office:document-content',
      {
        'xmlns:office': NS.office,
        'xmlns:text': NS.text,
        'xmlns:style': NS.style,
        'xmlns:fo': NS.fo,
        'xmlns:table': NS.table,
        'office:version': '1.3',
      },
      element('office:automatic-styles', {}, markStylesXml()) +
        element('office:body', {}, element('office:text', {}, body))
    );

  const now = new Date();
  await pipeline(
    createZipStream([
      { relative: 'mimetype', content: Buffer.from(MIMETYPE, 'utf8'), store: true, modified: now },
      { relative: 'META-INF/manifest.xml', content: Buffer.from(MANIFEST, 'utf8'), modified: now },
      { relative: 'content.xml', content: Buffer.from(content, 'utf8'), modified: now },
    ]),
    createWriteStream(destination)
  );
}

/**
 * Rewrite only `content.xml` inside an existing package, keeping styles,
 * images and metadata. The same reasoning as updateDocx.
 */
export async function updateOdt(document, source, destination) {
  const shell = document.meta?.shell;
  if (!shell) {
    await writeOdt(document, destination);
    return;
  }

  const body = bodyXml(document.blocks);
  let xml = `${shell.before}${body}${shell.after}`;
  // The spans this writer emits need their styles declared; the originals are
  // already in the shell, so these are appended to whatever is there.
  xml = xml.replace(
    /<\/office:automatic-styles>/,
    `${markStylesXml()}</office:automatic-styles>`
  );

  const archive = await ZipArchive.open(source);
  try {
    const entries = [];
    for (const entry of archive.entries) {
      if (entry.isDirectory) continue;
      if (entry.name === 'content.xml') {
        entries.push({ relative: entry.name, content: Buffer.from(xml, 'utf8'), modified: entry.mtime });
        continue;
      }
      const chunks = [];
      for await (const chunk of await archive.createEntryStream(entry)) chunks.push(chunk);
      entries.push({
        relative: entry.name,
        content: Buffer.concat(chunks),
        modified: entry.mtime,
        // The mimetype entry must stay first and uncompressed, as when written.
        store: entry.name === 'mimetype',
      });
    }
    entries.sort((a, b) => (a.relative === 'mimetype' ? -1 : b.relative === 'mimetype' ? 1 : 0));
    await pipeline(createZipStream(entries), createWriteStream(destination));
  } finally {
    await archive.close();
  }
}
