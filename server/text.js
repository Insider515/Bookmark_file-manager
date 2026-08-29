import fs from 'node:fs/promises';

import { decodeText, encodeText } from './sheet/csv.js';

/**
 * Reading and writing the plain-text files the code editor works on.
 *
 * Three things about a text file have to survive a round trip and none of them
 * is the text: its encoding, its byte-order mark and its line endings. Opening
 * a CRLF file on a Linux server and saving it back as LF rewrites every line
 * of it, which turns a one-character edit into a diff nobody can review. So
 * all three are detected on the way in and reapplied on the way out.
 *
 * The encoding detection is the same one the CSV reader uses — the problem is
 * identical and solving it twice would only give it two chances to disagree.
 */

/** Defaults; the router lets a host raise or lower them. */
export const DEFAULT_TEXT_LIMITS = {
  /** Bytes. Past this an editor in a textarea stops being usable anyway. */
  maxBytes: 8 * 1024 * 1024,
  /** Bytes sampled when deciding whether a file is text at all. */
  sniffBytes: 8192,
};

export function textError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

/**
 * Whether these bytes are text.
 *
 * A NUL byte is the test every tool uses, and it is the right one: no text
 * encoding this reads produces one, while almost every binary format does
 * within its first few kilobytes. It matters because the decoder below falls
 * back to windows-1252, which maps *every* byte — without this check a JPEG
 * would open as several megabytes of mojibake rather than being refused.
 */
export function looksBinary(buffer, sniffBytes = DEFAULT_TEXT_LIMITS.sniffBytes) {
  const window = buffer.subarray(0, Math.min(buffer.length, sniffBytes));
  // A UTF-16 file is full of NULs and is still text; its BOM says so.
  if (window.length >= 2) {
    const bom = window[0] === 0xff && window[1] === 0xfe;
    const bomBe = window[0] === 0xfe && window[1] === 0xff;
    if (bom || bomBe) return false;
  }
  return window.includes(0);
}

/** The dominant line ending, and whether the file mixes them. */
export function detectNewline(text) {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  if (crlf === 0 && lf === 0) return { newline: '\n', mixed: false };
  return { newline: crlf >= lf ? '\r\n' : '\n', mixed: crlf > 0 && lf > 0 };
}

/**
 * Read a file as text.
 *
 * @returns {Promise<{text: string, encoding: string, bom: boolean,
 *   newline: string, mixedNewlines: boolean, bytes: number}>}
 */
export async function readTextFile(absolute, { limits = DEFAULT_TEXT_LIMITS } = {}) {
  const stats = await fs.stat(absolute);
  if (!stats.isFile()) {
    throw textError(400, 'NOT_A_FILE', 'This is not a file');
  }
  if (stats.size > limits.maxBytes) {
    throw textError(
      413,
      'TEXT_TOO_LARGE',
      `The file is over ${Math.floor(limits.maxBytes / 1024 / 1024)} MB — the editor will not open it`
    );
  }

  const buffer = await fs.readFile(absolute);
  if (looksBinary(buffer, limits.sniffBytes)) {
    throw textError(415, 'NOT_TEXT', 'The file is binary: it contains NUL bytes');
  }

  const { text, encoding, bom } = decodeText(buffer);
  const { newline, mixed } = detectNewline(text);

  return {
    // Normalised for the editor, which works in one kind of line ending; the
    // original is remembered above and put back on save.
    text: text.replace(/\r\n/g, '\n'),
    encoding,
    bom,
    newline,
    mixedNewlines: mixed,
    bytes: buffer.length,
  };
}

/**
 * Serialise text back to bytes, honouring what the file used.
 *
 * @returns {{buffer: Buffer, rewritten: string|null}} `rewritten` names the
 *   encoding actually used when the original could not be reproduced.
 */
export function serializeText(text, { encoding = 'utf-8', bom = false, newline = '\n' } = {}) {
  const body = newline === '\r\n' ? String(text).replace(/\r?\n/g, '\r\n') : String(text);
  const encoded = encodeText(body, { encoding, bom });
  if (Buffer.isBuffer(encoded)) return { buffer: encoded, rewritten: null };
  return { buffer: encoded.buffer, rewritten: encoded.rewritten };
}
