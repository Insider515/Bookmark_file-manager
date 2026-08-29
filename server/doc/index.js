import fs from 'node:fs/promises';
import path from 'node:path';

import { ZipArchive } from '../archive/zip-read.js';
import { readDocx, updateDocx, writeDocx } from './docx.js';
import { readOdt, updateOdt, writeOdt } from './odt.js';
import { readDoc, writeDoc } from './doc.js';
import { countPdfPages, readPdf, writePdfPages } from './pdf/index.js';
import {
  DEFAULT_DOC_LIMITS,
  assertWithinLimits,
  docError,
  emptyDocument,
  normaliseBlock,
} from './model.js';

export { DEFAULT_DOC_LIMITS, blockText, documentText, emptyDocument } from './model.js';
export { readPdf, writePdfPages, countPdfPages } from './pdf/index.js';

/**
 * The document formats this router reads and writes, all without a dependency.
 *
 * Three of them are word-processor documents and are handled as rich text:
 * docx and odt are ZIPs of XML, doc is a binary OLE2 container. PDF is the odd
 * one and is deliberately treated differently — see `kind`.
 */
export const DOCUMENT_FORMATS = {
  docx: {
    id: 'docx',
    label: 'Word (docx)',
    extensions: ['docx'],
    kind: 'rich',
    write: true,
    /** Edits keep the parts of the file this model does not describe. */
    preserves: true,
  },
  odt: {
    id: 'odt',
    label: 'OpenDocument (odt)',
    extensions: ['odt'],
    kind: 'rich',
    write: true,
    preserves: true,
  },
  doc: {
    id: 'doc',
    label: 'Word 97–2003 (doc)',
    extensions: ['doc'],
    kind: 'rich',
    write: true,
    // A .doc is rebuilt from scratch on save; there is no original markup to
    // fall back on, so anything this model cannot express is lost.
    preserves: false,
  },
  pdf: {
    id: 'pdf',
    label: 'PDF',
    extensions: ['pdf'],
    kind: 'pdf',
    /**
     * PDF text is not editable here, and that is a decision rather than a gap.
     * A page holds positioned glyph runs, not sentences: changing a word means
     * re-flowing a line that the file never described as a line, in a font
     * that is usually subsetted to only the glyphs already used. Tools that
     * offer it either rewrite the page as an image or quietly corrupt the
     * layout. What *is* honest on this format is working with whole pages.
     */
    write: false,
    pages: true,
    preserves: true,
  },
};

export const DOCUMENT_FORMAT_IDS = Object.keys(DOCUMENT_FORMATS);

const BY_EXTENSION = Object.values(DOCUMENT_FORMATS).flatMap((format) =>
  format.extensions.map((extension) => [extension, format.id])
);

/** The format a filename claims, or null. */
export function documentFormatOf(name) {
  const lower = String(name).toLowerCase();
  for (const [extension, id] of BY_EXTENSION) {
    if (lower.endsWith(`.${extension}`)) return DOCUMENT_FORMATS[id];
  }
  return null;
}

export function isDocumentName(name) {
  return documentFormatOf(name) !== null;
}

/** What the first bytes say the file really is. */
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

  if (head.length >= 5 && head.toString('latin1', 0, 5) === '%PDF-') return 'pdf';
  if (head.length >= 2 && head[0] === 0x50 && head[1] === 0x4b) return 'zip';
  if (
    head.length >= 4 &&
    head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0
  ) {
    return 'ole2';
  }
  return 'other';
}

/** Which ZIP-based document this is, decided by what is inside it. */
async function sniffZip(absolute) {
  try {
    const archive = await ZipArchive.open(absolute);
    try {
      const names = archive.entries.map((entry) => entry.name);
      if (names.includes('word/document.xml')) return DOCUMENT_FORMATS.docx;
      if (names.includes('content.xml')) return DOCUMENT_FORMATS.odt;
    } finally {
      await archive.close();
    }
  } catch {
    /* fall through to the name */
  }
  return null;
}

/**
 * Reading and writing documents, and saying what each format can do.
 *
 * As with the spreadsheet service, the work is in the per-format modules; what
 * lives here is deciding which one applies and refusing the cases where the
 * honest answer is no.
 */
export class DocumentService {
  #limits;

  constructor({ limits = {} } = {}) {
    this.#limits = { ...DEFAULT_DOC_LIMITS, ...limits };
  }

  get limits() {
    return this.#limits;
  }

  capabilities() {
    const result = {};
    for (const id of DOCUMENT_FORMAT_IDS) {
      const format = DOCUMENT_FORMATS[id];
      result[id] = {
        read: true,
        write: Boolean(format.write),
        pages: Boolean(format.pages),
        preserves: Boolean(format.preserves),
        kind: format.kind,
        label: format.label,
        extensions: format.extensions,
      };
    }
    return result;
  }

  /**
   * Which format a file is.
   *
   * The bytes overrule the name wherever they disagree, because a `.doc` that
   * is really a zip is a docx someone renamed — a genuinely common case, since
   * Word will save one under the other's extension without complaint.
   */
  async detect(absolute, name) {
    const byName = documentFormatOf(name);
    const shape = await sniff(absolute);

    if (shape === 'pdf') return DOCUMENT_FORMATS.pdf;
    if (shape === 'ole2') return DOCUMENT_FORMATS.doc;
    if (shape === 'zip') {
      return (await sniffZip(absolute)) ?? (byName?.kind === 'rich' ? byName : DOCUMENT_FORMATS.docx);
    }
    return byName;
  }

