import { el } from './dom.js';
import { openDialog } from './dialog.js';
import { formatBytes } from '../core/format.js';

/**
 * The archive dialogs.
 *
 * Which formats appear is decided entirely by what the server said it can do
 * in /config — the widget keeps no list of its own. A machine without xz
 * installed simply does not offer xz, rather than offering it and failing.
 */

/** Extension -> format id, longest first, built from what the server sent. */
export function buildExtensionIndex(formats) {
  const pairs = [];
  for (const [id, spec] of Object.entries(formats ?? {})) {
    for (const extension of spec.extensions ?? []) pairs.push([extension.toLowerCase(), id]);
  }
  pairs.sort((a, b) => b[0].length - a[0].length);
  return pairs;
}

/** The format id a filename claims, or null. */
export function archiveFormatOf(name, index) {
  const lower = String(name).toLowerCase();
  for (const [extension, id] of index) {
    if (lower.endsWith(`.${extension}`)) return id;
  }
  return null;
}

/**
 * Choose a format and a name for a new archive.
 *
 * The name follows the format as long as the user has not typed over it: the
 * extension is part of what the format *is*, and leaving a `.zip` on a tar.xz
 * would be a small lie that some other tool would later trip on.
 *
 * @returns {Promise<{format: string, name: string}|null>}
 */
export function archiveDialog({ container, formats, selection, suggestedBase, t = (key) => key }) {
  const writable = Object.entries(formats ?? {}).filter(([, spec]) => spec.write);
  if (writable.length === 0) {
    return openDialog({
      container,
      t,
      title: t('archive.create'),
      body: el('p.fsfm-dialog-error.is-visible', {
        text: t('archive.unsupported'),
      }),
      confirmText: t('common.close'),
      cancelText: '',
    }).then(() => null);
  }

  const single = selection.length === 1 && !selection[0].isDirectory;
  // A bare compressor holds one file and no names; offering it for a folder or
  // a multiple selection would only produce an error on submit.
  const usable = writable.filter(([, spec]) => spec.kind !== 'filter' || single);

  const preferred = usable.find(([id]) => id === 'zip') ?? usable[0];
  let current = preferred[0];

  const nameInput = el('input.fsfm-input', {
    type: 'text',
    value: `${suggestedBase}.${formats[current].extensions[0]}`,
    spellcheck: false,
  });
  let nameTouched = false;
  nameInput.addEventListener('input', () => {
    nameTouched = true;
  });

  const syncName = () => {
    if (nameTouched) return;
    nameInput.value = `${suggestedBase}.${formats[current].extensions[0]}`;
  };

  const options = usable.map(([id, spec]) => {
    const input = el('input', {
      type: 'radio',
      name: 'fsfm-archive-format',
      value: id,
      checked: id === current,
    });
    input.addEventListener('change', () => {
      if (!input.checked) return;
      current = id;
      syncName();
    });
    return el('label.fsfm-format', {}, [
      input,
      el('span.fsfm-format-name', { text: spec.label }),
      el('span.fsfm-format-ext', { text: `.${spec.extensions[0]}` }),
    ]);
  });

  const hidden = writable.length - usable.length;

  const body = [
    el('div.fsfm-format-grid', { role: 'radiogroup', 'aria-label': t('archive.format') }, options),
    hidden > 0
      ? el('p.fsfm-dialog-hint', {
          text: t('archive.singleFileNote'),
        })
      : null,
    el('label.fsfm-field', {}, [
      el('span.fsfm-field-label', { text: t('archive.name') }),
      nameInput,
    ]),
  ].filter(Boolean);

  return openDialog({
    container,
    t,
    title:
      selection.length === 1
        ? t('archive.titleOne', { name: selection[0].name })
        : t('archive.titleMany', { n: t('count.items', { n: selection.length }) }),
    body,
    confirmText: t('common.create'),
    onConfirm: ({ showError }) => {
      const name = nameInput.value.trim();
      if (!name) {
        showError(t('archive.needName'));
        return null;
      }
      if (/[/\\:*?"<>|]/.test(name)) {
        showError(t('error.nameChars'));
        return null;
      }
      return { format: current, name };
    },
  });
}

/** Read-only listing of what an archive holds. */
export function archiveContentsDialog({ container, entry, contents, t = (key) => key }) {
  const rows = contents.items.map((item) =>
    el('div.fsfm-archive-row', {}, [
      el('span.fsfm-archive-kind', {
        text: item.isDirectory ? t('common.folder') : t('common.file'),
      }),
      el('span.fsfm-archive-name', { text: item.name, title: item.name }),
      el('span.fsfm-archive-size', {
        text: item.isDirectory || item.size === null ? '' : formatBytes(item.size, t),
      }),
    ])
  );

  const files = contents.items.filter((item) => !item.isDirectory).length;
  const total = contents.items.reduce((sum, item) => sum + (item.size ?? 0), 0);

  return openDialog({
    container,
    t,
    title: t('archive.contentsOf', { name: entry.name }),
    wide: true,
    body: [
      el('p.fsfm-dialog-hint', {
        text:
          t('archive.summary', {
            label: contents.label,
            files: t('count.files', { n: files }),
          }) +
          // Only worth saying when there is an unpacked size to report.
          (total > 0 ? t('archive.summarySize', { size: formatBytes(total, t) }) : ''),
      }),
      el('div.fsfm-archive-list', {}, rows.length
        ? rows
        : [el('div.fsfm-empty', { text: t('archive.empty') })]),
    ],
    confirmText: t('common.close'),
    cancelText: '',
  });
}
