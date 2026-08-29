import { el, clear } from './dom.js';
import { openDialog } from './dialog.js';
import { formatBytes, formatDate } from '../core/format.js';
import {
  MODE_BITS,
  MODE_CLASSES,
  formatModeText,
  formatOctalMode,
  hasBit,
  parseOctalMode,
  setBit,
} from '../core/mode.js';

/**
 * One label/value row in the properties table. `value` may be a string or a
 * node — el() takes attributes second and children third, so the two cases
 * cannot share a call.
 */
function row(label, value) {
  const cell =
    value instanceof Node
      ? el('span.fsfm-props-value', {}, [value])
      : el('span.fsfm-props-value', { text: value ?? '—' });
  return el('div.fsfm-props-row', {}, [el('span.fsfm-props-label', { text: label }), cell]);
}

/** Both dialogs show the same rwx grid, so it is built once. */
function modeGrid(mode, { editable, onChange, t = (key) => key }) {
  const inputs = [];
  const cells = [
    el('span.fsfm-mode-corner'),
    ...MODE_BITS.map((bit) => el('span.fsfm-mode-head', { text: t(bit.labelKey) })),
  ];

  for (const modeClass of MODE_CLASSES) {
    cells.push(el('span.fsfm-mode-class', { text: t(modeClass.labelKey) }));
    for (const bit of MODE_BITS) {
      const input = el('input', {
        type: 'checkbox',
        checked: hasBit(mode, modeClass.shift, bit.value),
        disabled: !editable,
        'aria-label': `${t(modeClass.labelKey)}: ${t(bit.labelKey)}`,
      });
      input.dataset.shift = String(modeClass.shift);
      input.dataset.value = String(bit.value);
      if (editable) input.addEventListener('change', () => onChange?.());
      inputs.push(input);
      cells.push(el('span.fsfm-mode-cell', {}, [input]));
    }
  }

  const grid = el('div.fsfm-mode-grid', { role: 'group', 'aria-label': t('props.permissions') }, cells);

  return {
    element: grid,
    /** Read the grid back into a mode. */
    read() {
      let result = 0;
      for (const input of inputs) {
        if (input.checked) {
          result = setBit(result, Number(input.dataset.shift), Number(input.dataset.value), true);
        }
      }
      return result;
    },
    /** Push a mode into the grid, for when the octal field is edited instead. */
    write(next) {
      for (const input of inputs) {
        input.checked = hasBit(next, Number(input.dataset.shift), Number(input.dataset.value));
      }
    },
  };
}

/**
 * Read-only properties for one entry.
 *
 * The directory size is left blank with a button beside it rather than
 * computed up front: a folder can hold enough files that adding them up is a
 * request in its own right, and most of the time nobody wants the number.
 *
 * @param {object} config
 * @param {HTMLElement} config.container
 * @param {object} config.provider needs properties()
 * @param {object} config.entry
 * @param {() => void} [config.onEditMode] opens the permissions dialog
 */
export async function propertiesDialog({
  container,
  provider,
  entry,
  onEditMode,
  t = (key) => key,
  localeTag = undefined,
  errorText = (err) => err?.message ?? '',
}) {
  let details;
  try {
    details = await provider.properties(entry.path);
  } catch (err) {
    return openDialog({
      container,
      t,
      title: t('props.title'),
      body: el('p.fsfm-dialog-error.is-visible', {
        text: errorText(err) || t('props.failed'),
      }),
      confirmText: t('common.close'),
      cancelText: '',
    });
  }

  const sizeValue = el('span', {
    text: details.isDirectory ? '' : formatBytes(details.size, t),
  });

  if (details.isDirectory) {
    const button = el('button.fsfm-link-button', { type: 'button', text: t('props.calculate') });
    button.addEventListener('click', async () => {
      button.disabled = true;
      button.textContent = t('props.calculating');
      try {
        const walked = await provider.properties(entry.path, { computeSize: true });
        clear(sizeValue).append(
          document.createTextNode(
            formatBytes(walked.totalSize, t) +
              (walked.totalSizePartial ? t('props.orMore') : '')
          )
        );
      } catch (err) {
        clear(sizeValue).append(document.createTextNode(errorText(err) || t('props.calcFailed')));
      }
    });
    sizeValue.append(button);
  }

  const modeValue = el('span.fsfm-props-mode', {
    text: `${details.modeText}  (${details.modeOctal})`,
  });

  const body = [
    el('div.fsfm-props', {}, [
      row(t('common.name'), details.name),
      row(t('common.type'), details.isDirectory ? t('common.folderCap') : describeType(details, t)),
      row(t('props.location'), details.path),
      row(details.isDirectory ? t('props.contentSize') : t('common.size'), sizeValue),
      details.isDirectory ? row(t('props.items'), String(details.itemCount ?? '—')) : null,
      !details.isDirectory && details.blocks
        ? row(t('props.onDisk'), formatBytes(details.blocks, t))
        : null,
      details.isSymbolicLink
        ? row(t('props.linkTo'), details.linkTarget ?? t('props.outsideRoot'))
        : null,
      row(t('props.created'), formatDate(details.created, localeTag)),
      row(t('common.modified'), formatDate(details.modified, localeTag)),
      row(t('props.accessed'), formatDate(details.accessed, localeTag)),
      details.links > 1 ? row(t('props.hardLinks'), String(details.links)) : null,
      row(t('props.permissions'), modeValue),
      row(t('common.owner'), details.owner ? `${details.owner} (${details.uid})` : `uid ${details.uid}`),
      row(t('common.group'), `gid ${details.gid}`),
    ].filter(Boolean)),
    modeGrid(details.mode, { editable: false, t }).element,
  ];

  return openDialog({
    container,
    t,
    title: t('props.titleOf', { name: details.name }),
    body,
    confirmText: details.modeEditable ? t('props.change') : t('common.close'),
    cancelText: details.modeEditable ? t('common.close') : '',
    onConfirm: () => {
      if (!details.modeEditable) return true;
      // Returning a value closes this dialog; the caller opens the next one.
      onEditMode?.(details);
      return true;
    },
  });
}