  async read(absolute, name) {
    const format = await this.detect(absolute, name);
    if (!format) {
      throw docError(415, 'NOT_A_DOCUMENT', 'This file is not a document');
    }

    if (format.kind === 'pdf') {
      return { ...(await readPdf(absolute, { limits: this.#limits })), format: 'pdf' };
    }

    const stat = await fs.stat(absolute);
    if (stat.size > this.#limits.maxBytes) {
      throw docError(413, 'DOCUMENT_TOO_LARGE', 'The document is too large');
    }

    let document;
    if (format.id === 'docx') document = await readDocx(absolute, { limits: this.#limits });
    else if (format.id === 'odt') document = await readOdt(absolute, { limits: this.#limits });
    else document = await readDoc(absolute, { limits: this.#limits });

    assertWithinLimits(document, this.#limits);
    return {
      format: format.id,
      kind: 'rich',
      preserves: Boolean(format.preserves),
      // The original markup stays on this side. It is the largest part of a
      // document by far, the client has no use for it, and anything sent to a
      // browser is something that can come back changed.
      blocks: document.blocks.map((block) => publicBlock(block)),
      meta: { format: format.id },
    };
  }

  /**
   * Write a document back.
   *
   * @param {string} destination where to write (may be a temporary file)
   * @param {string} name used to pick the format when none is given
   * @param {object} document blocks as the editor sends them
   * @param {{format?: string, source?: string, meta?: object}} [options]
   */
  async write(destination, name, document, { format: formatId, source, meta } = {}) {
    const format = formatId ? DOCUMENT_FORMATS[formatId] : documentFormatOf(name);
    if (!format) {
      throw docError(415, 'NOT_A_DOCUMENT', 'Unknown document format');
    }
    if (!format.write) {
      throw docError(
        400,
        'FORMAT_READ_ONLY',
        `${format.label} cannot be saved as text — only page operations are available for PDF`
      );
    }

    // Re-read the file being saved over, to recover the markup of the blocks
    // nobody edited. Matching is by the id handed out at read time, so a block
    // that was moved or had one inserted above it is still matched correctly.
    let originals = null;
    let shell = null;
    if (source && format.preserves) {
      const sourceFormat = await this.detect(source, name);
      if (sourceFormat?.id === format.id) {
        const previous = format.id === 'docx'
          ? await readDocx(source, { limits: this.#limits })
          : await readOdt(source, { limits: this.#limits });
        originals = previous.blocks;
        shell = previous.meta.shell;
      }
    }

    const incoming = Array.isArray(document?.blocks) ? document.blocks : [];
    const blocks = [];
    incoming.forEach((block, index) => {
      const original =
        originals && Number.isInteger(block?.id) ? originals[block.id] : null;

      if (block?.hidden || block?.type === 'opaque') {
        // These stand for parts of the document the editor cannot show — a
        // table, a frame, the start of a list. There is nothing to validate,
        // and without the file's own copy there is nothing to write either.
        if (original) blocks.push(original);
        return;
      }

      const normalised = normaliseBlock(block, index);
      if (original) {
        normalised.raw = original.raw;
        normalised.original = original.original;
        normalised.style = original.style;
        if (original.inList) normalised.inList = original.inList;
      }
      blocks.push(normalised);
    });

    const prepared = {
      blocks: blocks.length > 0 ? blocks : emptyDocument().blocks,
      meta: { ...(meta ?? {}), ...(shell ? { shell } : {}) },
    };
    assertWithinLimits(prepared, this.#limits);

    const warnings = [];
    if (format.id === 'docx') {
      if (source) await updateDocx(prepared, source, destination);
      else await writeDocx(prepared, destination);
    } else if (format.id === 'odt') {
      if (source) await updateOdt(prepared, source, destination);
      else await writeOdt(prepared, destination);
    } else {
      const result = await writeDoc(prepared, destination);
      warnings.push(...result.warnings);
    }

    if (!format.preserves && source) {
      warnings.push(
        '.doc is rewritten from scratch: images, text boxes and styles the editor does not show will not survive. Choose .docx to keep everything.'
      );
    }
    return { format: format.id, warnings };
  }

  /**
   * Rearrange the pages of a PDF.
   *
   * @param {string[]} sources
   * @param {Array<{source?: number, page: number, rotate?: number}>} plan
   * @param {string} destination
   */
  async pages(sources, plan, destination) {
    return writePdfPages(sources, plan, destination, { limits: this.#limits });
  }

  async pageCount(absolute) {
    return countPdfPages(absolute, { limits: this.#limits });
  }

  /** A blank document of the given format, for creating one. */
  async create(destination, name, { format: formatId } = {}) {
    const format = formatId ? DOCUMENT_FORMATS[formatId] : documentFormatOf(name);
    if (!format || !format.write) {
      throw docError(415, 'NOT_A_DOCUMENT', 'This format cannot be created');
    }
    const document = emptyDocument();
    if (format.id === 'docx') await writeDocx(document, destination);
    else if (format.id === 'odt') await writeOdt(document, destination);
    else await writeDoc(document, destination);
    return { format: format.id };
  }
}

/**
 * A block as the client sees it: everything except the file's own markup.
 */
function publicBlock(block) {
  const { raw, original, inList, ...rest } = block;
  return rest;
}

export { docError, normaliseBlock, assertWithinLimits, path as documentPath };
