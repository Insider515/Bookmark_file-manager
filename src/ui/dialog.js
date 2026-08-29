import { clear, el, trapFocus } from './dom.js';
import { icon } from './icons.js';
import { folderIconSvg } from './file-icon.js';

/**
 * Promise-returning modal dialogs.
 *
 * They render into the widget's own root rather than document.body so the
 * host's stacking contexts and scoped styles keep working, and so tearing the
 * widget down removes any open dialog with it.
 */

let openCount = 0;

/**
 * Every dialog currently on screen, grouped by the container it rendered into.
 *
 * A dialog owns a capture-phase listener on `document` and an unsettled
 * promise. Tearing the widget down removes the backdrop from the DOM, which
 * looks like a close but is not one: the listener stays bound to document and
 * the promise never settles, so an SPA that mounts and unmounts the manager
 * per route accumulates both. The registry is what lets destroy() close them
 * for real.
 *
 * @type {Map<HTMLElement, Set<() => void>>}
 */
const openDialogs = new Map();

/**
 * Join the registry from outside this module — the preview viewer is not a
 * dialog, but it is an overlay with the same lifetime problem.
 */
export function registerOverlay(container, close) {
  return registerDialog(container, close);
}

function registerDialog(container, close) {
  if (!openDialogs.has(container)) openDialogs.set(container, new Set());
  openDialogs.get(container).add(close);
  return () => {
    const set = openDialogs.get(container);
    if (!set) return;
    set.delete(close);
    if (set.size === 0) openDialogs.delete(container);
  };
}

/**
 * Cancel every dialog and overlay open inside `container`, releasing their
 * listeners and settling their promises. Called by FileManager.destroy().
 */
export function closeDialogs(container) {
  const set = openDialogs.get(container);
  if (!set) return;
  // Copy first: each close() removes itself from the set as it runs.
  for (const close of [...set]) close();
  openDialogs.delete(container);
}

/**
 * Base modal. Resolves with whatever `onConfirm` returns, or null on cancel.
 *
 * @param {object} config
 * @param {HTMLElement} config.container element to render into
 * @param {string} config.title
 * @param {Node|Node[]} config.body
 * @param {string} [config.confirmText]
 * @param {string} [config.cancelText]
 * @param {boolean} [config.danger] style the confirm button as destructive
 * @param {() => any} [config.onConfirm] return null to keep the dialog open
 * @param {(root: HTMLElement) => void} [config.onMount]
 */
export function openDialog(config) {
  const {
    container,
    title,
    body,
    // The defaults are resolved here rather than in the parameter list so a
    // caller can leave them out and still get the right language.
    t = (key) => key,
    errorText = (err) => err?.message ?? '',
    confirmText = t('common.ok'),
    cancelText = t('common.cancel'),
    danger = false,
    onConfirm,
    onMount,
    wide = false,
  } = config;

  return new Promise((resolve) => {
    let settled = false;
    const titleId = `fsfm-dialog-title-${(openCount += 1)}`;

    const confirmButton = el(
      'button.fsfm-btn',
      {
        type: 'button',
        class: danger ? 'fsfm-btn-danger' : 'fsfm-btn-primary',
        text: confirmText,
      }
    );
    // An empty cancelText means the dialog has nothing to cancel *to* — a
    // read-only sheet whose only action is "close". The button is still built,
    // because Escape and the backdrop route through the same handler, but it
    // is kept out of the DOM rather than rendered as a blank clickable box.
    const cancelButton = el('button.fsfm-btn', { type: 'button', text: cancelText || t('common.cancel') });
    const showCancel = Boolean(cancelText);
    const errorLine = el('div.fsfm-dialog-error', { role: 'alert' });

    const panel = el(
      'div.fsfm-dialog',
      {
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': titleId,
        class: wide ? 'fsfm-dialog-wide' : '',
      },
      [
        el('div.fsfm-dialog-head', {}, [
          el('h2.fsfm-dialog-title', { id: titleId, text: title }),
          el('button.fsfm-dialog-close', {
            type: 'button',
            'aria-label': t('common.close'),
            html: icon('xLg', 14),
            on: { click: () => finish(null) },
          }),
        ]),
        el('div.fsfm-dialog-body', {}, Array.isArray(body) ? body : [body]),
        errorLine,
        el('div.fsfm-dialog-foot', {}, [showCancel ? cancelButton : null, confirmButton].filter(Boolean)),
      ]
    );

    const backdrop = el('div.fsfm-backdrop', {}, [panel]);

    const releaseFocus = trapFocus(panel);

    let unregister = () => {};

    function finish(value) {
      if (settled) return;
      settled = true;
      unregister();
      releaseFocus();
      backdrop.remove();
      document.removeEventListener('keydown', onKeyDown, true);
      resolve(value);
    }

    function showError(message) {
      errorLine.textContent = message;
      errorLine.classList.toggle('is-visible', !!message);
    }

    async function attemptConfirm() {
      showError('');
      if (!onConfirm) return finish(true);
      try {
        confirmButton.disabled = true;
        const result = await onConfirm({ showError });
        // Returning null means the handler rejected the input and has already
        // explained why; keep the dialog up.
        if (result === null || result === undefined) return;
        finish(result);
      } catch (err) {
        showError(errorText(err) || t('dialog.failed'));
      } finally {
        confirmButton.disabled = false;
      }
    }

    function onKeyDown(event) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        finish(null);
      } else if (event.key === 'Enter' && !event.shiftKey) {
        const target = event.target;
        // Enter inside a textarea or on the cancel button means what it says.
        if (target instanceof HTMLTextAreaElement) return;
        if (target === cancelButton) return;
        if (panel.contains(target)) {
          event.preventDefault();
          attemptConfirm();
        }
      }
    }

    confirmButton.addEventListener('click', attemptConfirm);
    cancelButton.addEventListener('click', () => finish(null));
    backdrop.addEventListener('mousedown', (event) => {
      if (event.target === backdrop) finish(null);
    });
    document.addEventListener('keydown', onKeyDown, true);

    unregister = registerDialog(container, () => finish(null));
    container.append(backdrop);
    onMount?.(panel);

    // Focus the first field, or the confirm button when there is none.
    const firstField = panel.querySelector('input, textarea, select');
    (firstField instanceof HTMLElement ? firstField : confirmButton).focus();
    if (firstField instanceof HTMLInputElement && firstField.value) {
      // Select the stem only, so typing replaces the name but keeps ".txt".
      const dot = firstField.value.lastIndexOf('.');
      if (dot > 0) firstField.setSelectionRange(0, dot);
      else firstField.select();
    }
  });
}

