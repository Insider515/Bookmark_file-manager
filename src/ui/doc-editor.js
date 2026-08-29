import { clear, el, trapFocus } from './dom.js';
import { registerOverlay } from './dialog.js';
import { icon } from './icons.js';

/**
 * The document editor.
 *
 * It has two faces, because the formats behind it genuinely differ in what can
 * honestly be offered. docx, odt and doc are edited as rich text: paragraphs,
 * headings, list items, and bold/italic/underline inside them. PDF is edited
 * by the page — deleted, reordered, rotated, split and merged — and its text
 * is shown but not editable, because a PDF page holds positioned glyphs rather
 * than sentences and "editing" one means re-flowing a line the file never
 * described. The pane says which of the two you are in rather than presenting
 * a text box that would silently do nothing useful.
 */

const BLOCK_LABELS = [
  { value: 'paragraph', labelKey: 'doc.blockParagraph' },
  { value: 'heading:1', labelKey: 'doc.blockHeading1' },
  { value: 'heading:2', labelKey: 'doc.blockHeading2' },
  { value: 'heading:3', labelKey: 'doc.blockHeading3' },
  { value: 'heading:4', labelKey: 'doc.blockHeading4' },
  { value: 'heading:5', labelKey: 'doc.blockHeading5' },
  { value: 'heading:6', labelKey: 'doc.blockHeading6' },
  { value: 'listItem', labelKey: 'doc.blockListItem' },
];

/** Turn a block's runs into editable markup. */
function runsToDom(host, runs) {
  clear(host);
  const list = runs?.length ? runs : [{ text: '' }];
  for (const run of list) {
    const pieces = String(run.text ?? '').split('\n');
    pieces.forEach((piece, index) => {
      if (index > 0) host.append(document.createElement('br'));
      if (piece === '') return;
      let node = document.createTextNode(piece);
      // Nested rather than combined, so the marks compose the same way the
      // browser's own bold/italic commands produce them.
      if (run.underline) node = wrap('u', node);
      if (run.italic) node = wrap('i', node);
      if (run.bold) node = wrap('b', node);
      host.append(node);
    });
  }
  if (!host.firstChild) host.append(document.createTextNode(''));
}

function wrap(tag, node) {
  const element = document.createElement(tag);
  element.append(node);
  return element;
}

const BOLD_TAGS = new Set(['B', 'STRONG']);
const ITALIC_TAGS = new Set(['I', 'EM']);

/**
 * Read the marks back off the markup.
 *
 * The browser's editing commands are free to express bold as a `<b>`, a
 * `<strong>` or a style attribute depending on version and history, so all
 * three are recognised rather than assuming one.
 */
function domToRuns(node, marks = {}) {
  const out = [];
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      if (child.data) out.push({ text: child.data, ...marks });
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;

    if (child.tagName === 'BR') {
      out.push({ text: '\n', ...marks });
      continue;
    }

    const next = { ...marks };
    if (BOLD_TAGS.has(child.tagName)) next.bold = true;
    if (ITALIC_TAGS.has(child.tagName)) next.italic = true;
    if (child.tagName === 'U') next.underline = true;

    const style = child.style;
    if (style) {
      const weight = style.fontWeight;
      if (weight === 'bold' || weight === 'bolder' || Number(weight) >= 600) next.bold = true;
      if (style.fontStyle === 'italic' || style.fontStyle === 'oblique') next.italic = true;
      if ((style.textDecoration || style.textDecorationLine || '').includes('underline')) {
        next.underline = true;
      }
    }

    if (child.tagName === 'DIV' || child.tagName === 'P') {
      // A block the browser inserted on Enter: it is a line break here,
      // because one row of this editor is one paragraph of the document.
      if (out.length > 0) out.push({ text: '\n', ...marks });
    }
    out.push(...domToRuns(child, next));
  }
  return out;
}

