import { clear, el, trapFocus } from './dom.js';
import { registerOverlay } from './dialog.js';
import { icon } from './icons.js';
import { attachIconFallbacks, resolveFileIcon } from './file-icon.js';
import { formatBytes, formatDate, parentPath } from '../core/format.js';

/**
 * Recursive search across the tree.
 *
 * Deliberately not the filter box in the toolbar. That one narrows the folder
 * already on screen and answers instantly because the data is already here;
 * this one walks the filesystem, can take seconds, can be cancelled, and
 * returns things from folders the user is not looking at. Presenting them as
 * the same control would mean one of the two behaving surprisingly — so the
 * filter stays what it was, and this opens over it.
 *
 * Results show where each hit lives, because a bare filename is not an answer
 * when the whole point is that the file is somewhere else.
 */

// Module constants, so the labels are translation keys resolved per dialog
// rather than text frozen at import time.
const MODES = [
  { value: 'substring', labelKey: 'search.modeSubstring' },
  { value: 'glob', labelKey: 'search.modeGlob' },
  { value: 'regex', labelKey: 'search.modeRegex' },
];

const TYPES = [
  { value: 'all', labelKey: 'search.scopeAll' },
  { value: 'file', labelKey: 'search.scopeFiles' },
  { value: 'directory', labelKey: 'search.scopeFolders' },
];

const HINT_KEYS = {
  substring: 'search.hintSubstring',
  glob: 'search.hintGlob',
  regex: 'search.hintRegex',
};

/**
 * @param {object} config
 * @param {HTMLElement} config.container
 * @param {string} config.path where the search starts
 * @param {object} [config.capabilities] the server's `/config.search`
 * @param {object} [config.icons] how the list draws icons, so results match
 * @param {string} [config.query] prefill
 * @param {(options: object, signal: AbortSignal) => Promise<object>} config.onSearch
 * @param {(entry: object) => void} [config.onReveal] show the hit in its folder
 * @param {(entry: object) => void} [config.onOpen] open the hit
 */
