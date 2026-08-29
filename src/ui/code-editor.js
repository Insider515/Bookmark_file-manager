import { clear, el, trapFocus } from './dom.js';
import { icon } from './icons.js';
import { registerOverlay } from './dialog.js';
import { formatBytes } from '../core/format.js';
import { highlight, languageLabel, languageOf } from './highlight.js';

/**
 * A code viewer and editor with line numbers.
 *
 * Built on a real `<textarea>` with a highlighted `<pre>` behind it, rather
 * than on a contenteditable. That choice buys everything a text editor is
 * expected to have and would otherwise have to be rebuilt badly: native undo
 * and redo, IME composition for non-Latin input, spellcheck control, mobile
 * keyboards, accessibility, and selection that behaves like every other text
 * field on the machine. The textarea is transparent and sits exactly on top of
 * the coloured copy; the two stay aligned because they share one font metric
 * and one scroll position.
 *
 * Lines do not wrap. That is deliberate: with wrapping, one logical line can
 * occupy several visual rows and the gutter would have to measure every line's
 * rendered height to stay aligned — a source of drift that no amount of care
 * removes. Not wrapping makes one line exactly one row, and the gutter is then
 * correct by construction.
 */

/** Re-highlighting is debounced by this; below a keystroke's rhythm. */
const HIGHLIGHT_DELAY = 90;

/**
 * Past this the coloured layer is dropped and the textarea is shown plain.
 *
 * Highlighting is one pass over the whole document, which is fine for source
 * files and not fine for a 40 MB log. Editing keeps working; only the colour
 * goes, and the header says so rather than the editor simply becoming slow.
 */
const HIGHLIGHT_LIMIT = 512 * 1024;

/** Indentation inserted by Tab. */
const INDENT = '  ';

/**
 * Open the editor.
 *
 * @param {object} config
 * @param {HTMLElement} config.container
 * @param {object} config.entry the file being edited
 * @param {object} config.document `{text, encoding, bom, newline, mixedNewlines, bytes}`
 * @param {boolean} [config.canSave]
 * @param {(text: string) => Promise<object>} config.onSave
 * @returns {{close: () => void, readonly dirty: boolean}}
 */
