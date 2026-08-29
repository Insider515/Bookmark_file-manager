import fs from 'node:fs/promises';

import { PdfBuilder, PdfDocument, copyPage } from './document.js';
import { extractPageText } from './text.js';
import { DEFAULT_DOC_LIMITS, docError } from '../model.js';

export { PdfDocument, PdfBuilder } from './document.js';
export { extractPageText } from './text.js';

/** Beyond this a document is a scanned book, not something to edit in a widget. */
const MAX_PAGES = 5000;

async function openPdf(absolute, limits) {
  const stat = await fs.stat(absolute);
  if (stat.size > limits.maxBytes) {
    throw docError(413, 'DOCUMENT_TOO_LARGE', 'The PDF is too large');
  }

  const doc = await PdfDocument.open(absolute, (path) => fs.readFile(path));
  if (doc.encrypted) {
    // Refused rather than half-read: an encrypted file's streams decode to
    // noise, and printing that as "the text of your document" is worse than
    // saying no.
    throw docError(422, 'PDF_ENCRYPTED', 'The PDF is password-protected or encrypted');
  }
  if (doc.pages.length === 0) {
    throw docError(422, 'PDF_NO_PAGES', 'No pages were found in the PDF');
  }
  if (doc.pages.length > MAX_PAGES) {
    throw docError(413, 'TOO_MANY_PAGES', `The PDF has more than ${MAX_PAGES} pages`);
  }
  return doc;
}

/**
 * Read a PDF: its pages, their geometry, and the text on each.
 *
 * The text is extracted, not stored: a PDF that came from a scanner has none
 * at all, and one that has it may still yield it in an order the layout only
 * implies. `textLayer` says which case a document is in, so the editor can be
 * honest about it instead of showing an empty box.
 */
export async function readPdf(absolute, { limits = DEFAULT_DOC_LIMITS, text = true } = {}) {
  const doc = await openPdf(absolute, limits);

  const pages = doc.pages.map((page, index) => {
    const box = doc.box(page);
    const rotation = doc.rotation(page);
    const turned = rotation === 90 || rotation === 270;
    return {
      index,
      width: Math.round(turned ? box.height : box.width),
      height: Math.round(turned ? box.width : box.height),
      rotation,
      text: text ? extractPageText(doc, page) : '',
    };
  });

  const withText = pages.filter((page) => page.text.trim() !== '').length;
  return {
    format: 'pdf',
    pages,
    textLayer: withText === 0 ? 'none' : withText < pages.length ? 'partial' : 'full',
  };
}

/**
 * Write a new PDF from pages of existing ones.
 *
 * Deleting, reordering, rotating, splitting and merging are all the same
 * operation seen from different sides: name the pages you want, in the order
 * you want them, and say how each is turned.
 *
 * @param {string[]} sources files the pages come from
 * @param {Array<{source?: number, page: number, rotate?: number}>} plan
 * @param {string} destination
 */
export async function writePdfPages(sources, plan, destination, { limits = DEFAULT_DOC_LIMITS } = {}) {
  if (!Array.isArray(plan) || plan.length === 0) {
    throw docError(400, 'PDF_NO_PAGES_SELECTED', 'No pages were selected');
  }
  if (plan.length > MAX_PAGES) {
    throw docError(413, 'TOO_MANY_PAGES', `More than ${MAX_PAGES} pages is not supported`);
  }

  const documents = [];
  for (const source of sources) {
    documents.push(await openPdf(source, limits));
  }

  const builder = new PdfBuilder();
  // One mapping per source document, so an object copied for page 1 is reused
  // for page 2 instead of being duplicated for every page that shares a font.
  const mappings = documents.map(() => new Map());
  const refs = [];

  for (const item of plan) {
    const which = Number(item.source ?? 0);
    const doc = documents[which];
    if (!doc) {
      throw docError(400, 'PDF_BAD_SOURCE', 'The named source file does not exist');
    }
    const page = doc.pages[Number(item.page)];
    if (!page) {
      throw docError(400, 'PDF_BAD_PAGE', `The file has no page ${Number(item.page) + 1}`);
    }
    const rotate = item.rotate === undefined || item.rotate === null
      ? doc.rotation(page)
      : Number(item.rotate);
    refs.push(copyPage(builder, doc, page, mappings[which], { rotate }));
  }

  await fs.writeFile(destination, builder.finish(refs));
  return { pages: refs.length };
}

/** How many pages a PDF has, without extracting any text. */
export async function countPdfPages(absolute, { limits = DEFAULT_DOC_LIMITS } = {}) {
  const doc = await openPdf(absolute, limits);
  return doc.pages.length;
}