/** Merge adjacent runs with the same marks, as the server would. */
function tidy(runs) {
  const out = [];
  for (const run of runs) {
    if (!run.text) continue;
    const last = out[out.length - 1];
    if (
      last &&
      Boolean(last.bold) === Boolean(run.bold) &&
      Boolean(last.italic) === Boolean(run.italic) &&
      Boolean(last.underline) === Boolean(run.underline)
    ) {
      last.text += run.text;
    } else {
      out.push({ ...run });
    }
  }
  return out.length > 0 ? out : [{ text: '' }];
}

const sameRuns = (a = [], b = []) =>
  a.length === b.length &&
  a.every(
    (run, i) =>
      run.text === b[i].text &&
      Boolean(run.bold) === Boolean(b[i].bold) &&
      Boolean(run.italic) === Boolean(b[i].italic) &&
      Boolean(run.underline) === Boolean(b[i].underline)
  );

/**
 * @param {object} config
 * @param {HTMLElement} config.container
 * @param {object} config.entry
 * @param {object} config.document what the server returned
 * @param {object} [config.formats] the server's document capabilities
 * @param {boolean} [config.canSave]
 * @param {(document: object) => Promise<object>} [config.onSave]
 * @param {(plan: object[], options: object) => Promise<object>} [config.onPages]
 * @param {(path: string) => Promise<object>} [config.onRead] reads another document
 * @param {(message: string) => Promise<string|null>} [config.onAskPath]
 */