export function openSearchDialog({
  container,
  path: basePath = '/',
  capabilities = {},
  query: initialQuery = '',
  icons = {},
  onSearch,
  onReveal,
  onOpen,
  t = (key) => key,
  localeTag = undefined,
  errorText = (err) => err?.message ?? '',
}) {
  const canSearchContent = capabilities.content !== false;

  const queryInput = el('input.fsfm-input.fsfm-search-query', {
    type: 'search',
    value: initialQuery,
    placeholder: t('search.queryPlaceholder'),
    spellcheck: false,
    'aria-label': t('search.queryLabel'),
  });
  const modeSelect = el('select.fsfm-input', { 'aria-label': t('search.modeLabel') },
    MODES.map((mode) => el('option', { value: mode.value, text: t(mode.labelKey) })));
  const typeSelect = el('select.fsfm-input', { 'aria-label': t('search.queryLabel') },
    TYPES.map((type) => el('option', { value: type.value, text: t(type.labelKey) })));
  const extensionsInput = el('input.fsfm-input', {
    type: 'text',
    placeholder: 'js, ts, md',
    spellcheck: false,
    'aria-label': t('search.extensionsPlaceholder'),
  });

  const caseBox = el('input', { type: 'checkbox', id: 'fsfm-search-case' });
  const contentBox = el('input', {
    type: 'checkbox',
    id: 'fsfm-search-content',
    disabled: !canSearchContent,
  });

  const hint = el('p.fsfm-search-hint', { text: t(HINT_KEYS.substring) });
  const status = el('p.fsfm-search-status', { text: '' });
  const results = el('div.fsfm-search-results', { tabindex: '-1' });

  const runButton = el('button.fsfm-btn.fsfm-btn-primary', { type: 'button', text: t('search.run') });
  const stopButton = el('button.fsfm-btn', { type: 'button', text: t('search.stop'), hidden: true });
  const closeButton = el('button.fsfm-preview-close', {
    type: 'button',
    'aria-label': t('common.closeEsc'),
    title: t('common.closeEsc'),
    html: icon('xLg', 16),
  });

  const field = (label, control, extra = null) =>
    el('label.fsfm-search-field', {}, [
      el('span.fsfm-search-label', { text: label }),
      control,
      extra,
    ].filter(Boolean));

  const check = (box, label, note) =>
    el('label.fsfm-search-check', { for: box.id, title: note ?? '' }, [
      box,
      el('span', { text: label }),
    ]);

  const panel = el('div.fsfm-search-panel', {
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': t('search.title'),
  }, [
    el('div.fsfm-search-head', {}, [
      el('h2.fsfm-search-title', { text: t('search.heading') }),
      el('span.fsfm-search-scope', { text: t('search.inPath', { path: basePath }) }),
      closeButton,
    ]),
    el('div.fsfm-search-form', {}, [
      el('div.fsfm-search-row', {}, [
        field(t('search.query'), queryInput),
        field(t('search.mode'), modeSelect),
      ]),
      el('div.fsfm-search-row', {}, [
        field(t('search.scope'), typeSelect),
        field(t('search.extensions'), extensionsInput),
      ]),
      el('div.fsfm-search-row.fsfm-search-checks', {}, [
        check(caseBox, t('search.caseSensitive'), t('search.caseSensitiveHint')),
        check(
          contentBox,
          t('search.inContent'),
          canSearchContent ? t('search.inContentHint') : t('search.inContentDenied')
        ),
        el('div.fsfm-search-actions', {}, [stopButton, runButton]),
      ]),
      hint,
    ]),
    status,
    results,
  ]);

  const backdrop = el('div.fsfm-backdrop.fsfm-search-backdrop', {}, [panel]);
  const releaseFocus = trapFocus(panel);

  let controller = null;
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    controller?.abort();
    unregister();
    document.removeEventListener('keydown', onKeyDown, true);
    releaseFocus();
    backdrop.remove();
  };
  const unregister = registerOverlay(container, () => close());

  modeSelect.addEventListener('change', () => {
    hint.textContent = t(HINT_KEYS[modeSelect.value] ?? '');
  });

  // Searching inside files means the query is matched against lines, so a mask
  // anchored to a whole name would almost never hit. Say so rather than let it
  // silently return nothing.
  const syncContentHint = () => {
    const awkward = contentBox.checked && modeSelect.value === 'glob';
    hint.classList.toggle('is-warning', awkward);
    if (awkward) {
      hint.textContent = t('search.globContentNote');
    } else {
      hint.textContent = t(HINT_KEYS[modeSelect.value] ?? '');
    }
    typeSelect.querySelector('option[value="directory"]').disabled = contentBox.checked;
    if (contentBox.checked && typeSelect.value === 'directory') typeSelect.value = 'all';
  };
  contentBox.addEventListener('change', syncContentHint);
  modeSelect.addEventListener('change', syncContentHint);

  const rowFor = (entry) => {
    const where = entry.parent ?? parentPath(entry.path);
    // Drawn the same way the listing draws it, so a result looks like the
    // file it will turn into once the user clicks through.
    const glyph = resolveFileIcon(entry, {
      iconBasePath: icons.iconBasePath ?? null,
      customize: icons.customize ?? null,
      size: 20,
    });

    const lines = (entry.lines ?? []).map((line) =>
      el('div.fsfm-search-line', {}, [
        el('span.fsfm-search-lineno', { text: String(line.line) }),
        // Only the matched part is marked; building it from text nodes keeps
        // the file's own content out of innerHTML.
        el('span.fsfm-search-linetext', {}, [
          document.createTextNode(line.text.slice(0, line.column)),
          el('mark', { text: line.text.slice(line.column, line.column + line.length) }),
          document.createTextNode(line.text.slice(line.column + line.length)),
        ]),
      ])
    );

    const row = el('div.fsfm-search-row-item', {
      role: 'button',
      tabindex: '0',
      dataset: { path: entry.path },
      title: entry.path,
    }, [
      el('div.fsfm-search-main', {}, [
        el('span.fsfm-search-icon', { html: glyph }),
        el('span.fsfm-search-name', { text: entry.name }),
        el('span.fsfm-search-where', { text: where }),
        el('span.fsfm-search-meta', {
          text: entry.isDirectory
            ? t('common.folder')
            : `${formatBytes(entry.size, t)} · ${formatDate(entry.modified, localeTag)}`,
        }),
      ]),
      ...lines,
    ]);

    const activate = (open) => {
      if (open && onOpen) onOpen(entry);
      else onReveal?.(entry);
      close();
    };
    row.addEventListener('dblclick', () => activate(true));
    row.addEventListener('click', () => activate(false));
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        activate(event.key === 'Enter');
      }
    });
    return row;
  };

  const setBusy = (busy) => {
    runButton.disabled = busy;
    stopButton.hidden = !busy;
    panel.classList.toggle('is-busy', busy);
  };

  const run = async () => {
    controller?.abort();
    controller = new AbortController();
    const signal = controller.signal;

    clear(results);
    setBusy(true);
    status.textContent = t('search.running');
    status.className = 'fsfm-search-status';

    const options = {
      query: queryInput.value,
      mode: modeSelect.value,
      type: typeSelect.value,
      scope: contentBox.checked ? 'both' : 'name',
      extensions: extensionsInput.value,
      caseSensitive: caseBox.checked,
    };

    let answer;
    try {
      answer = await onSearch(options, signal);
    } catch (err) {
      if (signal.aborted) return;
      status.textContent = errorText(err) || t('search.failed');
      status.className = 'fsfm-search-status is-error';
      setBusy(false);
      return;
    }
    if (signal.aborted) return;
    setBusy(false);

    const found = answer.matches ?? [];
    if (found.length === 0) {
      status.textContent = t('search.nothing', { n: answer.scanned ?? 0 });
      return;
    }

    const notes = [
      t('search.found', { n: found.length }),
      t('search.scanned', { n: answer.scanned }),
    ];
    if (answer.elapsed !== undefined) notes.push(t('search.elapsed', { ms: answer.elapsed }));
    // Both of these mean "there may be more"; saying so is the difference
    // between a complete answer and one that looks complete.
    if (answer.truncated) notes.push(t('search.truncated'));
    if (answer.timedOut) notes.push(t('search.timedOut'));
    status.textContent = `${notes.join(', ')}.`;
    status.className = answer.truncated || answer.timedOut
      ? 'fsfm-search-status is-warning'
      : 'fsfm-search-status';

    const fragment = document.createDocumentFragment();
    for (const entry of found) fragment.append(rowFor(entry));
    results.append(fragment);
  };

  runButton.addEventListener('click', () => run());
  stopButton.addEventListener('click', () => {
    controller?.abort();
    setBusy(false);
    status.textContent = t('search.stopped');
  });
  closeButton.addEventListener('click', () => close());
  backdrop.addEventListener('mousedown', (event) => {
    if (event.target === backdrop) close();
  });

  queryInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      run();
    }
  });
  extensionsInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      run();
    }
  });

  function onKeyDown(event) {
    if (!backdrop.isConnected) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  }
  document.addEventListener('keydown', onKeyDown, true);

  attachIconFallbacks(results);
  container.append(backdrop);
  queryInput.focus();
  queryInput.select();
  // A dialog opened with something already typed is a dialog asked to search.
  if (initialQuery) run();

  return { close, run, get element() { return panel; } };
}
