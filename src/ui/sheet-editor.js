import { clear, el, trapFocus } from './dom.js';
import { icon } from './icons.js';
import { registerOverlay } from './dialog.js';
import { formatBytes } from '../core/format.js';

/**
 * A spreadsheet viewer and editor over the widget.
 *
 * Deliberately a grid of values and nothing more. It does not evaluate
 * formulas, keep formatting, or pretend to be Excel — and the header says so,
 * because the one thing worse than a limited editor is one that silently drops
 * what it could not represent when the user presses Save.
 */

/** Rows built per batch; the rest follow as the grid is scrolled. */
const ROW_CHUNK = 60;

/** Spare rows and columns beyond the used range, so there is room to type. */
const SPARE_ROWS = 8;
const SPARE_COLUMNS = 2;

/** A1-style column name from a zero-based index. */
export function columnName(index) {
  let name = '';
  let n = index;
  do {
    name = String.fromCharCode(65 + (n % 26)) + name;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return name;
}

/** What a cell shows. Mirrors cellText on the server. */
function displayText(cell) {
  if (!cell || cell.type === 'empty' || cell.value === null) return '';
  if (cell.formula) return `=${cell.formula}`;
  if (cell.type === 'boolean') return cell.value ? 'TRUE' : 'FALSE';
  if (cell.type === 'date') {
    const date = new Date(cell.value);
    if (!Number.isNaN(date.getTime())) {
      // The stored value is an instant; what belongs in a cell is the date as
      // written, so it is rendered in UTC rather than the viewer's zone.
      return date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '').replace(/ 00:00:00$/, '');
    }
  }
  return String(cell.value);
}

/**
 * Open the editor.
 *
 * @param {object} config
 * @param {HTMLElement} config.container
 * @param {object} config.entry the file being edited
 * @param {object} config.workbook as the server sent it
 * @param {object} config.formats /config.sheetFormats
 * @param {boolean} [config.canSave]
 * @param {(workbook: object) => Promise<object>} config.onSave
 * @returns {{close: () => void}}
 */