export function openDocumentEditor({
  container,
  entry,
  document: source,
  formats,
  canSave = true,
  onSave,
  onPages,
  onRead,
  onAskPath,
  t = (key) => key,
  errorText = (err) => err?.message ?? '',
}) {
  const isPdf = source.format === 'pdf';
  const spec = formats?.[source.format] ?? {};
  const label = spec.label ?? source.format ?? t('doc.word');
  const editable = canSave && (isPdf ? Boolean(spec.pages) : Boolean(spec.write));

  let dirty = false;

  // ---------------------------------------------------------------- chrome
  const title = el('h2.fsfm-doc-title', { text: entry.name });
  const status = el('span.fsfm-doc-status', { text: '' });
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

  const body = el('div.fsfm-doc-body');
  const toolbar = el('div.fsfm-doc-toolbar');
  const footActions = el('div.fsfm-doc-actions');

  const notice = el('p.fsfm-doc-notice');
  const panel = el(
    'div.fsfm-doc',
    { role: 'dialog', 'aria-modal': 'true', 'aria-label': t('doc.title') },
    [
      el('div.fsfm-doc-head', {}, [title, status, closeButton]),
      notice,
      toolbar,
      body,
      el('div.fsfm-doc-foot', {}, [footActions, el('div.fsfm-doc-actions', {}, editable ? [saveButton] : [])]),
    ]
  );
  const backdrop = el('div.fsfm-backdrop.fsfm-doc-backdrop', {}, [panel]);
  const releaseFocus = trapFocus(panel);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    unregister();
    document.removeEventListener('keydown', onKeyDown, true);
    releaseFocus();
    backdrop.remove();
  };
  const unregister = registerOverlay(container, () => close());

  const markDirty = (value = true) => {
    dirty = value;
    saveButton.disabled = !editable || !dirty;
    status.textContent = dirty ? t('common.unsaved') : '';
  };

  const setStatus = (text) => {
    status.textContent = text;
  };

  /* ------------------------------------------------------------ rich text */

  // A working copy: nothing the user does reaches the file until Save.
  const blocks = isPdf
    ? []
    : source.blocks.map((block) => ({
        ...block,
        runs: (block.runs ?? []).map((run) => ({ ...run })),
      }));

  const rowFor = (block, index) => {
    // Structure the editor cannot show — a table, a frame — is displayed as a
    // locked placeholder rather than hidden, so it is clear that something is
    // there and that saving will keep it.
    if (block.type === 'opaque' || block.readOnly) {
      return el('div.fsfm-doc-row.is-locked', { dataset: { index: String(index) } }, [
        el('span.fsfm-doc-kind', { text: t('doc.notEditable') }),
        el('div.fsfm-doc-opaque', {
          text: (block.runs ?? []).map((run) => run.text).join('') || t('doc.attachment'),
        }),
      ]);
    }

    const select = el('select.fsfm-doc-kind-select', { 'aria-label': t('doc.blockType') },
      BLOCK_LABELS.map((option) =>
        el('option', { value: option.value, text: t(option.labelKey) })
      ));
    select.value = block.type === 'heading' ? `heading:${block.level ?? 1}` : block.type;
    select.disabled = !editable;
    select.addEventListener('change', () => {
      const [kind, level] = select.value.split(':');
      block.type = kind;
      if (kind === 'heading') block.level = Number(level) || 1;
      else if (kind === 'listItem') block.level = block.level ?? 1;
      text.className = `fsfm-doc-text is-${kind}${kind === 'heading' ? ` is-h${block.level}` : ''}`;
      markDirty();
    });

    const text = el(
      // Dots, not spaces: el() hands these to classList, which rejects a token
      // containing whitespace.
      `div.fsfm-doc-text.is-${block.type}${block.type === 'heading' ? `.is-h${block.level ?? 1}` : ''}`,
      { contenteditable: editable ? 'true' : 'false', role: 'textbox', 'aria-multiline': 'true' }
    );
    runsToDom(text, block.runs);

    const sync = () => {
      const next = tidy(domToRuns(text));
      if (sameRuns(next, block.runs)) return;
      block.runs = next;
      markDirty();
    };
    text.addEventListener('input', sync);
    text.addEventListener('blur', sync);

    const remove = el('button.fsfm-doc-drop', {
      type: 'button',
      title: t('doc.deleteBlock'),
      'aria-label': t('doc.deleteBlock'),
      html: icon('trashFill', 14),
      disabled: !editable,
      on: {
        click: () => {
          blocks.splice(blocks.indexOf(block), 1);
          if (blocks.filter((item) => !item.hidden).length === 0) {
            blocks.push({ type: 'paragraph', runs: [{ text: '' }] });
          }
          markDirty();
          renderBlocks();
        },
      },
    });

    return el('div.fsfm-doc-row', { dataset: { index: String(index) } }, [select, text, remove]);
  };

  const renderBlocks = () => {
    clear(body);
    blocks.forEach((block, index) => {
      // Structural markers the reader left behind carry no text of their own.
      if (block.hidden) return;
      body.append(rowFor(block, index));
    });
  };

  /** Apply a mark to the selection inside whichever block has focus. */
  const applyMark = (command) => {
    const active = document.activeElement;
    if (!active?.classList?.contains('fsfm-doc-text')) return;
    document.execCommand(command, false, null);
    active.dispatchEvent(new Event('input'));
  };

  const markButton = (command, text, hint) =>
    el('button.fsfm-btn.fsfm-doc-mark', {
      type: 'button',
      text,
      title: hint,
      'aria-label': hint,
      // Pressing a toolbar button must not steal the selection it acts on.
      on: { mousedown: (event) => event.preventDefault(), click: () => applyMark(command) },
    });

  /* ------------------------------------------------------------------ pdf */

  const pages = isPdf
    ? source.pages.map((page) => ({ ...page, source: 0, dropped: false }))
    : [];
  const extraSources = [];
  let view = 'pages';

  const pageCard = (page, position) => {
    const move = (delta) => {
      const target = position + delta;
      if (target < 0 || target >= pages.length) return;
      const [item] = pages.splice(position, 1);
      pages.splice(target, 0, item);
      markDirty();
      renderPages();
    };

    const turned = page.rotation === 90 || page.rotation === 270;
    const thumb = el('div.fsfm-doc-page-thumb', {
      style: {
        // The real aspect ratio, so a landscape page looks like one without
        // rendering anything: the geometry is known from the page box.
        aspectRatio: `${turned ? page.height : page.width} / ${turned ? page.width : page.height}`,
      },
    }, [el('span.fsfm-doc-page-number', { text: String(position + 1) })]);

    const excerpt = (page.text ?? '').trim().split('\n').slice(0, 3).join(' ').slice(0, 90);

    return el('div.fsfm-doc-page', {}, [
      thumb,
      el('div.fsfm-doc-page-meta', {}, [
        el('span', { text: `${page.width}×${page.height} pt` }),
        page.rotation ? el('span.fsfm-doc-page-rotated', { text: `${page.rotation}°` }) : null,
        page.source > 0 ? el('span.fsfm-doc-page-foreign', { text: t('doc.pageFromOther') }) : null,
      ]),
      el('p.fsfm-doc-page-text', { text: excerpt || t('doc.pageNoLayer') }),
      editable
        ? el('div.fsfm-doc-page-actions', {}, [
            el('button.fsfm-btn', {
              type: 'button', title: t('doc.pageLeft'), 'aria-label': t('doc.pageLeft'),
              html: icon('caretRightFill', 12), class: 'fsfm-doc-flip',
              disabled: position === 0,
              on: { click: () => move(-1) },
            }),
            el('button.fsfm-btn', {
              type: 'button', title: t('doc.pageRight'), 'aria-label': t('doc.pageRight'),
              html: icon('caretRightFill', 12),
              disabled: position === pages.length - 1,
              on: { click: () => move(1) },
            }),
            el('button.fsfm-btn', {
              type: 'button', title: t('doc.pageRotate'), 'aria-label': t('doc.pageRotate'),
              html: icon('arrowClockwise', 12),
              on: {
                click: () => {
                  page.rotation = (page.rotation + 90) % 360;
                  markDirty();
                  renderPages();
                },
              },
            }),
            el('button.fsfm-btn.fsfm-btn-danger', {
              type: 'button', title: t('doc.pageDelete'), 'aria-label': t('doc.pageDelete'),
              html: icon('trashFill', 12),
              disabled: pages.length <= 1,
              on: {
                click: () => {
                  pages.splice(position, 1);
                  markDirty();
                  renderPages();
                },
              },
            }),
          ])
        : null,
    ]);
  };

  const renderPages = () => {
    clear(body);
    if (view === 'text') {
      body.className = 'fsfm-doc-body is-text';
      for (const [index, page] of pages.entries()) {
        body.append(
          el('section.fsfm-doc-pagetext', {}, [
            el('h3', { text: t('doc.pageLabel', { n: index + 1 }) }),
            el('pre', { text: page.text || t('doc.pageNoText') }),
          ])
        );
      }
      setStatus(t('count.pages', { n: pages.length }));
      return;
    }

    body.className = 'fsfm-doc-body is-pages';
    const grid = el('div.fsfm-doc-pages');
    pages.forEach((page, index) => grid.append(pageCard(page, index)));
    body.append(grid);
    setStatus(dirty ? t('common.unsaved') : t('count.pages', { n: pages.length }));
  };

  /* -------------------------------------------------------------- assembly */

  if (isPdf) {
    const layerNote =
      source.textLayer === 'none'
        ? t('doc.pdfNoLayer')
        : source.textLayer === 'partial'
          ? t('doc.pdfPartialLayer')
          : '';
    notice.textContent = t('doc.pdfNote', { format: label, layerNote });

    const tab = (id, text) =>
      el('button.fsfm-btn.fsfm-doc-tab', {
        type: 'button',
        text,
        dataset: { tab: id },
        'aria-pressed': String(view === id),
        on: {
          click: () => {
            view = id;
            // Matched on the id rather than the label: the label is translated,
            // and comparing display text would break in every language but one.
            for (const button of toolbar.querySelectorAll('.fsfm-doc-tab')) {
              button.setAttribute('aria-pressed', String(button.dataset.tab === id));
            }
            renderPages();
          },
        },
      });
    toolbar.append(tab('pages', t('doc.tabPages')), tab('text', t('doc.tabText')));

    if (editable) {
      footActions.append(
        el('button.fsfm-btn', {
          type: 'button',
          text: t('doc.appendPdf'),
          title: t('doc.appendPdfHint'),
          on: {
            click: async () => {
              if (!onAskPath || !onRead) return;
              const chosen = await onAskPath(t('doc.appendPdfLabel'));
              if (!chosen) return;
              try {
                setStatus(t('doc.reading'));
                const other = await onRead(chosen);
                const which = extraSources.length + 1;
                extraSources.push(chosen);
                for (const page of other.pages) {
                  pages.push({ ...page, source: which, dropped: false });
                }
                markDirty();
                renderPages();
              } catch (err) {
                setStatus(errorText(err) || t('doc.readFailed'));
              }
            },
          },
        }),
        el('button.fsfm-btn', {
          type: 'button',
          text: t('doc.saveAs'),
          title: t('doc.saveAsHint'),
          on: {
            click: async () => {
              if (!onAskPath) return;
              const chosen = await onAskPath(t('doc.saveAsLabel'), suggestName(entry.name, t));
              if (!chosen) return;
              await commitPages(chosen);
            },
          },
        })
      );
    }
    renderPages();
  } else {
    const preserves = spec.preserves !== false;
    notice.textContent =
      t('doc.richNote', { format: label }) +
      (preserves ? t('doc.richKeeps') : t('doc.richRebuilt'));

    if (editable) {
      toolbar.append(
        markButton('bold', t('doc.bold'), t('doc.boldTitle')),
        markButton('italic', t('doc.italic'), t('doc.italicTitle')),
        markButton('underline', t('doc.underline'), t('doc.underlineTitle')),
        el('span.fsfm-doc-sep'),
        el('button.fsfm-btn', {
          type: 'button',
          text: t('doc.blockBelow'),
          on: {
            click: () => {
              blocks.push({ type: 'paragraph', runs: [{ text: '' }] });
              markDirty();
              renderBlocks();
              body.lastElementChild?.querySelector('.fsfm-doc-text')?.focus();
            },
          },
        })
      );
    }
    renderBlocks();
    setStatus('');
  }

  /* ---------------------------------------------------------------- saving */

  const planFromPages = () =>
    pages.map((page) => ({ source: page.source, page: page.index, rotate: page.rotation }));

  async function commitPages(target) {
    if (!onPages) return;
    saveButton.disabled = true;
    setStatus(t('common.saving'));
    try {
      const result = await onPages(planFromPages(), { sources: extraSources, target });
      markDirty(false);
      setStatus(target ? t('doc.savedTo', { target }) : t('common.saved'));
      return result;
    } catch (err) {
      setStatus(errorText(err) || t('common.saveFailed'));
      saveButton.disabled = false;
      return null;
    }
  }

  saveButton.addEventListener('click', async () => {
    if (isPdf) {
      await commitPages(undefined);
      return;
    }
    saveButton.disabled = true;
    setStatus(t('common.saving'));
    try {
      const result = await onSave?.({ blocks });
      markDirty(false);
      const warnings = result?.warnings ?? [];
      setStatus(warnings.length > 0 ? warnings.join(' ') : t('common.saved'));
    } catch (err) {
      setStatus(errorText(err) || t('common.saveFailed'));
      saveButton.disabled = false;
    }
  });

  closeButton.addEventListener('click', () => close());
  backdrop.addEventListener('mousedown', (event) => {
    if (event.target === backdrop) close();
  });

  function onKeyDown(event) {
    if (!backdrop.isConnected) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      if (!saveButton.disabled) saveButton.click();
    }
  }
  document.addEventListener('keydown', onKeyDown, true);

  container.append(backdrop);
  (body.querySelector('.fsfm-doc-text') ?? closeButton).focus();

  return {
    close,
    get dirty() {
      return dirty;
    },
  };
}

/** A name for the file a split writes to, next to the one it came from. */
function suggestName(name, t) {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return t('doc.pagesSuffix', { stem });
}