export function openCodeEditor({
  container,
  entry,
  document: source,
  canSave = true,
  onSave,
  t = (key) => key,
  errorText = (err) => err?.message ?? '',
}) {
  const language = languageOf(entry.name) ?? 'txt';
  const original = source.text ?? '';
  let dirty = false;
  let highlightTimer = null;

  const colourful = original.length <= HIGHLIGHT_LIMIT;

  // ---------------------------------------------------------------- chrome
  const title = el('h2.fsfm-code-title', { text: entry.name });
  const status = el('span.fsfm-code-status', { text: '' });
  const closeButton = el('button.fsfm-preview-close', {
    type: 'button',
    'aria-label': t('common.closeEsc'),
    title: t('common.closeEsc'),
    html: icon('xLg', 16),
  });
  const saveButton = el('button.fsfm-btn.fsfm-btn-primary', {
    type: 'button',
    text: t('common.save'),
    disabled: true,
  });

  const gutter = el('div.fsfm-code-gutter', { 'aria-hidden': 'true' });
  const highlighted = el('pre.fsfm-code-highlight', { 'aria-hidden': 'true' });
  const area = el('textarea.fsfm-code-input', {
    spellcheck: false,
    autocapitalize: 'off',
    autocomplete: 'off',
    autocorrect: 'off',
    wrap: 'off',
    readOnly: !canSave,
    'aria-label': t('code.contentOf', { name: entry.name }),
  });
  area.value = original;

  const scroller = el('div.fsfm-code-scroll', {}, [highlighted, area]);
  const body = el('div.fsfm-code-body', {}, [gutter, scroller]);

  const details = [
    // Plain text is the one label that is a word, so it arrives as a key.
    t(languageLabel(language)),
    source.encoding ?? 'utf-8',
    source.newline === '\r\n' ? 'CRLF' : 'LF',
    formatBytes(source.bytes ?? original.length, t),
  ];
  if (source.mixedNewlines) {
    // Worth saying: saving normalises them, which would otherwise show up as a
    // diff touching every line and look like the editor mangled the file.
    details.push(t('code.mixedEol'));
  }
  if (!colourful) details.push(t('code.noHighlight'));

  const notice = el('p.fsfm-code-notice', { text: details.join(' · ') });

  const panel = el('div.fsfm-code', {
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': t('code.title'),
  }, [
    el('div.fsfm-code-head', {}, [title, status, closeButton]),
    notice,
    body,
    el('div.fsfm-code-foot', {}, [
      el('span.fsfm-code-position', { text: t('code.caretStart') }),
      el('div.fsfm-sheet-actions', {}, canSave ? [saveButton] : []),
    ]),
  ]);

  const backdrop = el('div.fsfm-backdrop.fsfm-code-backdrop', {}, [panel]);
  const releaseFocus = trapFocus(panel);
  const position = panel.querySelector('.fsfm-code-position');

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(highlightTimer);
    unregister();
    document.removeEventListener('keydown', onKeyDown, true);
    releaseFocus();
    backdrop.remove();
  };
  const unregister = registerOverlay(container, () => close());

  // ------------------------------------------------------------- rendering
  let lineCount = 0;

  const renderGutter = () => {
    const lines = area.value.split('\n').length;
    if (lines === lineCount) return;
    lineCount = lines;
    const numbers = new Array(lines);
    for (let i = 0; i < lines; i += 1) numbers[i] = i + 1;
    gutter.textContent = numbers.join('\n');
  };

  const renderHighlight = () => {
    if (!colourful) return;
    // A trailing newline leaves the last line with no content to give the
    // <pre> height, so the layers drift apart by one row at the very bottom.
    const text = area.value.endsWith('\n') ? `${area.value} ` : area.value;
    highlighted.innerHTML = highlight(text, language);
  };

  const scheduleHighlight = () => {
    clearTimeout(highlightTimer);
    highlightTimer = setTimeout(renderHighlight, HIGHLIGHT_DELAY);
  };

  const syncScroll = () => {
    highlighted.scrollTop = area.scrollTop;
    highlighted.scrollLeft = area.scrollLeft;
    gutter.scrollTop = area.scrollTop;
  };

  const updatePosition = () => {
    const upto = area.value.slice(0, area.selectionStart);
    const line = upto.split('\n').length;
    const column = upto.length - upto.lastIndexOf('\n');
    position.textContent = t('code.caret', { line, column });
  };

  const markDirty = () => {
    const changed = area.value !== original;
    if (changed === dirty) return;
    dirty = changed;
    saveButton.disabled = !changed;
    status.textContent = changed ? t('common.unsaved') : '';
  };

  // ---------------------------------------------------------------- events
  area.addEventListener('input', () => {
    renderGutter();
    scheduleHighlight();
    updatePosition();
    markDirty();
  });
  area.addEventListener('scroll', syncScroll, { passive: true });
  area.addEventListener('keyup', updatePosition);
  area.addEventListener('click', updatePosition);

  area.addEventListener('keydown', (event) => {
    // Tab indents rather than leaving the field. Escape is the way out, and
    // Shift+Tab still moves focus, so the editor is not a keyboard trap.
    if (event.key === 'Tab' && !event.shiftKey && canSave) {
      event.preventDefault();
      const { selectionStart, selectionEnd, value } = area;

      if (selectionStart !== selectionEnd && value.slice(selectionStart, selectionEnd).includes('\n')) {
        // A multi-line selection indents every line it touches.
        const from = value.lastIndexOf('\n', selectionStart - 1) + 1;
        const block = value.slice(from, selectionEnd);
        const indented = block.replace(/^/gm, INDENT);
        area.setRangeText(indented, from, selectionEnd, 'select');
      } else {
        area.setRangeText(INDENT, selectionStart, selectionEnd, 'end');
      }
      area.dispatchEvent(new Event('input'));
      return;
    }

    if (event.key === 'Enter' && canSave) {
      // Keep the current line's indentation, which is the one editing
      // convenience whose absence is felt immediately.
      const { selectionStart, value } = area;
      const from = value.lastIndexOf('\n', selectionStart - 1) + 1;
      const indent = /^[ \t]*/.exec(value.slice(from, selectionStart))?.[0] ?? '';
      if (indent) {
        event.preventDefault();
        area.setRangeText(`\n${indent}`, selectionStart, area.selectionEnd, 'end');
        area.dispatchEvent(new Event('input'));
      }
      return;
    }

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      if (canSave && dirty) save();
    }
  });

  const attemptClose = () => {
    if (dirty && !window.confirm(t('common.confirmClose'))) return;
    close();
  };

  function onKeyDown(event) {
    if (!document.contains(backdrop)) return;
    if (event.key === 'Escape') {
      event.stopPropagation();
      attemptClose();
    }
  }

  async function save() {
    saveButton.disabled = true;
    status.textContent = t('common.saving');
    try {
      const result = await onSave(area.value);
      dirty = false;
      status.textContent =
        t('common.saved') +
        (result?.entry ? ` · ${formatBytes(result.entry.size, t)}` : '');
      if (result?.warnings?.length) status.textContent += ` · ${result.warnings.join('; ')}`;
    } catch (err) {
      status.textContent = errorText(err) || t('common.saveFailed');
      saveButton.disabled = false;
    }
  }

  closeButton.addEventListener('click', attemptClose);
  backdrop.addEventListener('mousedown', (event) => {
    if (event.target === backdrop) attemptClose();
  });
  saveButton.addEventListener('click', save);
  document.addEventListener('keydown', onKeyDown, true);

  container.append(backdrop);
  renderGutter();
  renderHighlight();
  updatePosition();
  area.focus();
  area.setSelectionRange(0, 0);

  return {
    close,
    get dirty() {
      return dirty;
    },
    get value() {
      return area.value;
    },
  };
}

export { languageOf, languageLabel };
