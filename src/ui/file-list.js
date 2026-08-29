import { clear, el } from './dom.js';
import { attachIconFallbacks, resolveFileIcon } from './file-icon.js';
import { formatBytes, formatDate } from '../core/format.js';

/** MIME type used to mark an internal drag, so an OS file drop is told apart. */
export const INTERNAL_DRAG_TYPE = 'application/x-bookmark-file-manager';

/**
 * How many tiles are built per batch.
 *
 * A directory with tens of thousands of entries used to become that many DOM
 * nodes in one synchronous pass, which locks the tab for seconds. Entries
 * beyond the first batch are appended as the user scrolls towards them, so the
 * time to first paint is bounded by the batch and not by the directory.
 */
const RENDER_CHUNK = 200;

/** Rendering runs this far ahead of the scroll position, in pixels. */
const SCROLL_LOOKAHEAD = 600;

/**
 * One reusable collator. `localeCompare` with options builds a new one per
 * comparison, which is most of the cost of sorting a large listing.
 */
const NAME_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * Main pane: the entries of one directory, as tiles or as a details table.
 *
 * Owns selection and its keyboard/pointer model. It never talks to the
 * provider — every action is reported upward, so the manager stays the single
 * place where filesystem mutations happen.
 */
export class FileList {
  /** @type {Set<string>} selected virtual paths */
  #selection = new Set();

  /** @type {object[]} entries currently rendered, in display order */
  #visible = [];

  /** @type {object[]} everything in the directory, before filtering */
  #all = [];

  /** Path last clicked without a modifier; shift-click ranges extend from it. */
  #anchor = null;

  #view = 'grid';

  #sort = { key: 'name', direction: 'asc' };

  #filter = '';

  #listing = { path: '/', parent: null, items: [] };

  /** The element tiles are appended to, and how many of #visible are in it. */
  #body = null;

  #rendered = 0;

  constructor({
    iconBasePath = null,
    customizeThumbnail = null,
    thumbnailUrl = null,
    view = 'grid',
    onOpen,
    onSelectionChange,
    onContextMenu,
    onDropFiles,
    onDropEntries,
    onNavigateParent,
    t,
    localeTag,
    emptyText = null,
  } = {}) {
    this.t = t ?? ((key) => key);
    this.localeTag = localeTag;
    this.iconBasePath = iconBasePath;
    this.customizeThumbnail = customizeThumbnail;
    this.thumbnailUrl = thumbnailUrl;
    this.#view = view;
    this.onOpen = onOpen;
    this.onSelectionChange = onSelectionChange;
    this.onContextMenu = onContextMenu;
    this.onDropFiles = onDropFiles;
    this.onDropEntries = onDropEntries;
    this.onNavigateParent = onNavigateParent;
    // A host may override the empty-folder wording; otherwise it follows the
    // chosen language like everything else.
    this.emptyText = emptyText ?? this.t('list.empty');

    this.element = el('div.fsfm-list', {
      tabindex: '0',
      role: 'listbox',
      'aria-multiselectable': 'true',
      'aria-label': this.t('list.label'),
    });

    attachIconFallbacks(this.element);
    this.#wireEvents();
  }

  get view() {
    return this.#view;
  }

