import { clear, el } from './dom.js';
import { icon } from './icons.js';
import { folderIconSvg } from './file-icon.js';

/**
 * Left-pane folder tree.
 *
 * Children load on first expand rather than up front, so mounting stays cheap
 * on a large tree. Every rendered folder is registered in `#nodes` so the
 * manager can reveal or refresh an arbitrary path after an operation.
 */
export class FolderTree {
  /** @type {Map<string, {row: HTMLElement, childHost: HTMLElement, twisty: HTMLElement, data: object, expanded: boolean, loaded: boolean}>} */
  #nodes = new Map();

  #activePath = '/';

  constructor({
    provider,
    rootLabel = 'Files',
    t,
    errorText,
    onNavigate,
    onDropOn,
    onError,
  }) {
    this.t = t ?? ((key) => key);
    this.errorText = errorText ?? ((err) => err?.message ?? '');
    this.provider = provider;
    this.rootLabel = rootLabel;
    this.onNavigate = onNavigate;
    this.onDropOn = onDropOn;
    this.onError = onError;
    this.element = el('div.fsfm-tree', { role: 'tree', 'aria-label': this.t('tree.title') });
  }

  /** Load the root and its first level. */
  async load() {
    try {
      const root = await this.provider.tree('/', 1);
      this.#nodes.clear();
      clear(this.element);
      this.#renderNode({ ...root, path: '/', name: this.rootLabel }, 0, this.element);
      await this.expand('/');
      this.setActive(this.#activePath);
    } catch (err) {
      clear(this.element).append(el('div.fsfm-tree-error', { text: this.errorText(err) }));
      this.onError?.(err);
    }
  }

  #renderNode(data, depth, parentHost) {
    const twisty = el('button.fsfm-tree-twisty', {
      type: 'button',
      tabindex: '-1',
      'aria-label': this.t('tree.toggle'),
      html: data.hasChildren ? icon('caretRightFill', 10) : '',
      disabled: !data.hasChildren,
    });

    const iconHost = el('span.fsfm-tree-icon', { html: folderIconSvg({ size: 16 }) });
    const label = el('span.fsfm-tree-name', { text: data.path === '/' ? this.rootLabel : data.name });

    const row = el(
      'div.fsfm-tree-row',
      {
        role: 'treeitem',
        tabindex: '-1',
        'aria-expanded': data.hasChildren ? 'false' : null,
        title: data.path,
        dataset: { path: data.path },
        style: { paddingLeft: `${depth * 14 + 6}px` },
      },
      [twisty, iconHost, label]
    );

    const childHost = el('div.fsfm-tree-children', { role: 'group', hidden: true });
    const entry = { row, childHost, twisty, iconHost, data, depth, expanded: false, loaded: false };
    this.#nodes.set(data.path, entry);

    twisty.addEventListener('click', (event) => {
      event.stopPropagation();
      this.toggle(data.path);
    });
    row.addEventListener('click', () => {
      this.onNavigate?.(data.path);
    });
    row.addEventListener('dblclick', () => this.toggle(data.path));
    row.addEventListener('keydown', (event) => this.#onRowKeyDown(event, data.path));

    this.#wireDropTarget(row, data.path);

    parentHost.append(row, childHost);
    return entry;
  }

  /** Accept both file drops (upload) and internal entry drops (move). */
  #wireDropTarget(row, path) {
    let depth = 0;

    row.addEventListener('dragover', (event) => {
      if (!this.onDropOn) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = event.dataTransfer.types.includes('Files') ? 'copy' : 'move';
    });
    row.addEventListener('dragenter', (event) => {
      if (!this.onDropOn) return;
      event.preventDefault();
      depth += 1;
      row.classList.add('is-drop-target');
    });
    row.addEventListener('dragleave', () => {
      // dragleave fires for child elements too; only clear once the pointer
      // has actually left the row.
      depth = Math.max(0, depth - 1);
      if (depth === 0) row.classList.remove('is-drop-target');
    });
    row.addEventListener('drop', (event) => {
      event.preventDefault();
      event.stopPropagation();
      depth = 0;
      row.classList.remove('is-drop-target');
      this.onDropOn?.(path, event.dataTransfer);
    });
  }