/** Text prompt. Resolves to the trimmed string, or null if cancelled. */
export function promptDialog({
  container,
  title,
  label,
  value = '',
  placeholder = '',
  t = (key) => key,
  confirmText = t('common.create'),
  hint = '',
  validate,
}) {
  const input = el('input.fsfm-input', { type: 'text', value, placeholder, spellcheck: false });
  const body = [
    el('label.fsfm-field', {}, [el('span.fsfm-field-label', { text: label }), input]),
    hint ? el('p.fsfm-dialog-hint', { text: hint }) : null,
  ].filter(Boolean);

  return openDialog({
    container,
    title,
    body,
    t,
    confirmText,
    onConfirm: ({ showError }) => {
      const trimmed = input.value.trim();
      if (!trimmed) {
        showError(t('dialog.namePlaceholder'));
        input.focus();
        return null;
      }
      const problem = validate?.(trimmed);
      if (problem) {
        showError(problem);
        input.focus();
        return null;
      }
      return trimmed;
    },
  });
}

/** Confirmation. Resolves true or null. */
export function confirmDialog({
  container,
  title,
  message,
  detail = [],
  t = (key) => key,
  confirmText = t('common.delete'),
  danger = true,
}) {
  const body = [el('p.fsfm-dialog-text', { text: message })];
  if (detail.length) {
    body.push(
      el(
        'ul.fsfm-dialog-list',
        {},
        detail.slice(0, 10).map((line) => el('li', { text: line }))
      )
    );
    if (detail.length > 10) {
      body.push(el('p.fsfm-dialog-hint', { text: t('dialog.andMore', { n: detail.length - 10 }) }));
    }
  }
  return openDialog({ container, title, body, confirmText, danger });
}

/**
 * Folder chooser for move/copy. Lazily loads children as branches open, so it
 * stays responsive on a deep tree.
 *
 * @param {object} config
 * @param {HTMLElement} config.container
 * @param {import('../core/http-provider.js').HttpProvider} config.provider
 * @param {string} config.title
 * @param {string} [config.currentPath] highlighted on open
 * @param {string[]} [config.disabledPaths] subtrees that cannot be chosen
 *   (a folder cannot be moved into itself)
 * @param {string} config.rootLabel
 */