  get sort() {
    return { ...this.#sort };
  }

  get currentPath() {
    return this.#listing.path;
  }

  /** Entry objects for the current selection, in display order. */
  getSelection() {
    return this.#visible.filter((entry) => this.#selection.has(entry.path));
  }

  getSelectedPaths() {
    return this.getSelection().map((entry) => entry.path);
  }

  /** All entries currently shown (after filtering). */
  getVisible() {
    return [...this.#visible];
  }

  getAll() {
    return [...this.#all];
  }

  setView(view) {
    if (view !== 'grid' && view !== 'list') return;
    this.#view = view;
    this.#render();
  }

  setSort(key, direction) {
    this.#sort = {
      key,
      direction: direction ?? (this.#sort.key === key && this.#sort.direction === 'asc' ? 'desc' : 'asc'),
    };
    this.#render();
  }

  setFilter(query) {
    this.#filter = String(query || '').trim().toLowerCase();
    this.#render();
  }

  /**
   * Replace the contents.
   * @param {{path: string, parent: string|null, items: object[]}} listing
   * @param {{keepSelection?: boolean, select?: string[]}} [options]
   */
  render(listing, options = {}) {
    const previous = new Set(this.#selection);
    this.#listing = listing;
    this.#all = listing.items ?? [];

    this.#selection.clear();
    if (options.select?.length) {
      for (const path of options.select) this.#selection.add(path);
    } else if (options.keepSelection) {
      // Keep only what still exists after the refresh.
      const alive = new Set(this.#all.map((entry) => entry.path));
      for (const path of previous) if (alive.has(path)) this.#selection.add(path);
    }
    this.#anchor = null;
    this.#render();
  }

  #sortedFiltered() {
    let items = this.#all;
    if (this.#filter) {
      items = items.filter((entry) => entry.name.toLowerCase().includes(this.#filter));
    }
    const { key, direction } = this.#sort;
    const factor = direction === 'desc' ? -1 : 1;
    return [...items].sort((a, b) => {
      // Folders stay above files regardless of the active sort — that ordering
      // is structural, not a preference.
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      let result;
      if (key === 'size') {
        result = (a.size ?? -1) - (b.size ?? -1);
      } else if (key === 'modified') {
        result = new Date(a.modified).getTime() - new Date(b.modified).getTime();
      } else {
        result = NAME_COLLATOR.compare(a.name, b.name);
      }
      // Fall back to name so equal keys keep a stable, predictable order.
      if (result === 0 && key !== 'name') {
        result = NAME_COLLATOR.compare(a.name, b.name);
      }
      return result * factor;
    });
  }

  #render() {
    this.#visible = this.#sortedFiltered();
    clear(this.element);
    this.element.classList.toggle('fsfm-list-grid', this.#view === 'grid');
    this.element.classList.toggle('fsfm-list-details', this.#view === 'list');

    if (this.#view === 'list') this.element.append(this.#renderHeader());

    const body = el('div.fsfm-list-body');
    this.#body = body;
    this.#rendered = 0;

    // ".." tile, so the mouse can go up without reaching for the toolbar.
    if (this.#listing.parent !== null) {
      body.append(this.#renderUpEntry());
    }

    if (this.#visible.length === 0) {
      body.append(
        el('div.fsfm-empty', {
          text: this.#filter ? this.t('list.noMatch', { query: this.#filter }) : this.emptyText,
        })
      );
    }

    // The server tells us when it stopped counting; saying so beats letting the
    // user believe a truncated directory is the whole of it.
    if (this.#listing.truncated) {
      body.append(
        el('div.fsfm-notice', {
          text:
            this.t('list.truncated', {
              shown: this.#visible.length,
              total: this.#listing.total,
            }) + this.t('list.truncatedHint'),
        })
      );
    }

    this.element.append(body);
    this.#renderChunk();
    this.#emitSelection();
  }

  /** Append the next batch of tiles, and keep going while more fit on screen. */
  #renderChunk() {
    const body = this.#body;
    if (!body || this.#rendered >= this.#visible.length) return;

    const upTo = Math.min(this.#rendered + RENDER_CHUNK, this.#visible.length);
    // One fragment, one reflow, regardless of the batch size.
    const fragment = document.createDocumentFragment();
    for (let index = this.#rendered; index < upTo; index += 1) {
      fragment.append(this.#renderEntry(this.#visible[index]));
    }
    body.append(fragment);
    this.#rendered = upTo;

    // A short list, or a tall viewport, should not need a scroll to fill in.
    if (this.#needsMore()) this.#renderChunk();
  }

  /** True while the rendered tail sits within a lookahead of the viewport. */
  #needsMore() {
    if (this.#rendered >= this.#visible.length) return false;
    const { scrollTop, clientHeight, scrollHeight } = this.element;
    return scrollHeight - scrollTop - clientHeight < SCROLL_LOOKAHEAD;
  }

  #renderHeader() {
    const column = (key, label, className = '') => {
      const active = this.#sort.key === key;
      return el('button.fsfm-col', {
        type: 'button',
        class: `${className} ${active ? 'is-sorted' : ''}`.trim(),
        'aria-sort': active ? (this.#sort.direction === 'asc' ? 'ascending' : 'descending') : 'none',
        text: active ? `${label} ${this.#sort.direction === 'asc' ? '▲' : '▼'}` : label,
        on: { click: () => this.setSort(key) },
      });
    };
    return el('div.fsfm-list-header', { role: 'row' }, [
      column('name', this.t('common.name'), 'fsfm-col-name'),
      column('size', this.t('common.size'), 'fsfm-col-size'),
      column('modified', this.t('common.modified'), 'fsfm-col-date'),
    ]);
  }

  #renderUpEntry() {
    const node = el(
      'div.fsfm-entry.fsfm-entry-up',
      {
        role: 'option',
        tabindex: '-1',
        title: this.t('nav.up'),
        dataset: { up: '1' },
      },
      [
        el('div.fsfm-entry-icon', {
          html: resolveFileIcon({ name: '..', isDirectory: true }, {
            iconBasePath: this.iconBasePath,
            customize: this.customizeThumbnail,
            size: this.#view === 'grid' ? 48 : 20,
            open: true,
          }),
        }),
        el('div.fsfm-entry-name', { text: '..' }),
        this.#view === 'list' ? el('div.fsfm-entry-size') : null,
        this.#view === 'list' ? el('div.fsfm-entry-date') : null,
      ].filter(Boolean)
    );
    node.addEventListener('dblclick', () => this.onNavigateParent?.());
    node.addEventListener('click', () => {
      // Single click on ".." navigates: it holds nothing to select, so
      // requiring a double click would just be a dead click.
      this.onNavigateParent?.();
    });
    return node;
  }

  #renderEntry(entry) {
    const selected = this.#selection.has(entry.path);
    const details = [
      this.t('list.tipName', { name: entry.name }),
      entry.isDirectory
        ? this.t('list.tipTypeFolder')
        : this.t('list.tipSize', { size: formatBytes(entry.size, this.t) }),
      this.t('list.tipPath', { path: entry.path }),
      this.t('list.tipModified', { modified: formatDate(entry.modified, this.localeTag) }),
      entry.modeOctal ? this.t('list.tipMode', { mode: entry.modeOctal }) : null,
      entry.executable ? this.t('list.tipExecutable') : null,
    ].filter(Boolean).join('\n');

    const node = el(
      'div.fsfm-entry',
      {
        role: 'option',
        tabindex: '-1',
        'aria-selected': selected ? 'true' : 'false',
        class: [selected ? 'is-selected' : '', entry.executable ? 'is-executable' : '']
          .filter(Boolean)
          .join(' '),
        title: details,
        draggable: true,
        dataset: { path: entry.path, directory: entry.isDirectory ? '1' : '0' },
      },
      [
        el('div.fsfm-entry-icon', {
          html: resolveFileIcon(entry, {
            iconBasePath: this.iconBasePath,
            customize: this.customizeThumbnail,
            thumbnailUrl: this.thumbnailUrl,
            size: this.#view === 'grid' ? 48 : 20,
            // Ask for twice the drawn size so the tile stays sharp on a
            // high-DPI screen; the server rounds to a size it accepts.
            thumbnailSize: this.#view === 'grid' ? 128 : 64,
          }),
        }),
        el('div.fsfm-entry-name', { text: entry.name }),
        this.#view === 'list'
          ? el('div.fsfm-entry-size', {
            text: entry.isDirectory ? '—' : formatBytes(entry.size, this.t),
          })
          : null,
        this.#view === 'list' ? el('div.fsfm-entry-date', { text: formatDate(entry.modified, this.localeTag) }) : null,
      ].filter(Boolean)
    );

    if (entry.isDirectory) this.#wireFolderDrop(node, entry);
    return node;
  }

  /** A folder tile accepts drops, both from the OS and from this widget. */
  #wireFolderDrop(node, entry) {
    let depth = 0;
    node.addEventListener('dragover', (event) => {
      if (this.#selection.has(entry.path)) return; // cannot drop onto itself
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = event.dataTransfer.types.includes('Files') ? 'copy' : 'move';
    });
    node.addEventListener('dragenter', (event) => {
      if (this.#selection.has(entry.path)) return;
      event.preventDefault();
      depth += 1;
      node.classList.add('is-drop-target');
    });
    node.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) node.classList.remove('is-drop-target');
    });
    node.addEventListener('drop', (event) => {
      if (this.#selection.has(entry.path)) return;
      event.preventDefault();
      event.stopPropagation();
      depth = 0;
      node.classList.remove('is-drop-target');
      this.#handleDrop(event.dataTransfer, entry.path);
    });
  }

  #handleDrop(dataTransfer, destination) {
    if (dataTransfer.types.includes('Files') && dataTransfer.files.length > 0) {
      this.onDropFiles?.(dataTransfer.files, destination);
      return;
    }
    const raw = dataTransfer.getData(INTERNAL_DRAG_TYPE);
    if (!raw) return;
    try {
      const paths = JSON.parse(raw);
      if (Array.isArray(paths) && paths.length) this.onDropEntries?.(paths, destination);
    } catch {
      // Malformed payload from another app; nothing sensible to do.
    }
  }

  #entryFromEvent(event) {
    const node = event.target.closest?.('.fsfm-entry');
    if (!node || node.dataset.up === '1') return null;
    const path = node.dataset.path;
    return this.#visible.find((item) => item.path === path) ?? null;
  }

  #wireEvents() {
    this.element.addEventListener('scroll', () => {
      if (this.#needsMore()) this.#renderChunk();
    }, { passive: true });

    this.element.addEventListener('click', (event) => {
      const entry = this.#entryFromEvent(event);
      if (!entry) {
        if (!event.target.closest('.fsfm-list-header')) this.clearSelection();
        return;
      }
      this.#applyClickSelection(entry, event);
    });

    this.element.addEventListener('dblclick', (event) => {
      const entry = this.#entryFromEvent(event);
      if (entry) this.onOpen?.(entry);
    });

    this.element.addEventListener('contextmenu', (event) => {
      const entry = this.#entryFromEvent(event);
      if (entry && !this.#selection.has(entry.path)) {
        this.#selection.clear();
        this.#selection.add(entry.path);
        this.#anchor = entry.path;
        this.#syncSelectionClasses();
      } else if (!entry) {
        this.clearSelection();
      }
      event.preventDefault();
      this.onContextMenu?.(event, entry);
    });

    this.element.addEventListener('keydown', (event) => this.#onKeyDown(event));

    // Drag out of the widget: carry the selected paths.
    this.element.addEventListener('dragstart', (event) => {
      const entry = this.#entryFromEvent(event);
      if (!entry) return;
      if (!this.#selection.has(entry.path)) {
        this.#selection.clear();
        this.#selection.add(entry.path);
        this.#anchor = entry.path;
        this.#syncSelectionClasses();
      }
      const paths = this.getSelectedPaths();
      event.dataTransfer.effectAllowed = 'copyMove';
      event.dataTransfer.setData(INTERNAL_DRAG_TYPE, JSON.stringify(paths));
      // A plain-text mirror lets the paths be dropped into a text field.
      event.dataTransfer.setData('text/plain', paths.join('\n'));
      this.element.classList.add('is-dragging');
    });
    this.element.addEventListener('dragend', () => {
      this.element.classList.remove('is-dragging');
      this.element
        .querySelectorAll('.is-drop-target')
        .forEach((node) => node.classList.remove('is-drop-target'));
    });

    // Drop on empty space: target the directory being viewed.
    this.element.addEventListener('dragover', (event) => {
      if (!event.dataTransfer.types.includes('Files')) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      this.element.classList.add('is-drop-active');
    });
    this.element.addEventListener('dragleave', (event) => {
      if (event.target === this.element) this.element.classList.remove('is-drop-active');
    });
    this.element.addEventListener('drop', (event) => {
      event.preventDefault();
      this.element.classList.remove('is-drop-active');
      this.#handleDrop(event.dataTransfer, this.#listing.path);
    });
  }

  #applyClickSelection(entry, event) {
    const multi = event.ctrlKey || event.metaKey;
    if (event.shiftKey && this.#anchor) {
      const paths = this.#visible.map((item) => item.path);
      const from = paths.indexOf(this.#anchor);
      const to = paths.indexOf(entry.path);
      if (from !== -1 && to !== -1) {
        const [start, end] = from < to ? [from, to] : [to, from];
        if (!multi) this.#selection.clear();
        for (let i = start; i <= end; i += 1) this.#selection.add(paths[i]);
      }
    } else if (multi) {
      if (this.#selection.has(entry.path)) this.#selection.delete(entry.path);
      else this.#selection.add(entry.path);
      this.#anchor = entry.path;
    } else {
      this.#selection.clear();
      this.#selection.add(entry.path);
      this.#anchor = entry.path;
    }
    this.#syncSelectionClasses();
  }

  #onKeyDown(event) {
    const paths = this.#visible.map((item) => item.path);
    if (paths.length === 0 && event.key !== 'Backspace') return;

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      this.selectAll();
      return;
    }

    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp':
      case 'ArrowLeft':
      case 'ArrowRight': {
        event.preventDefault();
        const step = this.#view === 'grid' && (event.key === 'ArrowDown' || event.key === 'ArrowUp')
          ? this.#columnsPerRow()
          : 1;
        const delta = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? step : -step;
        const current = this.#anchor ? paths.indexOf(this.#anchor) : -1;
        const next = Math.max(0, Math.min(paths.length - 1, current === -1 ? 0 : current + delta));
        const target = paths[next];
        if (!target) return;
        if (event.shiftKey && this.#anchor) {
          const from = paths.indexOf(this.#anchor);
          const [start, end] = from < next ? [from, next] : [next, from];
          this.#selection.clear();
          for (let i = start; i <= end; i += 1) this.#selection.add(paths[i]);
        } else {
          this.#selection.clear();
          this.#selection.add(target);
          this.#anchor = target;
        }
        this.#syncSelectionClasses();
        this.#scrollIntoView(target);
        break;
      }
      case 'Enter': {
        // Alt+Enter belongs to the properties sheet, which the manager handles
        // one level up. Opening the file here would win the race and leave
        // that shortcut working only on files the viewer cannot show.
        if (event.altKey) break;
        const selected = this.getSelection();
        if (selected.length === 1) {
          event.preventDefault();
          this.onOpen?.(selected[0]);
        }
        break;
      }
      case 'Backspace':
        event.preventDefault();
        this.onNavigateParent?.();
        break;
      case 'Escape':
        this.clearSelection();
        break;
      case 'Home':
      case 'End': {
        event.preventDefault();
        const target = event.key === 'Home' ? paths[0] : paths[paths.length - 1];
        this.#selection.clear();
        this.#selection.add(target);
        this.#anchor = target;
        this.#syncSelectionClasses();
        this.#scrollIntoView(target);
        break;
      }
      default:
        break;
    }
  }

  /** How many tiles fit per row, for grid arrow navigation. */
  #columnsPerRow() {
    const first = this.element.querySelector('.fsfm-entry');
    if (!first) return 1;
    const body = this.element.querySelector('.fsfm-list-body');
    if (!body) return 1;
    const tileWidth = first.getBoundingClientRect().width;
    if (tileWidth <= 0) return 1;
    return Math.max(1, Math.floor(body.getBoundingClientRect().width / tileWidth));
  }

  #scrollIntoView(path) {
    // The target may not be built yet on a long list; build up to it first.
    const index = this.#visible.findIndex((entry) => entry.path === path);
    while (index >= this.#rendered && this.#rendered < this.#visible.length) {
      this.#renderChunk();
    }
    const node = this.element.querySelector(`.fsfm-entry[data-path="${CSS.escape(path)}"]`);
    node?.scrollIntoView({ block: 'nearest' });
  }

  #syncSelectionClasses() {
    for (const node of this.element.querySelectorAll('.fsfm-entry')) {
      if (node.dataset.up === '1') continue;
      const selected = this.#selection.has(node.dataset.path);
      node.classList.toggle('is-selected', selected);
      node.setAttribute('aria-selected', selected ? 'true' : 'false');
    }
    this.#emitSelection();
  }

  selectAll() {
    for (const entry of this.#visible) this.#selection.add(entry.path);
    this.#syncSelectionClasses();
  }

  selectPaths(paths) {
    this.#selection.clear();
    for (const path of paths) this.#selection.add(path);
    this.#anchor = paths[paths.length - 1] ?? null;
    this.#syncSelectionClasses();
    if (paths.length) this.#scrollIntoView(paths[0]);
  }

  clearSelection() {
    if (this.#selection.size === 0) return;
    this.#selection.clear();
    this.#anchor = null;
    this.#syncSelectionClasses();
  }

  #emitSelection() {
    this.onSelectionChange?.(this.getSelection());
  }

  focus() {
    this.element.focus();
  }

  destroy() {
    this.element.remove();
  }
}