  #onRowKeyDown(event, path) {
    const entry = this.#nodes.get(path);
    if (!entry) return;
    switch (event.key) {
      case 'ArrowRight':
        event.preventDefault();
        if (!entry.expanded && entry.data.hasChildren) this.expand(path);
        break;
      case 'ArrowLeft':
        event.preventDefault();
        if (entry.expanded) this.collapse(path);
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        this.onNavigate?.(path);
        break;
      case 'ArrowDown':
      case 'ArrowUp': {
        event.preventDefault();
        const rows = [...this.element.querySelectorAll('.fsfm-tree-row')].filter(
          (node) => node.offsetParent !== null
        );
        const index = rows.indexOf(entry.row);
        const next = rows[index + (event.key === 'ArrowDown' ? 1 : -1)];
        next?.focus();
        break;
      }
      default:
        break;
    }
  }

  async toggle(path) {
    const entry = this.#nodes.get(path);
    if (!entry) return;
    if (entry.expanded) this.collapse(path);
    else await this.expand(path);
  }

  async expand(path) {
    const entry = this.#nodes.get(path);
    if (!entry || !entry.data.hasChildren) return;
    entry.expanded = true;
    entry.childHost.hidden = false;
    entry.row.setAttribute('aria-expanded', 'true');
    entry.twisty.innerHTML = icon('caretDownFill', 10);
    entry.iconHost.innerHTML = folderIconSvg({ size: 16, open: true });
    if (!entry.loaded) await this.#loadChildren(path);
  }

  collapse(path) {
    const entry = this.#nodes.get(path);
    if (!entry) return;
    entry.expanded = false;
    entry.childHost.hidden = true;
    entry.row.setAttribute('aria-expanded', 'false');
    entry.twisty.innerHTML = entry.data.hasChildren ? icon('caretRightFill', 10) : '';
    entry.iconHost.innerHTML = folderIconSvg({ size: 16 });
  }

  async #loadChildren(path) {
    const entry = this.#nodes.get(path);
    if (!entry) return;
    entry.twisty.classList.add('is-busy');
    try {
      const subtree = await this.provider.tree(path, 1);
      // Drop stale registrations before re-rendering, or a deleted folder
      // would linger in the lookup map.
      this.#forgetDescendants(path);
      clear(entry.childHost);
      for (const child of subtree.children ?? []) {
        this.#renderNode(child, entry.depth + 1, entry.childHost);
      }
      entry.loaded = true;
      entry.data.hasChildren = (subtree.children ?? []).length > 0;
      if (!entry.data.hasChildren) {
        entry.twisty.disabled = true;
        entry.twisty.innerHTML = '';
        entry.row.removeAttribute('aria-expanded');
      }
      this.setActive(this.#activePath);
    } catch (err) {
      clear(entry.childHost).append(el('div.fsfm-tree-error', { text: err.message }));
      this.onError?.(err);
    } finally {
      entry.twisty.classList.remove('is-busy');
    }
  }

  #forgetDescendants(path) {
    const prefix = path === '/' ? '/' : `${path}/`;
    for (const key of [...this.#nodes.keys()]) {
      if (key !== path && key.startsWith(prefix)) this.#nodes.delete(key);
    }
  }

  /**
   * Expand every ancestor of `path` (loading as needed) and mark it active.
   * Safe to call with a path that no longer exists — it stops where the tree
   * ends rather than throwing.
   */
  async reveal(path) {
    const segments = String(path || '/').split('/').filter(Boolean);
    let current = '/';
    await this.expand('/');
    for (const segment of segments) {
      current = current === '/' ? `/${segment}` : `${current}/${segment}`;
      if (!this.#nodes.has(current)) break;
      await this.expand(current);
    }
    this.setActive(path);
  }

  /**
   * Reload several folders at once.
   *
   * A single move touches the sources, the destination and the folder on
   * screen — often the same folder more than once. Refreshing them one call at
   * a time meant three or four sequential round trips per operation, most of
   * them duplicates. Deduplicating first and issuing the rest together costs
   * one round trip in total.
   *
   * @param {Array<string|null|undefined>} paths
   */
  async refreshPaths(paths) {
    const unique = [...new Set(paths.filter((path) => typeof path === 'string'))];
    await Promise.all(unique.map((path) => this.refreshPath(path)));
  }

  /** Reload one folder's children if it is currently expanded. */
  async refreshPath(path) {
    const entry = this.#nodes.get(path);
    if (!entry) return;
    entry.loaded = false;
    if (entry.expanded) {
      await this.#loadChildren(path);
    } else if (!entry.data.hasChildren) {
      // A folder may have gained its first child; re-check so the twisty appears.
      try {
        const subtree = await this.provider.tree(path, 1);
        const has = (subtree.children ?? []).length > 0;
        if (has) {
          entry.data.hasChildren = true;
          entry.twisty.disabled = false;
          entry.twisty.innerHTML = icon('caretRightFill', 10);
          entry.row.setAttribute('aria-expanded', 'false');
        }
      } catch {
        // A refresh hint failing is not worth surfacing.
      }
    }
  }

  setActive(path) {
    this.#activePath = path;
    for (const [key, entry] of this.#nodes) {
      entry.row.classList.toggle('is-active', key === path);
      entry.row.tabIndex = key === path ? 0 : -1;
    }
  }

  focusActive() {
    this.#nodes.get(this.#activePath)?.row.focus();
  }

  destroy() {
    this.#nodes.clear();
    this.element.remove();
  }
}
