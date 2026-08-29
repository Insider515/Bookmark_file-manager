/**
 * The neutral rich-text document every format is read into.
 *
 * A document is a flat list of blocks, and a block is a paragraph, a heading
 * or a list item made of runs — spans of text that share their bold, italic
 * and underline state. That is deliberately less than any of these formats can
 * express, and the design compensates for it in a way that matters:
 *
 *   every block keeps the *original markup it came from*.
 *
 * On save, a block whose text nobody touched is written back byte for byte,
 * and only edited blocks are regenerated. So opening a document with tables,
 * images, footnotes and styles, changing one sentence and saving keeps all of
 * it — the loss is confined to the fine formatting inside the paragraph that
 * was actually edited, and the editor says so.
 *
 * Without that, "edit" would mean "reduce the document to the subset this
 * model understands", which for someone's contract is not editing at all.
 */

export const BLOCK_TYPES = ['paragraph', 'heading', 'listItem'];

export const DEFAULT_DOC_LIMITS = {
  /** Blocks a document may contain. */
  maxBlocks: 50000,
  /** Characters in one block. */
  maxBlockLength: 100000,
  /** Characters in the whole document. */
  maxCharacters: 5000000,
  /** Bytes of source file. */
  maxBytes: 32 * 1024 * 1024,
};

export function docError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

/**
 * One run of text with its marks.
 * @param {string} text
 * @param {{bold?: boolean, italic?: boolean, underline?: boolean}} [marks]
 */
export function makeRun(text, marks = {}) {
  const run = { text: String(text) };
  if (marks.bold) run.bold = true;
  if (marks.italic) run.italic = true;
  if (marks.underline) run.underline = true;
  return run;
}

/**
 * One block.
 *
 * `raw` is the markup this block was read from; `id` lets the editor send an
 * edited block back and have it matched to its original. Neither is shown to
 * the user — they exist so that saving is not destructive.
 */
export function makeBlock(type, runs, extra = {}) {
  return {
    type,
    runs: runs.length > 0 ? runs : [makeRun('')],
    ...extra,
  };
}

/** The plain text of a block. */
export function blockText(block) {
  return (block.runs ?? []).map((run) => run.text).join('');
}

/** The plain text of a whole document, one block per line. */
export function documentText(document) {
  return document.blocks.map((block) => blockText(block)).join('\n');
}

/**
 * Whether two run lists carry the same content *and* the same marks.
 *
 * Used to decide if a block may be written back from its original markup.
 * Comparing only the text would silently drop a bold the user removed.
 */
export function runsEqual(a = [], b = []) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (
      a[i].text !== b[i].text ||
      Boolean(a[i].bold) !== Boolean(b[i].bold) ||
      Boolean(a[i].italic) !== Boolean(b[i].italic) ||
      Boolean(a[i].underline) !== Boolean(b[i].underline)
    ) {
      return false;
    }
  }
  return true;
}

/** True when a block is unchanged from what was read and can be reused as-is. */
export function isPristine(block) {
  return Boolean(block.raw) && runsEqual(block.runs, block.original);
}

/**
 * Merge adjacent runs that share their marks.
 *
 * An editor that toggles bold on and off produces long chains of one-character
 * runs; writing those out makes a file several times larger than it needs to
 * be and is unreadable to anyone who opens the XML.
 */
export function normaliseRuns(runs) {
  const out = [];
  for (const run of runs) {
    if (!run || run.text === '') continue;
    const last = out[out.length - 1];
    if (
      last &&
      Boolean(last.bold) === Boolean(run.bold) &&
      Boolean(last.italic) === Boolean(run.italic) &&
      Boolean(last.underline) === Boolean(run.underline)
    ) {
      last.text += run.text;
    } else {
      out.push(makeRun(run.text, run));
    }
  }
  return out.length > 0 ? out : [makeRun('')];
}

/** Bring a block from the client back to the shape the writers expect. */
export function normaliseBlock(block, index) {
  const type = BLOCK_TYPES.includes(block?.type) ? block.type : 'paragraph';
  const runs = normaliseRuns(Array.isArray(block?.runs) ? block.runs : [makeRun(String(block?.text ?? ''))]);
  const out = { type, runs, index };
  if (type === 'heading') out.level = Math.min(6, Math.max(1, Number(block.level) || 1));
  if (type === 'listItem') {
    out.level = Math.min(9, Math.max(1, Number(block.level) || 1));
    out.ordered = Boolean(block.ordered);
  }
  // `raw` and `original` are deliberately *not* taken from the caller. They
  // hold markup that is written into the file verbatim, and a block arriving
  // from a browser is untrusted input; the server re-reads them from the file
  // being saved over instead. Only the block's identity comes back.
  if (Number.isInteger(block?.id)) out.id = block.id;
  return out;
}

export function assertWithinLimits(document, limits = DEFAULT_DOC_LIMITS) {
  if (document.blocks.length > limits.maxBlocks) {
    throw docError(413, 'TOO_MANY_BLOCKS', `More than ${limits.maxBlocks} paragraphs is not supported`);
  }
  let characters = 0;
  for (const block of document.blocks) {
    const length = blockText(block).length;
    if (length > limits.maxBlockLength) {
      throw docError(413, 'BLOCK_TOO_LONG', 'The paragraph is too long');
    }
    characters += length;
    if (characters > limits.maxCharacters) {
      throw docError(413, 'DOCUMENT_TOO_LONG', 'The document is too large');
    }
  }
  return document;
}

/** An empty document, for creating one from nothing. */
export function emptyDocument() {
  return { blocks: [makeBlock('paragraph', [makeRun('')])], meta: {} };
}