export function openSheetEditor({
  container,
  entry,
  workbook,
  formats,
  canSave = true,
  onSave,
  t = (key) => key,
  errorText = (err) => err?.message ?? '',
}) {
  // A working copy: nothing the user does touches what the server sent until
  // Save succeeds, so closing without saving really does change nothing.
  const sheets = workbook.sheets.map((sheet) => ({
    name: sheet.name,
    rows: sheet.rows.map((row) => row.map((cell) => ({ ...cell }))),
  }));
  if (sheets.length === 0) sheets.push({ name: 'Sheet1', rows: [] });

  let active = 0;
  let dirty = false;
  let selected = { row: 0, column: 0 };
  let rendered = 0;

  const format = workbook.meta?.format;
  const formatLabel = formats?.[format]?.label ?? format ?? t('sheet.word');

  // ---------------------------------------------------------------- chrome
  const title = el('h2.fsfm-sheet-title', { text: entry.name });
  const status = el('span.fsfm-sheet-status', { text: '' });
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

  const tabsHost = el('div.fsfm-sheet-tabs', { role: 'tablist' });
  const grid = el('div.fsfm-sheet-grid', { tabindex: '0', role: 'grid' });
  const notice = el('p.fsfm-sheet-notice', {
    text: t('sheet.note', { format: formatLabel }),
  });

  const addRowButton = el('button.fsfm-btn', { type: 'button', text: t('sheet.row') });
  const addColumnButton = el('button.fsfm-btn', { type: 'button', text: t('sheet.column') });

  const panel = el('div.fsfm-sheet', { role: 'dialog', 'aria-modal': 'true', 'aria-label': t('sheet.title') }, [
    el('div.fsfm-sheet-head', {}, [title, status, closeButton]),
    notice,
    tabsHost,
    grid,
    el('div.fsfm-sheet-foot', {}, [
      el('div.fsfm-sheet-actions', {}, canSave ? [addRowButton, addColumnButton] : []),
      el('div.fsfm-sheet-actions', {}, canSave ? [saveButton] : []),
    ]),
  ]);

  const backdrop = el('div.fsfm-backdrop.fsfm-sheet-backdrop', {}, [panel]);
  const releaseFocus = trapFocus(panel);

  // The one input the whole grid shares, moved into whichever cell is being
  // edited. One element rather than thousands of them.
  const editor = el('input.fsfm-sheet-input', { type: 'text', hidden: true });
  let editing = null;

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

  // ------------------------------------------------------------- the model
  const sheet = () => sheets[active];

  const cellAt = (row, column) => sheet().rows[row]?.[column] ?? null;

  const setCell = (row, column, text) => {
    const rows = sheet().rows;
    while (rows.length <= row) rows.push([]);
    const target = rows[row];
    while (target.length <= column) target.push({ type: 'empty', value: null });
    // The type is settled by the server, which owns that decision for every
    // format; the client only ever reports what was typed.
    target[column] = { type: 'string', value: text, text };
    dirty = true;
    saveButton.disabled = false;
    status.textContent = t('common.unsaved');
  };

  const usedSize = () => {
    const rows = sheet().rows;
    let columns = 0;
    for (const row of rows) if (row.length > columns) columns = row.length;
    return { rows: rows.length, columns };
  };

  let extraRows = SPARE_ROWS;
  let extraColumns = SPARE_COLUMNS;

  const gridSize = () => {
    const used = usedSize();
    return {
      rows: Math.max(1, used.rows + extraRows),
      columns: Math.max(1, used.columns + extraColumns),
    };
  };

  // ------------------------------------------------------------ rendering
  let body = null;

  const renderTabs = () => {
    clear(tabsHost);
    sheets.forEach((item, index) => {
      const tab = el('button.fsfm-sheet-tab', {
        type: 'button',
        role: 'tab',
        class: index === active ? 'is-active' : '',
        'aria-selected': index === active ? 'true' : 'false',
        text: item.name,
        title: t('sheet.tabRows', {
          name: item.name,
          n: t('count.rows', { n: item.rows.length }),
        }),
        on: {
          click: () => {
            if (index === active) return;
            commitEdit();
            active = index;
            extraRows = SPARE_ROWS;
            extraColumns = SPARE_COLUMNS;
            selected = { row: 0, column: 0 };
            renderTabs();
            renderGrid();
          },
        },
      });
      tabsHost.append(tab);
    });
  };

  const renderGrid = () => {
    clear(grid);
    rendered = 0;
    const { columns } = gridSize();

    const header = el('div.fsfm-sheet-row.fsfm-sheet-header', { role: 'row' });
    header.append(el('span.fsfm-sheet-corner'));
    for (let c = 0; c < columns; c += 1) {
      header.append(el('span.fsfm-sheet-colhead', { text: columnName(c) }));
    }
    grid.append(header);

    body = el('div.fsfm-sheet-body');
    grid.append(body);
    grid.style.setProperty('--fsfm-sheet-columns', String(columns));
    renderChunk();
    highlight();
  };

  const renderChunk = () => {
    const { rows, columns } = gridSize();
    if (!body || rendered >= rows) return;
    const upTo = Math.min(rendered + ROW_CHUNK, rows);
    const fragment = document.createDocumentFragment();

    for (let r = rendered; r < upTo; r += 1) {
      const line = el('div.fsfm-sheet-row', { role: 'row', dataset: { row: String(r) } });
      line.append(el('span.fsfm-sheet-rowhead', { text: String(r + 1) }));
      for (let c = 0; c < columns; c += 1) {
        const cell = cellAt(r, c);
        line.append(
          el('span.fsfm-sheet-cell', {
            role: 'gridcell',
            class: cell && cell.type === 'number' ? 'is-number' : '',
            dataset: { row: String(r), column: String(c) },
            text: displayText(cell),
          })
        );
      }
      fragment.append(line);
    }
    body.append(fragment);
    rendered = upTo;

    if (needsMore()) renderChunk();
  };

  const needsMore = () => {
    const { rows } = gridSize();
    if (rendered >= rows) return false;
    return grid.scrollHeight - grid.scrollTop - grid.clientHeight < 400;
  };

  const cellElement = (row, column) =>
    body?.querySelector(`.fsfm-sheet-cell[data-row="${row}"][data-column="${column}"]`) ?? null;

  const highlight = () => {
    for (const node of grid.querySelectorAll('.fsfm-sheet-cell.is-selected')) {
      node.classList.remove('is-selected');
    }
    const node = cellElement(selected.row, selected.column);
    if (node) {
      node.classList.add('is-selected');
      node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    const cell = cellAt(selected.row, selected.column);
    const reference = `${columnName(selected.column)}${selected.row + 1}`;
    if (!dirty) {
      status.textContent = cell?.formula ? `${reference}  =${cell.formula}` : reference;
    }
  };

  // -------------------------------------------------------------- editing
  const startEdit = (initial) => {
    if (!canSave) return;
    const node = cellElement(selected.row, selected.column);
    if (!node) return;
    editing = { ...selected };
    editor.value = initial ?? displayText(cellAt(selected.row, selected.column));
    editor.hidden = false;
    node.append(editor);
    node.classList.add('is-editing');
    editor.focus();
    if (initial === undefined) editor.select();
    else editor.setSelectionRange(editor.value.length, editor.value.length);
  };

  const commitEdit = () => {
    if (!editing) return;
    const node = cellElement(editing.row, editing.column);
    const value = editor.value;
    const previous = displayText(cellAt(editing.row, editing.column));
    if (value !== previous) {
      setCell(editing.row, editing.column, value);
      if (node) node.textContent = value;
    }
    if (node) node.classList.remove('is-editing');
    editor.hidden = true;
    editor.remove();
    editing = null;
    grid.focus();
  };

  const cancelEdit = () => {
    if (!editing) return;
    const node = cellElement(editing.row, editing.column);
    if (node) node.classList.remove('is-editing');
    editor.hidden = true;
    editor.remove();
    editing = null;
    grid.focus();
  };

  const move = (rowDelta, columnDelta) => {
    const { rows, columns } = gridSize();
    selected = {
      row: Math.max(0, Math.min(rows - 1, selected.row + rowDelta)),
      column: Math.max(0, Math.min(columns - 1, selected.column + columnDelta)),
    };
    // Rows below the built ones have to exist before they can be selected.
    while (selected.row >= rendered && rendered < rows) renderChunk();
    highlight();
  };

  // --------------------------------------------------------------- events
  grid.addEventListener('scroll', () => {
    if (needsMore()) renderChunk();
  }, { passive: true });

  grid.addEventListener('click', (event) => {
    const node = event.target.closest?.('.fsfm-sheet-cell');
    if (!node) return;
    commitEdit();
    selected = { row: Number(node.dataset.row), column: Number(node.dataset.column) };
    highlight();
  });

  grid.addEventListener('dblclick', (event) => {
    if (!event.target.closest?.('.fsfm-sheet-cell')) return;
    startEdit();
  });

  editor.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitEdit();
      move(1, 0);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancelEdit();
    } else if (event.key === 'Tab') {
      event.preventDefault();
      commitEdit();
      move(0, event.shiftKey ? -1 : 1);
    }
  });
  editor.addEventListener('blur', () => commitEdit());

  function onKeyDown(event) {
    if (!document.contains(backdrop)) return;
    if (editing) return; // the editor's own handler owns these

    if (event.key === 'Escape') {
      event.stopPropagation();
      attemptClose();
      return;
    }
    if (!grid.contains(document.activeElement) && document.activeElement !== grid) return;

    switch (event.key) {
      case 'ArrowUp': event.preventDefault(); move(-1, 0); break;
      case 'ArrowDown': event.preventDefault(); move(1, 0); break;
      case 'ArrowLeft': event.preventDefault(); move(0, -1); break;
      case 'ArrowRight': event.preventDefault(); move(0, 1); break;
      case 'Tab': event.preventDefault(); move(0, event.shiftKey ? -1 : 1); break;
      case 'Enter': event.preventDefault(); startEdit(); break;
      case 'F2': event.preventDefault(); startEdit(); break;
      case 'Delete':
      case 'Backspace':
        if (!canSave) break;
        event.preventDefault();
        setCell(selected.row, selected.column, '');
        {
          const node = cellElement(selected.row, selected.column);
          if (node) node.textContent = '';
        }
        break;
      default:
        // A printable character starts editing, replacing what was there —
        // which is how every spreadsheet behaves.
        if (canSave && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault();
          startEdit(event.key);
        }
        break;
    }
  }

  const attemptClose = () => {
    if (dirty && !window.confirm(t('common.confirmClose'))) return;
    close();
  };

  closeButton.addEventListener('click', attemptClose);
  backdrop.addEventListener('mousedown', (event) => {
    if (event.target === backdrop) attemptClose();
  });
  document.addEventListener('keydown', onKeyDown, true);

  addRowButton.addEventListener('click', () => {
    extraRows += 1;
    renderGrid();
  });
  addColumnButton.addEventListener('click', () => {
    extraColumns += 1;
    renderGrid();
  });

  saveButton.addEventListener('click', async () => {
    commitEdit();
    saveButton.disabled = true;
    status.textContent = t('common.saving');
    try {
      const result = await onSave({ sheets, meta: workbook.meta });
      dirty = false;
      status.textContent =
        t('common.saved') +
        (result?.entry ? ` · ${formatBytes(result.entry.size, t)}` : '');
      if (result?.warnings?.length) status.textContent += ` · ${result.warnings.join('; ')}`;
    } catch (err) {
      status.textContent = errorText(err) || t('common.saveFailed');
      saveButton.disabled = false;
    }
  });

  container.append(backdrop);
  renderTabs();
  renderGrid();
  grid.focus();

  return { close, get dirty() { return dirty; } };
}