export function folderPickerDialog({
  container,
  provider,
  title,
  t = (key) => key,
  errorText = (err) => err?.message ?? '',
  confirmText = t('action.move'),
  currentPath = '/',
  disabledPaths = [],
  rootLabel = 'Files',
}) {
  let selected = '/';
  const listHost = el('div.fsfm-picker', { role: 'tree', tabindex: '0' });
  const selectionLine = el('p.fsfm-picker-selection');

  const isDisabled = (candidate) =>
    disabledPaths.some((blocked) => candidate === blocked || candidate.startsWith(`${blocked}/`));

  function setSelected(pathValue, rowNode) {
    selected = pathValue;
    listHost.querySelectorAll('.fsfm-picker-row.is-selected').forEach((node) =>
      node.classList.remove('is-selected')
    );
    rowNode?.classList.add('is-selected');
    selectionLine.textContent = t('dialog.destination', {
      path: pathValue === '/' ? rootLabel : pathValue,
    });
  }

  async function renderBranch(node, depth, parentNode) {
    const blocked = isDisabled(node.path);
    const hasChildren = node.hasChildren;

    const twisty = el('button.fsfm-picker-twisty', {
      type: 'button',
      tabindex: '-1',
      'aria-label': t('dialog.expand'),
      html: hasChildren ? icon('caretRightFill', 10) : '',
      disabled: !hasChildren,
    });

    const row = el(
      'div.fsfm-picker-row',
      {
        role: 'treeitem',
        class: blocked ? 'is-blocked' : '',
        style: { paddingLeft: `${depth * 16 + 4}px` },
        title: blocked ? t('dialog.cannotSelectSelf') : node.path,
      },
      [
        twisty,
        el('span.fsfm-picker-icon', { html: folderIconSvg({ size: 16 }) }),
        el('span.fsfm-picker-name', { text: node.path === '/' ? rootLabel : node.name }),
      ]
    );

    const childHost = el('div.fsfm-picker-children', { hidden: true });
    let loaded = false;
    let expanded = false;

    async function toggle() {
      if (!hasChildren) return;
      expanded = !expanded;
      twisty.innerHTML = icon(expanded ? 'caretDownFill' : 'caretRightFill', 10);
      childHost.hidden = !expanded;
      if (expanded && !loaded) {
        loaded = true;
        twisty.classList.add('is-busy');
        try {
          const subtree = await provider.tree(node.path, 1);
          for (const child of subtree.children ?? []) {
            await renderBranch(child, depth + 1, childHost);
          }
        } catch (err) {
          childHost.append(el('div.fsfm-picker-error', { text: errorText(err) }));
        } finally {
          twisty.classList.remove('is-busy');
        }
      }
    }

    twisty.addEventListener('click', (event) => {
      event.stopPropagation();
      toggle();
    });
    row.addEventListener('click', () => {
      if (blocked) return;
      setSelected(node.path, row);
    });
    row.addEventListener('dblclick', () => toggle());

    parentNode.append(row, childHost);

    // The root always opens: a picker showing a single collapsed row would
    // make the user expand it before they could choose anything. Below the
    // root, open only the branch leading to the current directory.
    if (node.path === '/' || (currentPath !== '/' && currentPath.startsWith(`${node.path}/`))) {
      await toggle();
    }
    if (node.path === currentPath && !blocked) setSelected(node.path, row);
  }

  const body = [
    el('p.fsfm-dialog-hint', { text: t('dialog.pickFolder') }),
    listHost,
    selectionLine,
  ];

  const dialog = openDialog({
    container,
    title,
    body,
    t,
    errorText,
    confirmText,
    wide: true,
    onConfirm: ({ showError }) => {
      if (isDisabled(selected)) {
        showError(t('dialog.folderUnavailable'));
        return null;
      }
      return selected;
    },
  });

  // Populate after the dialog is on screen; failures surface inside it.
  (async () => {
    try {
      const root = await provider.tree('/', 1);
      clear(listHost);
      await renderBranch({ ...root, path: '/', name: rootLabel }, 0, listHost);
      if (!listHost.querySelector('.is-selected')) {
        setSelected('/', listHost.querySelector('.fsfm-picker-row'));
      }
    } catch (err) {
      clear(listHost).append(el('div.fsfm-picker-error', { text: errorText(err) }));
    }
  })();

  return dialog;
}

/**
 * Non-dismissable progress modal for uploads.
 * @returns {{setProgress: (fraction: number, note?: string) => void, close: () => void}}
 */
export function progressDialog({ container, title, onCancel, t = (key) => key }) {
  const bar = el('div.fsfm-progress-bar');
  const note = el('p.fsfm-dialog-hint', { text: t('dialog.preparing') });
  const cancelButton = el('button.fsfm-btn', { type: 'button', text: t('common.cancel') });

  const panel = el('div.fsfm-dialog', { role: 'dialog', 'aria-modal': 'true' }, [
    el('div.fsfm-dialog-head', {}, [el('h2.fsfm-dialog-title', { text: title })]),
    el('div.fsfm-dialog-body', {}, [
      el('div.fsfm-progress', { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' }, [bar]),
      note,
    ]),
    el('div.fsfm-dialog-foot', {}, [cancelButton]),
  ]);
  const backdrop = el('div.fsfm-backdrop', {}, [panel]);
  const releaseFocus = trapFocus(panel);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    unregister();
    releaseFocus();
    backdrop.remove();
  };
  // Destroying the widget mid-upload cancels the upload rather than leaving an
  // orphaned modal and a request nobody is waiting for.
  const unregister = registerDialog(container, () => {
    close();
    onCancel?.();
  });

  cancelButton.addEventListener('click', () => onCancel?.());
  container.append(backdrop);
  cancelButton.focus();

  return {
    setProgress(fraction, text) {
      const percent = Math.max(0, Math.min(100, Math.round(fraction * 100)));
      bar.style.width = `${percent}%`;
      panel.querySelector('.fsfm-progress')?.setAttribute('aria-valuenow', String(percent));
      if (text) note.textContent = text;
    },
    close,
  };
}