function describeType(details, t) {
  const dot = details.name.lastIndexOf('.');
  const extension = dot > 0 ? details.name.slice(dot + 1).toUpperCase() : '';
  const kind = extension ? t('props.kindExt', { ext: extension }) : t('common.fileCap');
  return details.executable ? t('props.kindExecutable', { kind }) : kind;
}

/**
 * Edit permission bits.
 *
 * The checkbox grid and the octal field are two views of one value and stay in
 * step: whichever the user touches, the other follows. People who know what
 * "644" means type it; people who do not, tick boxes.
 *
 * @returns {Promise<{mode: string, recursive: boolean}|null>} null on cancel
 */
export function permissionsDialog({ container, details, t = (key) => key }) {
  let mode = details.mode;

  const octal = el('input.fsfm-input.fsfm-mode-octal', {
    type: 'text',
    value: formatOctalMode(mode),
    inputmode: 'numeric',
    spellcheck: false,
    'aria-label': t('props.octalTitle'),
  });
  const preview = el('code.fsfm-mode-preview', { text: formatModeText(mode) });

  const grid = modeGrid(mode, {
    editable: true,
    t,
    onChange: () => {
      mode = grid.read();
      octal.value = formatOctalMode(mode);
      preview.textContent = formatModeText(mode);
      octal.setCustomValidity('');
    },
  });

  octal.addEventListener('input', () => {
    const parsed = parseOctalMode(octal.value);
    if (parsed === null) return; // half-typed; leave the grid alone
    mode = parsed;
    grid.write(mode);
    preview.textContent = formatModeText(mode);
  });

  const recursive = el('input', { type: 'checkbox' });
  const recursiveField = details.isDirectory
    ? el('label.fsfm-check', {}, [
        recursive,
        el('span', { text: t('props.recursive') }),
      ])
    : null;

  const presets = el('div.fsfm-mode-presets', {}, [
    el('span.fsfm-props-label', { text: t('props.presets') }),
    ...[
      ['644', t('props.preset644')],
      ['755', t('props.preset755')],
      ['600', t('props.preset600')],
      ['700', t('props.preset700')],
    ].map(([value, title]) =>
      el('button.fsfm-chip', {
        type: 'button',
        title,
        text: value,
        on: {
          click: () => {
            mode = parseOctalMode(value);
            grid.write(mode);
            octal.value = value;
            preview.textContent = formatModeText(mode);
          },
        },
      })
    ),
  ]);

  const body = [
    grid.element,
    el('div.fsfm-mode-summary', {}, [
      el('label.fsfm-field', {}, [
        el('span.fsfm-field-label', { text: t('props.octalValue') }),
        octal,
      ]),
      preview,
    ]),
    presets,
    recursiveField,
    el('p.fsfm-dialog-hint', {
      text: t('props.specialBits'),
    }),
  ].filter(Boolean);

  return openDialog({
    container,
    t,
    title: t('props.permTitleOf', { name: details.name }),
    body,
    confirmText: t('common.apply'),
    onConfirm: ({ showError }) => {
      const parsed = parseOctalMode(octal.value);
      if (parsed === null) {
        showError(t('props.octalInvalid'));
        return null;
      }
      return { mode: formatOctalMode(parsed), recursive: recursive.checked };
    },
  });
}
