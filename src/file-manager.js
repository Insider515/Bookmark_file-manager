import { HttpProvider, ProviderError } from './core/http-provider.js';
import { createTranslator, resolveLocale } from './core/i18n.js';
import { buildThemeCss } from './core/theme.js';
import { DEFAULT_LOCALE, LOCALES } from './locales/index.js';
import { formatBytes, parentPath, pathSegments, resolvePath } from './core/format.js';
import { ContextMenu } from './ui/context-menu.js';
import { clear, copyToClipboard, el, Emitter } from './ui/dom.js';
import { closeDialogs, confirmDialog, folderPickerDialog, progressDialog, promptDialog } from './ui/dialog.js';
import { FileList, INTERNAL_DRAG_TYPE } from './ui/file-list.js';
import { icon } from './ui/icons.js';
import { ToastHost } from './ui/toast.js';
import { canPreview, openPreview } from './ui/preview.js';
import { permissionsDialog, propertiesDialog } from './ui/properties.js';
import { openSheetEditor } from './ui/sheet-editor.js';
import { openCodeEditor } from './ui/code-editor.js';
import { openDocumentEditor } from './ui/doc-editor.js';
import { openSearchDialog } from './ui/search.js';
import { Terminal } from './ui/terminal.js';
import { languageOf } from './ui/highlight.js';
import {
  archiveContentsDialog,
  archiveDialog,
  archiveFormatOf,
  buildExtensionIndex,
} from './ui/archive.js';
import { FolderTree } from './ui/tree.js';

/** Extensions the server will serve inline, so opening one previews it. */
const PREVIEWABLE = new Set([
  'txt', 'md', 'log', 'csv', 'json', 'xml',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'ico', 'bmp', 'pdf',
  'mp4', 'webm', 'mp3', 'wav', 'ogg',
]);

/** Names that are always rejected client-side, before a round trip. */
const INVALID_NAME = /[/\\:*?"<>|]/;

/**
 * The eight primary actions, in the order and grouping the toolbar lays them
 * out. Enabling a subset filters this list rather than reordering it, so any
 * combination still reads left to right the same way.
 */
const TOOLBAR_GROUPS = [
  ['newFolder', 'newFile'],
  ['move', 'copy', 'rename', 'delete'],
  ['download', 'upload'],
  // Everything below is also in the context menu. It is repeated here for
  // touch devices, where there is no right-click to open that menu at all:
  // without these, selecting a file on a tablet leaves half the manager
  // unreachable.
  ['open', 'preview', 'sheet', 'code', 'document'],
  ['compress', 'extract', 'archiveContents'],
  ['executable', 'permissions'],
  ['copyPath', 'properties', 'selectAll'],
];

/** Flat form of the above, for validating the option. */
export const TOOLBAR_ACTIONS = TOOLBAR_GROUPS.flat();

/**
 * The eight the toolbar used to carry, for a host that wants only those.
 *
 *   new FileManager('#host', { toolbarActions: TOOLBAR_PRIMARY_ACTIONS })
 */
export const TOOLBAR_PRIMARY_ACTIONS = [
  'newFolder', 'newFile', 'move', 'copy', 'rename', 'delete', 'download', 'upload',
];

/** Per-operation switches. The server reports its own set and wins on conflict. */
const PERMISSION_KEYS = [
  'create', 'upload', 'move', 'copy', 'rename', 'remove', 'download', 'chmod',
  'archive', 'extract', 'edit',
];

/** Counter behind the per-instance theme scope. */
let themeCounter = 0;

const DEFAULTS = {
  endpoint: '/api/files',
  provider: null,
  /** Name of the root in the tree and the breadcrumbs. Follows `locale` when null. */
  rootLabel: null,
  initialPath: '/',
  view: 'grid',
  iconBasePath: null,
  /**
   * Hide or disable individual operations, e.g. `{ remove: false }`.
   * Anything omitted is allowed. Purely a UI concern — the server enforces
   * its own set regardless, and the effective set is the intersection.
   */
  permissions: null,
  /**
   * Override the icon for an entry: return an <img> src, a raw SVG string, or
   * null/undefined to fall through to the built-in icon.
   * @type {((entry: {name: string, path: string, isDirectory: boolean}) => string|null)|null}
   */
  customizeThumbnail: null,
  /**
   * Show images and PDFs in a viewer over the widget instead of handing them
   * to a new browser tab. Anything the viewer cannot render still opens in a
   * tab, so this narrows what leaves the page rather than what can be opened.
   */
  preview: true,
  /** Draw image tiles from the file itself rather than from a generic icon. */
  thumbnails: true,
  /** Open csv, xlsx, xls and ods in the grid editor instead of downloading. */
  sheets: true,
  documents: true,
  search: true,
  terminal: true,
  /** Open text and source files in the code editor instead of downloading. */
  code: true,
  showTree: true,
  showToolbar: true,
  /**
   * Which of the eight primary actions appear on the toolbar.
   *
   * `false` (the default) shows none of them, leaving the toolbar to search,
   * refresh and the view toggle. `true` shows all eight; an array shows the
   * ones it names, in the fixed order above.
   *
   * Hiding them removes a row of buttons, not the operations: every one stays
   * on the context menu, on its keyboard shortcut, and on the public API, so
   * nothing becomes unreachable by turning this off.
   */
  toolbarActions: false,
  showStatusBar: true,
  showSearch: true,
  confirmDelete: true,
  headers: null,
  credentials: 'same-origin',
  /**
   * Colours, fonts and metrics.
   *
   *   theme: {
   *     font: 'Inter, sans-serif',
   *     fontSize: '15px',
   *     colors: { accent: '#7c3aed' },     // both schemes
   *     dark: { accent: '#a78bfa' },       // the dark one only
   *   }
   *
   * Omitted entirely, the widget keeps its built-in palette — what the demo
   * shows. See `src/core/theme.js` for every key.
   *
   * @type {object|null}
   */
  theme: null,
  /**
   * What language the widget speaks.
   *
   * A shipped language id — `'en'`, `'uk'`, `'es'`, `'de'`, `'fr'` — or a full
   * tag whose base matches one of them (`'de-AT'` gives German). English when
   * omitted, and English again for anything unrecognised: a typo in a config
   * value should not take the file manager down.
   *
   * A host that needs a language not shipped here passes its own dictionary
   * object instead; see `src/core/i18n.js` for its shape. It may be partial —
   * whatever it leaves out comes from English.
   *
   * @type {string|object|null}
   */
  locale: null,
};

/**
 * Embeddable file manager.
 *
 *   const manager = new FileManager('#host', { endpoint: '/api/files' });
 *   manager.on('open', ({ entry }) => console.log(entry.path));
 *
 * The widget renders entirely inside the element it is given and cleans up
 * after itself on destroy(), so it can live in a modal, a tab, or a route
 * that unmounts.
 */
export class FileManager extends Emitter {
  #busyDepth = 0;

  #currentPath = '/';

  #listing = { path: '/', parent: null, items: [] };

  #readOnly = false;

  /** Effective permissions: the host's options intersected with the server's. */
  #permissions = Object.fromEntries(PERMISSION_KEYS.map((key) => [key, true]));

  #config = {
    maxUploadSize: 0,
    maxUploadFiles: 0,
    thumbnails: false,
    thumbnailSizes: [],
    chmodSupported: false,
    archiveFormats: {},
    imageView: null,
    sheetFormats: {},
    documentFormats: {},
    search: {},
  };

  /** The open spreadsheet editor, so a second open replaces rather than stacks. */
  #sheetEditor = null;

  /** The open document editor, for the same reason. */
  #documentEditor = null;

  /** The open search dialog, so a second request reuses it. */
  #searchDialog = null;

  /** The path input that replaces the crumbs while it is open. */
  #pathInput = null;

  /** The terminal panel, when the option is on. */
  #terminal = null;

  /** Whether the panel is on screen; the option only sets the starting state. */
  #terminalVisible = false;

  /** Same for the code editor. */
  #codeEditor = null;

  /** extension -> format id, built from what /config advertised. */
  #archiveIndex = [];

  /** The open preview viewer, so a second open() replaces rather than stacks. */
  #preview = null;

  #abort = null;

  #destroyed = false;

  #filterTimer = null;

  /** The active language: id, display name, BCP-47 tag, plural rule. */
  #locale = DEFAULT_LOCALE;

  /**
   * @param {HTMLElement|string} target element or CSS selector to mount into
   * @param {Partial<typeof DEFAULTS>} [options]
   */
  constructor(target, options = {}) {
    super();
    const host = typeof target === 'string' ? document.querySelector(target) : target;
    if (!host) throw new Error(`FileManager: container not found (${target})`);

    this.options = { ...DEFAULTS, ...options };

    // Resolved once and handed down to every dialog and panel, so two widgets
    // on one page can speak two languages without sharing global state.
    this.#locale = resolveLocale(this.options.locale, LOCALES, DEFAULT_LOCALE);
    this.t = createTranslator(this.#locale, DEFAULT_LOCALE);

    // Deferred until the translator exists, so the default follows the language
    // while an explicit value from the host still wins.
    if (this.options.rootLabel === null || this.options.rootLabel === undefined) {
      this.options.rootLabel = this.t('tree.rootLabel');
    }

    this.host = host;
    this.provider =
      this.options.provider ??
      new HttpProvider({
        endpoint: this.options.endpoint,
        headers: this.options.headers,
        credentials: this.options.credentials,
      });

    this.#currentPath = this.options.initialPath || '/';
    this.#applyPermissions(this.options.permissions, null);
    this.#build();
    // Kick off loading without making the constructor async; callers that need
    // to await it can use `await manager.ready`.
    this.ready = this.#initialize();
  }

  // ---------------------------------------------------------------- building

  #build() {
    // A tag unique to this widget, so a theme reaches only the instance it was
    // given to and two managers on one page can look different.
    const themeId = String((themeCounter += 1));
    this.root = el('div.fsfm', {
      class: `fsfm-view-${this.options.view}`,
      // Marks the subtree's language for screen readers and for CSS that
      // hyphenates or quotes per language.
      lang: this.#locale.tag ?? 'en',
      dataset: { fsfmTheme: themeId },
    });
    // The drop hint is drawn by a pseudo-element, which only CSS can fill.
    this.root.style.setProperty('--fsfm-drop-label', JSON.stringify(this.t('term.dropHint')));

    // Emitted as a stylesheet rather than set inline: an inline custom property
    // beats every rule in the stylesheet, which would pin the colour and leave
    // the dark theme unable to change it.
    const css = buildThemeCss(`[data-fsfm-theme="${themeId}"]`, this.options.theme);
    if (css) {
      // Inside the root, so destroy() takes it away with everything else.
      this.root.append(el('style', { text: css }));
    }

    this.host.append(this.root);

    this.toasts = new ToastHost(this.root, this.t);
    this.menu = new ContextMenu(this.root);

    if (this.options.showToolbar) {
      this.toolbar = this.#buildToolbar();
      this.root.append(this.toolbar.element);
    }

    this.tree = new FolderTree({
      t: this.t,
      errorText: (err) => this.#errorText(err),
      provider: this.provider,
      rootLabel: this.options.rootLabel,
      onNavigate: (path) => this.navigate(path),
      onDropOn: (path, dataTransfer) => this.#handleDropOn(path, dataTransfer),
      onError: (err) => this.emit('error', { error: err }),
    });

    this.fileList = new FileList({
      t: this.t,
      errorText: (err) => this.#errorText(err),
      localeTag: this.#locale.tag,
      iconBasePath: this.options.iconBasePath,
      customizeThumbnail: this.options.customizeThumbnail,
      // A function rather than a flag: the list asks per entry, and the answer
      // depends on what the server said it can do, which is not known yet.
      thumbnailUrl: (entry, size) => this.#thumbnailUrl(entry, size),
      view: this.options.view,
      onOpen: (entry) => this.open(entry),
      onSelectionChange: (selection) => this.#onSelectionChange(selection),
      onContextMenu: (event, entry) => this.#openContextMenu(event, entry),
      onDropFiles: (files, destination) => this.#uploadFiles(files, destination),
      onDropEntries: (paths, destination) => this.#moveTo(paths, destination),
      onNavigateParent: () => this.navigateUp(),
    });

    this.breadcrumbs = el('nav.fsfm-crumbs', { 'aria-label': this.t('nav.pathLabel') });
    // Bound once, here rather than in the renderer: the crumbs are rebuilt on
    // every navigation and a listener added there would stack up.
    this.breadcrumbs.addEventListener('dblclick', (event) => {
      // Only the empty strip. A double click on a crumb or a button is two
      // clicks on that control, and it has to keep meaning what one click means.
      if (event.target.closest('button, input, a')) return;
      this.editPath();
    });

    const main = el('div.fsfm-main', {}, [
      this.breadcrumbs,
      this.fileList.element,
    ]);

    this.body = el('div.fsfm-body', {}, [
      this.options.showTree ? el('aside.fsfm-sidebar', {}, [this.tree.element]) : null,
      main,
    ].filter(Boolean));

    this.root.append(this.body);

    if (this.options.terminal) {
      this.#terminal = new Terminal({
        t: this.t,
        errorText: (err) => this.#errorText(err),
      errorText: (err) => this.#errorText(err),
        localeTag: this.#locale.tag,
        provider: this.provider,
        path: this.#currentPath,
        can: (action) => this.can(action),
        // `cd` moves the listing too: one place, two ways of getting there.
        onNavigate: (path) => this.navigate(path),
        onRefresh: () => this.refresh({ keepSelection: true }),
        onOpen: (entry) => this.open(entry),
        onDownload: (paths) => this.#triggerDownload(paths),
      });
      this.#terminalVisible = true;
      this.root.append(this.#terminal.element);
      this.#echoToTerminal();
    }

    if (this.options.showStatusBar) {
      this.status = el('div.fsfm-status');
      this.root.append(this.status);
    }

    this.overlay = el('div.fsfm-overlay', { hidden: true }, [el('div.fsfm-spinner')]);
    this.root.append(this.overlay);

    // A hidden input is the only reliable way to open the OS file picker.
    this.fileInput = el('input', {
      type: 'file',
      multiple: true,
      hidden: true,
      on: {
        change: () => {
          const files = this.fileInput.files;
          if (files?.length) this.#uploadFiles(files, this.#currentPath);
          // Reset so picking the same file twice in a row still fires change.
          this.fileInput.value = '';
        },
      },
    });
    this.root.append(this.fileInput);

    this.#onRootKeyDown = (event) => this.#handleShortcut(event);
    this.root.addEventListener('keydown', this.#onRootKeyDown);
  }

  #buildToolbar() {
    const buttons = new Map();

    // Every action is an icon with its name in the tooltip. With twenty-one of
    // them the labels would wrap the toolbar onto three rows and leave no room
    // for the file list; as icons they fit one line, which is what makes
    // carrying the whole context menu here possible at all.
    const make = (id, label, iconName, onClick, extra = {}) => {
      const button = el('button.fsfm-tool.fsfm-tool-icon-only', {
        type: 'button',
        title: extra.title ?? label,
        'aria-label': label,
        dataset: { action: id },
        on: { click: onClick },
      }, [
        el('span.fsfm-tool-icon', { html: icon(iconName, 16) }),
        el('span.fsfm-tool-label', { text: label }),
      ]);
      buttons.set(id, button);
      return button;
    };

    const separator = () => el('span.fsfm-tool-separator', { role: 'separator' });

    /** How each action is built, looked up by id. */
    const t = this.t;
    const recipes = {
      newFolder: () => make('newFolder', t('action.newFolder'), 'folderPlus', () => this.createFolder()),
      newFile: () => make('newFile', t('action.newFile'), 'fileEarmarkPlus', () => this.createFile()),
      move: () => make('move', t('action.move'), 'arrowLeftRight', () => this.moveSelection()),
      copy: () => make('copy', t('action.copy'), 'clipboardCheck', () => this.copySelection()),
      rename: () => make('rename', t('action.rename'), 'pencilSquare', () => this.renameSelection(), { title: t('action.renameKey') }),
      delete: () => make('delete', t('action.delete'), 'trashFill', () => this.deleteSelection(), { title: t('action.deleteKey') }),
      download: () => make('download', t('action.download'), 'fileEarmarkArrowDown', () => this.downloadSelection()),
      upload: () => make('upload', t('action.upload'), 'fileEarmarkArrowUp', () => this.upload()),

      open: () => make('open', t('action.open'), 'caretRightFill', () => this.open()),
      preview: () => make('preview', t('action.preview'), 'eye', () => this.preview(), { title: t('action.previewKey') }),
      sheet: () => make('sheet', t('action.sheet'), 'fileEarmarkSpreadsheet', () => this.openSheet()),
      code: () => make('code', t('action.code'), 'pencilSquare', () => this.openCode()),
      document: () => make('document', t('action.document'), 'fileEarmarkText', () => this.openDocument()),
      compress: () => make('compress', t('action.compress'), 'fileEarmarkZip', () => this.compress()),
      extract: () => make('extract', t('action.extract'), 'boxArrowDown', () => this.extract()),
      archiveContents: () => make('archiveContents', t('action.archiveContents'), 'listUl', () => this.showArchiveContents()),
      // Reads the selection at click time, not at build time: the button is
      // made once and the entry under it changes.
      executable: () => make('executable', t('action.makeExecutable'), 'lightning', () => {
        const [entry] = this.getSelection();
        if (entry) this.setExecutable(!entry.executable);
      }),
      permissions: () => make('permissions', t('action.permissions'), 'shieldLock', () => this.editPermissions()),
      copyPath: () => make('copyPath', t('action.copyPath'), 'clipboard', () => this.copyPath()),
      properties: () => make('properties', t('action.properties'), 'infoCircle', () => this.showProperties(), { title: t('action.propertiesKey') }),
      selectAll: () => make('selectAll', t('action.selectAll'), 'checkAll', () => this.fileList.selectAll(), { title: t('action.selectAllKey') }),
    };

    const enabled = this.#resolveToolbarActions(this.options.toolbarActions);

    // Groups are emitted whole or not at all, and a separator only goes
    // between two that survived — otherwise a partial selection leaves the
    // toolbar starting or ending with a stray divider.
    const actionNodes = [];
    const groups = [];
    for (const group of TOOLBAR_GROUPS) {
      const present = group.filter((id) => enabled.has(id)).map((id) => recipes[id]());
      if (present.length === 0) continue;
      // The separator belongs to the group that follows it, so it can be
      // hidden along with that group when nothing in it applies.
      const divider = groups.length > 0 ? separator() : null;
      if (divider) actionNodes.push(divider);
      actionNodes.push(...present);
      groups.push({ buttons: present, separator: divider });
    }

    const element = el('div.fsfm-toolbar', { role: 'toolbar', 'aria-label': t('action.toolbarLabel') }, [
      ...actionNodes,
      // Secondary controls live in their own group pinned to the right. Kept
      // together they stay right-aligned even when the toolbar wraps, which a
      // plain flex spacer cannot do across lines.
      el('div.fsfm-toolbar-end', {}, [
        this.options.showSearch ? this.#buildSearch() : null,
        // Icon-only: these are secondary to the eight actions, and their
        // labels are what pushed the toolbar over one line.
        make('refresh', t('action.refresh'), 'arrowClockwise', () => this.refresh(), {
          title: t('action.refreshKey'),
          iconOnly: true,
        }),
        this.options.terminal ? this.#buildTerminalToggle() : null,
        this.#buildViewToggle(),
      ].filter(Boolean)),
    ].filter(Boolean));

    element.classList.toggle('fsfm-toolbar-bare', actionNodes.length === 0);
    return { element, buttons, groups };
  }

  /**
   * Turn the `toolbarActions` option into the set of ids to render.
   *
   * An unknown id is dropped with a warning rather than ignored silently: a
   * typo that makes a button quietly not appear is the kind of thing someone
   * spends an afternoon on.
   */
  #resolveToolbarActions(option) {
    if (option === true) return new Set(TOOLBAR_ACTIONS);
    if (!Array.isArray(option)) return new Set(); // false, null, undefined
    const chosen = new Set();
    for (const id of option) {
      if (TOOLBAR_ACTIONS.includes(id)) chosen.add(id);
      else {
        console.warn(
          `[bookmark-file-manager] unknown toolbar action: "${id}". ` +
            `Available: ${TOOLBAR_ACTIONS.join(', ')}`
        );
      }
    }
    return chosen;
  }

  #buildSearch() {
    this.searchInput = el('input.fsfm-search', {
      type: 'search',
      placeholder: this.t('nav.filter'),
      'aria-label': this.t('nav.filterTitle'),
      on: {
        input: () => {
          // Filtering rebuilds the listing, so running it on every keystroke
          // made a large folder re-render per character. One frame's pause is
          // below the threshold where typing feels laggy.
          clearTimeout(this.#filterTimer);
          this.#filterTimer = setTimeout(() => {
            this.fileList.setFilter(this.searchInput.value);
            this.#renderStatus();
          }, 120);
        },
        keydown: (event) => {
          // Enter escalates: the box has narrowed this folder and the user is
          // asking for the rest of the tree. Typing keeps filtering as before.
          if (event.key === 'Enter' && this.options.search) {
            event.preventDefault();
            this.openSearch(this.searchInput.value);
          }
        },
      },
    });

    const children = [this.searchInput];
    if (this.options.search) {
      children.push(
        el('button.fsfm-tool.fsfm-tool-icon-only.fsfm-search-all', {
          type: 'button',
          title: this.t('nav.searchAllKey'),
          'aria-label': this.t('nav.searchAll'),
          html: icon('search', 15),
          on: { click: () => this.openSearch(this.searchInput.value) },
        })
      );
    }
    return el('div.fsfm-search-wrap', {}, children);
  }

  #buildTerminalToggle() {
    this.terminalToggle = el('button.fsfm-tool.fsfm-tool-icon-only.fsfm-term-toggle', {
      type: 'button',
      html: icon('terminal', 15),
      'aria-pressed': 'true',
      title: this.t('nav.terminalKey'),
      // Names the thing, not the action: paired with `aria-pressed` that reads
      // as "Термінал, натиснуто". Flipping this to "Сховати термінал" instead would
      // announce "Сховати термінал, натиснуто", which contradicts itself.
      'aria-label': this.t('nav.terminal'),
      on: { click: () => this.toggleTerminal() },
    });
    return this.terminalToggle;
  }

  #buildViewToggle() {
    this.viewToggle = el('button.fsfm-tool.fsfm-tool-icon-only', {
      type: 'button',
      title: this.t('nav.viewToggleTitle'),
      'aria-label': this.t('nav.viewToggle'),
      on: {
        click: () => {
          const next = this.fileList.view === 'grid' ? 'list' : 'grid';
          this.setView(next);
        },
      },
    }, [el('span.fsfm-tool-icon')]);
    this.#syncViewToggle();
    return this.viewToggle;
  }

  #syncViewToggle() {
    if (!this.viewToggle) return;
    const grid = this.fileList?.view === 'grid';
    // Four squares for grid mode, stacked lines for list mode.
    const glyph = grid
      ? '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M1 2.5A1.5 1.5 0 0 1 2.5 1h3A1.5 1.5 0 0 1 7 2.5v3A1.5 1.5 0 0 1 5.5 7h-3A1.5 1.5 0 0 1 1 5.5zm8 0A1.5 1.5 0 0 1 10.5 1h3A1.5 1.5 0 0 1 15 2.5v3A1.5 1.5 0 0 1 13.5 7h-3A1.5 1.5 0 0 1 9 5.5zm-8 8A1.5 1.5 0 0 1 2.5 9h3A1.5 1.5 0 0 1 7 10.5v3A1.5 1.5 0 0 1 5.5 15h-3A1.5 1.5 0 0 1 1 13.5zm8 0A1.5 1.5 0 0 1 10.5 9h3a1.5 1.5 0 0 1 1.5 1.5v3a1.5 1.5 0 0 1-1.5 1.5h-3A1.5 1.5 0 0 1 9 13.5z"/></svg>'
      : '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M2.5 12a.5.5 0 0 1 .5-.5h10a.5.5 0 0 1 0 1H3a.5.5 0 0 1-.5-.5m0-4a.5.5 0 0 1 .5-.5h10a.5.5 0 0 1 0 1H3a.5.5 0 0 1-.5-.5m0-4a.5.5 0 0 1 .5-.5h10a.5.5 0 0 1 0 1H3a.5.5 0 0 1-.5-.5"/></svg>';
    this.viewToggle.querySelector('.fsfm-tool-icon').innerHTML = glyph;
  }

  // --------------------------------------------------------------- lifecycle

  async #initialize() {
    try {
      const config = await this.provider.config();
      this.#config = config ?? {};
      this.#archiveIndex = buildExtensionIndex(this.#config.archiveFormats);
      // An older server may report only readOnly; honour it either way. The
      // two sets are merged before being applied, because #applyPermissions
      // recomputes every key from scratch — applying readOnly as a second
      // call used to drop whatever the server said about `download`.
      const fromServer = config?.readOnly
        ? { ...(config?.permissions ?? {}), create: false, upload: false, move: false, copy: false, rename: false, remove: false }
        : config?.permissions;
      this.#applyPermissions(this.options.permissions, fromServer);
    } catch (err) {
      // A missing /config is not fatal; assume read-write and let the first
      // real operation report the true problem.
      this.emit('error', { error: err });
    }
    this.root.classList.toggle('fsfm-readonly', this.#readOnly);
    this.#syncToolbar();
    await this.tree.load();
    await this.navigate(this.#currentPath, { silent: true });
    this.emit('ready', { path: this.#currentPath, readOnly: this.#readOnly });
    return this;
  }

  /**
   * Mirror the widget's own operations into the terminal.
   *
   * This panel replaced an event log and keeps doing that work: what happened
   * belongs in the same place as what you typed, so the history of a session
   * reads as one thing whether it was done with the mouse or the keyboard.
   */
  #echoToTerminal() {
    if (!this.#terminal) return;
    const note = (text) => this.#terminal.note(text);

    const t = this.t;
    this.on('created', ({ entry }) => note(t('term.created', { path: entry.path })));
    this.on('renamed', ({ from, to }) =>
      note(t('term.echo.renamed', { from: from.path, to: to.name })));
    this.on('moved', ({ entries, destination }) =>
      note(t('term.echo.moved', { n: entries.length, path: destination })));
    this.on('copied', ({ entries, destination }) =>
      note(t('term.echo.copied', { n: entries.length, path: destination })));
    this.on('deleted', ({ paths }) => note(t('term.deleted', { path: paths.join(', ') })));
    this.on('uploaded', ({ entries, failures }) =>
      note(
        t('term.echo.uploaded', { n: entries.length }) +
          (failures.length ? t('term.echo.uploadFailed', { n: failures.length }) : '')
      ));
    this.on('chmod', ({ entries }) => note(t('term.echo.chmod', { n: entries.length })));
    this.on('archived', ({ archive }) => note(t('term.echo.archive', { path: archive.path })));
    this.on('extracted', ({ entry }) => note(t('term.echo.extracted', { path: entry.path })));
    this.on('codesaved', ({ entry }) => note(t('term.echo.saved', { path: entry.path })));
    this.on('sheetsaved', ({ entry }) => note(t('term.echo.saved', { path: entry.path })));
    this.on('documentsaved', ({ entry }) => note(t('term.echo.saved', { path: entry.path })));
    this.on('error', ({ message }) => {
      if (message) {
        this.#terminal.print([{ text: t('error.generic', { message }), tone: 'error' }]);
      }
    });
  }

  /** Remove the widget and every listener it installed. */
  destroy() {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#abort?.abort();
    clearTimeout(this.#filterTimer);
    this.#preview?.close();
    this.#sheetEditor?.close();
    this.#codeEditor?.close();
    this.#documentEditor?.close();
    // Cancels any dialog or viewer still on screen: removing this.root would otherwise
    // hide it while leaving its document-level listener bound and its promise
    // pending forever.
    closeDialogs(this.root);
    this.root.removeEventListener('keydown', this.#onRootKeyDown);
    this.menu.destroy();
    this.toasts.destroy();
    this.tree.destroy();
    this.fileList.destroy();
    this.clearListeners();
    this.root.remove();
  }

  // ------------------------------------------------------------- navigation

  get currentPath() {
    return this.#currentPath;
  }

  get readOnly() {
    return this.#readOnly;
  }

  /** Effective permissions after intersecting the host's set with the server's. */
  get permissions() {
    return { ...this.#permissions };
  }

  /** True when the named operation is available in this session. */
  can(action) {
    return this.#permissions[action] !== false;
  }

  /**
   * Intersect two permission sets. An operation is available only if neither
   * side withheld it, so a permissive client can never widen what the server
   * granted.
   */
  #applyPermissions(fromOptions, fromServer) {
    for (const key of PERMISSION_KEYS) {
      const host = fromOptions?.[key];
      const server = fromServer?.[key];
      this.#permissions[key] = host !== false && server !== false;
    }
    this.#readOnly = PERMISSION_KEYS.filter((key) => key !== 'download').every(
      (key) => !this.#permissions[key]
    );
  }

  getSelection() {
    return this.fileList.getSelection();
  }

  /**
   * Show a directory.
   * @param {string} path
   * @param {{silent?: boolean, select?: string[], keepSelection?: boolean}} [options]
   */
  async navigate(path, options = {}) {
    const target = path || '/';
    // A navigation in flight is stale the moment a new one starts.
    this.#abort?.abort();
    const controller = new AbortController();
    this.#abort = controller;

    this.#setBusy(true);
    try {
      const listing = await this.provider.list(target, controller.signal);
      if (controller.signal.aborted) return;
      this.#listing = listing;
      this.#currentPath = listing.path;
      // However the folder changed — a click, a crumb, `cd` — the prompt shows
      // where the manager actually is.
      this.#terminal?.setPath(listing.path);
      this.fileList.render(listing, {
        select: options.select,
        keepSelection: options.keepSelection,
      });
      this.#renderBreadcrumbs();
      this.#renderStatus();
      if (this.searchInput && !options.keepSelection) {
        this.searchInput.value = '';
        this.fileList.setFilter('');
      }
      await this.tree.reveal(listing.path);
      if (!options.silent) this.emit('navigate', { path: listing.path, listing });
    } catch (err) {
      if (err?.name === 'AbortError') return;
      this.#reportError(err, this.t('error.openFolder'));
      // Falling back to the root keeps the widget usable when the current
      // directory was deleted underneath it.
      if (err instanceof ProviderError && err.status === 404 && target !== '/') {
        await this.navigate('/', { silent: true });
      }
    } finally {
      if (this.#abort === controller) this.#abort = null;
      this.#setBusy(false);
    }
  }

  navigateUp() {
    if (this.#listing.parent === null) return Promise.resolve();
    return this.navigate(this.#listing.parent);
  }

  /**
   * Reload the current directory, the affected tree branches, and the toolbar.
   *
   * `treePaths` names any other folder the operation touched. They are
   * refreshed together with the current one in a single deduplicated batch —
   * callers used to refresh each branch themselves and then call this, which
   * cost three or four sequential round trips per operation.
   *
   * @param {{keepSelection?: boolean, select?: string[], treePaths?: string[]}} [options]
   */
  async refresh({ keepSelection = true, select, treePaths = [] } = {}) {
    await this.tree.refreshPaths([this.#currentPath, ...treePaths]);
    await this.navigate(this.#currentPath, { silent: true, keepSelection, select });
  }

  /** Open an entry: folders navigate, files preview or download. */
  open(entry) {
    if (!entry) return;
    this.emit('open', { entry });
    if (entry.isDirectory) {
      this.navigate(entry.path);
      return;
    }

    // A spreadsheet opens in the grid rather than downloading: that is the
    // whole point of having an editor for it.
    if (this.options.sheets && this.can('edit') && this.#sheetFormatOf(entry)) {
      this.openSheet(entry);
      return;
    }

    // Source and config files open in the code editor. Checked after the
    // spreadsheet branch so a .csv keeps going to the grid, which is the more
    // useful of the two views for it.
    if (this.options.code && this.can('edit') && this.#languageOf(entry)) {
      this.openCode(entry);
      return;
    }

    // Word and OpenDocument files open in the document editor. PDFs do not:
    // the viewer is the more useful default for them, and the page editor is
    // one context-menu entry away.
    if (
      this.options.documents &&
      this.can('edit') &&
      this.#documentFormatOf(entry) &&
      this.#documentFormatOf(entry) !== 'pdf'
    ) {
      this.openDocument(entry);
      return;
    }

    // Images and PDFs get the in-widget viewer, which keeps the user in the
    // folder they were browsing and lets the arrows page through it.
    if (this.options.preview && canPreview(entry)) {
      this.preview(entry);
      return;
    }

    const extension = entry.name.includes('.')
      ? entry.name.slice(entry.name.lastIndexOf('.') + 1).toLowerCase()
      : '';
    if (PREVIEWABLE.has(extension)) {
      window.open(this.provider.downloadUrl(entry.path, { inline: true }), '_blank', 'noopener');
    } else {
      this.#triggerDownload([entry.path]);
    }
  }

  /**
   * Open the viewer on one entry. The rest of the folder comes with it, so the
   * arrows can move between files without a round trip.
   *
   * @param {object} [entry] defaults to the current selection
   * @returns {boolean} false when nothing here can be previewed
   */
  preview(entry = this.getSelection()[0]) {
    if (!entry || !canPreview(entry)) return false;
    this.#preview?.close();
    this.#preview = openPreview({
      t: this.t,
      errorText: (err) => this.#errorText(err),
      localeTag: this.#locale.tag,
      container: this.root,
      provider: this.provider,
      entries: this.fileList.getVisible(),
      entry,
      canDownload: this.can('download'),
      // What the server said it can convert; the viewer explains itself rather
      // than showing a broken image for a format it cannot get pixels for.
      view: this.#config.imageView ?? null,
      onDownload: (item) => this.#triggerDownload([item.path]),
    });
    this.emit('preview', { entry });
    return true;
  }

  /**
   * URL for an entry's thumbnail, or null to fall back to the drawn icon.
   *
   * Returns null until /config has been read: asking a server that does not
   * serve thumbnails would put one 404 in the console per visible file.
   */
  #thumbnailUrl(entry, size) {
    if (!this.options.thumbnails || !this.#config.thumbnails) return null;
    if (!this.can('download')) return null;
    if (typeof this.provider.thumbnailUrl !== 'function') return null;
    const available = this.#config.thumbnailSizes;
    if (!Array.isArray(available) || available.length === 0) return null;
    // Smallest size that still covers the request, else the largest offered.
    const chosen = available.find((candidate) => candidate >= size) ?? available[available.length - 1];
    return this.provider.thumbnailUrl(entry.path, chosen);
  }

  setView(view) {
    this.fileList.setView(view);
    this.root.classList.toggle('fsfm-view-grid', view === 'grid');
    this.root.classList.toggle('fsfm-view-list', view === 'list');
    this.#syncViewToggle();
    this.emit('viewchange', { view });
  }

  // ------------------------------------------------------- toolbar action 1

  /** «Створити теку» */
  async createFolder() {
    if (this.#guard('create')) return null;
    const existing = new Set(this.fileList.getAll().map((entry) => entry.name.toLowerCase()));
    const name = await promptDialog({
      container: this.root,
      t: this.t,
      errorText: (err) => this.#errorText(err),
      title: this.t('action.newFolder'),
      label: this.t('prompt.newFolderLabel'),
      value: this.#suggestName(this.t('prompt.newFolderTitle'), existing),
      confirmText: this.t('common.create'),
      validate: (value) => this.#validateName(value, existing),
    });
    if (!name) return null;

    return this.#run(async () => {
      const created = await this.provider.createDirectory(this.#currentPath, name);
      await this.refresh({ select: [created.path] });
      this.toasts.success(this.t('toast.folderCreated', { name: created.name }));
      this.emit('created', { entry: created });
      return created;
    }, this.t('error.createFolder'));
  }

  // ------------------------------------------------------- toolbar action 2

  /** «Створити файл» */
  async createFile() {
    if (this.#guard('create')) return null;
    const existing = new Set(this.fileList.getAll().map((entry) => entry.name.toLowerCase()));
    const name = await promptDialog({
      container: this.root,
      t: this.t,
      errorText: (err) => this.#errorText(err),
      title: this.t('action.newFile'),
      label: this.t('prompt.newFileLabel'),
      value: this.#suggestName(this.t('prompt.newFileTitle'), existing),
      confirmText: this.t('common.create'),
      hint: this.t('prompt.newFileHint'),
      validate: (value) => this.#validateName(value, existing),
    });
    if (!name) return null;

    return this.#run(async () => {
      const created = await this.provider.createFile(this.#currentPath, name, '');
      await this.refresh({ select: [created.path] });
      this.toasts.success(this.t('toast.fileCreated', { name: created.name }));
      this.emit('created', { entry: created });
      return created;
    }, this.t('error.createFile'));
  }

  // ------------------------------------------------------- toolbar action 3

  /** «Перемістити» */
  async moveSelection() {
    if (this.#guard('move')) return null;
    const selection = this.getSelection();
    if (!this.#requireSelection(selection)) return null;

    const destination = await folderPickerDialog({
      t: this.t,
      errorText: (err) => this.#errorText(err),
      container: this.root,
      provider: this.provider,
      t: this.t,
      errorText: (err) => this.#errorText(err),
      title: this.t('prompt.moveTitle', { what: this.#describe(selection) }),
      confirmText: this.t('action.move'),
      currentPath: this.#currentPath,
      // A folder cannot land inside itself, and moving into the folder the
      // items already sit in would be a no-op.
      disabledPaths: selection.filter((entry) => entry.isDirectory).map((entry) => entry.path),
      rootLabel: this.options.rootLabel,
    });
    if (!destination) return null;
    return this.#moveTo(selection.map((entry) => entry.path), destination);
  }

  async #moveTo(paths, destination) {
    if (this.#guard('move')) return null;
    if (paths.some((path) => destination === path || destination.startsWith(`${path}/`))) {
      this.toasts.error(this.t('error.moveIntoSelf'));
      return null;
    }
    const sources = [...new Set(paths.map((path) => parentPath(path)))];

    return this.#run(async () => {
      const moved = await this.provider.move(paths, destination);
      await this.refresh({ keepSelection: false, treePaths: [...sources, destination] });
      this.toasts.success(
        this.t('toast.moved', { n: this.t('count.items', { n: moved.length }) })
      );
      this.emit('moved', { entries: moved, destination });
      return moved;
    }, this.t('error.move'));
  }

  // ------------------------------------------------------- toolbar action 4

  /** «Копіювати» */
  async copySelection() {
    if (this.#guard('copy')) return null;
    const selection = this.getSelection();
    if (!this.#requireSelection(selection)) return null;

    const destination = await folderPickerDialog({
      t: this.t,
      errorText: (err) => this.#errorText(err),
      container: this.root,
      provider: this.provider,
      t: this.t,
      errorText: (err) => this.#errorText(err),
      title: this.t('prompt.copyTitle', { what: this.#describe(selection) }),
      confirmText: this.t('action.copy'),
      currentPath: this.#currentPath,
      disabledPaths: selection.filter((entry) => entry.isDirectory).map((entry) => entry.path),
      rootLabel: this.options.rootLabel,
    });
    if (!destination) return null;

    const paths = selection.map((entry) => entry.path);
    return this.#run(async () => {
      const copied = await this.provider.copy(paths, destination);
      await this.refresh({
        treePaths: [destination],
        keepSelection: false,
        // Copying into the current folder should reveal the new items.
        select: destination === this.#currentPath ? copied.map((entry) => entry.path) : undefined,
      });
      this.toasts.success(
        this.t('toast.copied', { n: this.t('count.items', { n: copied.length }) })
      );
      this.emit('copied', { entries: copied, destination });
      return copied;
    }, this.t('error.copy'));
  }

  // ------------------------------------------------------- toolbar action 5

  /** «Перейменувати» */
  async renameSelection() {
    if (this.#guard('rename')) return null;
    const selection = this.getSelection();
    if (selection.length !== 1) {
      this.toasts.error(this.t('error.renameOne'));
      return null;
    }
    const entry = selection[0];
    const existing = new Set(
      this.fileList
        .getAll()
        .filter((item) => item.path !== entry.path)
        .map((item) => item.name.toLowerCase())
    );

    const name = await promptDialog({
      container: this.root,
      t: this.t,
      errorText: (err) => this.#errorText(err),
      title: this.t('action.rename'),
      label: entry.isDirectory ? this.t('prompt.renameFolder') : this.t('prompt.renameFile'),
      value: entry.name,
      confirmText: this.t('action.rename'),
      validate: (value) => this.#validateName(value, existing),
    });
    if (!name || name === entry.name) return null;

    return this.#run(async () => {
      const renamed = await this.provider.rename(entry.path, name);
      await this.refresh({ select: [renamed.path] });
      this.toasts.success(this.t('toast.renamed', { name: renamed.name }));
      this.emit('renamed', { from: entry, to: renamed });
      return renamed;
    }, this.t('error.rename'));
  }

  // ------------------------------------------------------- toolbar action 6

  /** «Видалити» */
  async deleteSelection() {
    if (this.#guard('remove')) return null;
    const selection = this.getSelection();
    if (!this.#requireSelection(selection)) return null;

    const folders = selection.filter((entry) => entry.isDirectory).length;
    if (this.options.confirmDelete) {
      const confirmed = await confirmDialog({
        container: this.root,
        t: this.t,
        errorText: (err) => this.#errorText(err),
      errorText: (err) => this.#errorText(err),
        title: this.t('prompt.deleteTitle'),
        message:
          selection.length === 1
            ? this.t('prompt.deleteOne', { name: selection[0].name })
            : this.t('prompt.deleteMany', {
                n: this.t('count.items', { n: selection.length }),
              }) + (folders ? this.t('prompt.deleteFolderNote') : ''),
        detail: selection.length > 1 ? selection.map((entry) => entry.name) : [],
        confirmText: this.t('common.delete'),
      });
      if (!confirmed) return null;
    }

    const paths = selection.map((entry) => entry.path);
    return this.#run(async () => {
      const result = await this.provider.remove(paths);
      await this.refresh({ keepSelection: false });
      this.toasts.success(
        this.t('toast.deleted', { n: this.t('count.items', { n: paths.length }) })
      );
      this.emit('deleted', { paths: result?.removed ?? paths });
      return result;
    }, this.t('error.delete'));
  }

  // ------------------------------------------------------- toolbar action 7

  /** «Завантажити на пристрій» */
  downloadSelection() {
    const selection = this.getSelection();
    if (!this.#requireSelection(selection)) return;
    this.#triggerDownload(selection.map((entry) => entry.path));
    const zipped = selection.length > 1 || selection[0].isDirectory;
    this.toasts.success(
      zipped ? this.t('toast.archiving') : this.t('toast.downloading', { name: selection[0].name })
    );
    this.emit('download', { entries: selection, asArchive: zipped });
  }

  /**
   * Start a download without navigating away. A temporary anchor is used
   * rather than location.href so the current page keeps its state and the
   * server's Content-Disposition decides the filename.
   */
  #triggerDownload(paths) {
    const link = el('a', {
      href: this.provider.downloadUrl(paths),
      download: '',
      rel: 'noopener',
      hidden: true,
    });
    this.root.append(link);
    link.click();
    // The click has already started the navigation; the node can go.
    setTimeout(() => link.remove(), 0);
  }

  // ------------------------------------------------------- toolbar action 8

  /** «Завантажити» — opens the OS picker; drag & drop calls #uploadFiles directly. */
  upload() {
    if (this.#guard('upload')) return;
    this.fileInput.click();
  }

  async #uploadFiles(files, destination = this.#currentPath) {
    if (this.#guard('upload')) return null;
    const list = Array.from(files);
    if (list.length === 0) return null;

    const limit = this.#config.maxUploadSize ?? 0;
    if (limit > 0) {
      const tooBig = list.filter((file) => file.size > limit);
      if (tooBig.length) {
        this.toasts.error(
          this.t('error.uploadTooBig', {
            limit: formatBytes(limit, this.t),
            names: tooBig.map((file) => file.name).join(', '),
          })
        );
        if (tooBig.length === list.length) return null;
      }
    }
    const accepted = limit > 0 ? list.filter((file) => file.size <= limit) : list;
    const totalBytes = accepted.reduce((sum, file) => sum + file.size, 0);

    const controller = new AbortController();
    const dialog = progressDialog({
      t: this.t,
      errorText: (err) => this.#errorText(err),
      container: this.root,
      t: this.t,
      errorText: (err) => this.#errorText(err),
      title: this.t('toast.uploading', { n: this.t('count.files', { n: accepted.length }) }),
      onCancel: () => controller.abort(),
    });

    try {
      const result = await this.provider.upload(destination, accepted, {
        signal: controller.signal,
        onProgress: (fraction, loaded) => {
          dialog.setProgress(
            fraction,
            this.t('toast.uploadProgress', {
              loaded: formatBytes(loaded, this.t),
              total: formatBytes(totalBytes, this.t),
            })
          );
        },
      });
      dialog.close();

      const uploaded = result?.uploaded ?? [];
      const failures = result?.failures ?? [];
      await this.refresh({
        keepSelection: false,
        treePaths: [destination],
        select: destination === this.#currentPath ? uploaded.map((entry) => entry.path) : undefined,
      });

      if (uploaded.length) {
        this.toasts.success(
          this.t('toast.uploaded', { n: this.t('count.files', { n: uploaded.length }) })
        );
      }
      for (const failure of failures) {
        this.toasts.error(
          this.t('toast.uploadFailedOne', {
            name: failure.name || this.t('common.fileCap'),
            message: failure.message,
          })
        );
      }
      this.emit('uploaded', { entries: uploaded, failures, destination });
      return result;
    } catch (err) {
      dialog.close();
      if (err?.name === 'AbortError') {
        this.toasts.show(this.t('error.uploadAborted'));
        await this.refresh({ keepSelection: false });
        return null;
      }
      this.#reportError(err, this.t('error.upload'));
      return null;
    }
  }

  #handleDropOn(destination, dataTransfer) {
    if (dataTransfer.types.includes('Files') && dataTransfer.files.length) {
      this.#uploadFiles(dataTransfer.files, destination);
      return;
    }
    const raw = dataTransfer.getData(INTERNAL_DRAG_TYPE);
    if (!raw) return;
    try {
      const paths = JSON.parse(raw);
      if (Array.isArray(paths) && paths.length) this.#moveTo(paths, destination);
    } catch {
      // Not our payload.
    }
  }

  // ------------------------------------------------------------ paths

  /**
   * Put a path on the clipboard.
   *
   * Always the *virtual* path — the one the widget and the API speak in. The
   * server's absolute path is deliberately never sent to the browser, so it is
   * not something this could copy even if it wanted to.
   *
   * @param {string|string[]|object|object[]} [target] paths, entries, or the
   *   current selection when omitted
   */
  async copyPath(target = this.getSelection()) {
    const list = (Array.isArray(target) ? target : [target])
      .map((item) => (typeof item === 'string' ? item : item?.path))
      .filter(Boolean);

    if (list.length === 0) {
      this.toasts.error(this.t('error.selectFirst'));
      return null;
    }

    // Several paths go one per line, which is what pastes usefully into a
    // terminal or an editor.
    const text = list.join('\n');
    const copied = await copyToClipboard(text);
    if (!copied) {
      this.toasts.error(this.t('error.clipboard'));
      return null;
    }

    this.toasts.success(
      list.length === 1
        ? this.t('toast.pathCopied', { path: list[0] })
        : this.t('toast.pathsCopied', { n: list.length })
    );
    this.emit('pathcopied', { paths: list, text });
    return text;
  }

  // ------------------------------------------------------------------ код

  /** The language this entry would open as, or null when it is not text. */
  #languageOf(entry) {
    if (!entry || entry.isDirectory) return null;
    return languageOf(entry.name);
  }

  /**
   * Open a text file in the code editor.
   * @param {object} [entry] defaults to the current selection
   */
  async openCode(entry = this.getSelection()[0]) {
    if (this.#guard('edit')) return null;
    if (!entry || entry.isDirectory) {
      this.toasts.error(this.t('error.selectFile'));
      return null;
    }

    this.#setBusy(true);
    let document_;
    try {
      document_ = await this.provider.readText(entry.path);
    } catch (err) {
      this.#reportError(err, this.t('error.openFile'));
      return null;
    } finally {
      this.#setBusy(false);
    }

    this.#codeEditor?.close();
    this.#codeEditor = openCodeEditor({
      t: this.t,
      errorText: (err) => this.#errorText(err),
      container: this.root,
      entry,
      document: document_,
      canSave: this.can('edit'),
      onSave: async (text) => {
        const result = await this.provider.saveText(entry.path, text, {
          // Written back the way it arrived: re-encoding a file or flipping
          // its line endings turns a one-line edit into a whole-file diff.
          encoding: document_.encoding,
          bom: document_.bom,
          newline: document_.newline,
        });
        await this.refresh({ keepSelection: true });
        this.emit('codesaved', { entry, result });
        return result;
      },
    });
    this.emit('codeopen', { entry, document: document_ });
    return document_;
  }

  // ----------------------------------------------------------- spreadsheets

  /** The spreadsheet format this entry is, or null. */
  #sheetFormatOf(entry) {
    if (!entry || entry.isDirectory) return null;
    const name = entry.name.toLowerCase();
    for (const [id, spec] of Object.entries(this.#config.sheetFormats ?? {})) {
      if ((spec.extensions ?? []).some((extension) => name.endsWith(`.${extension}`))) return id;
    }
    return null;
  }

  /**
   * Open a spreadsheet in the grid editor.
   * @param {object} [entry] defaults to the current selection
   */
  async openSheet(entry = this.getSelection()[0]) {
    if (this.#guard('edit')) return null;
    if (!entry || !this.#sheetFormatOf(entry)) {
      this.toasts.error(this.t('error.selectSheet'));
      return null;
    }

    this.#setBusy(true);
    let workbook;
    try {
      workbook = await this.provider.readSheet(entry.path);
    } catch (err) {
      this.#reportError(err, this.t('error.openSheet'));
      return null;
    } finally {
      this.#setBusy(false);
    }

    this.#sheetEditor?.close();
    this.#sheetEditor = openSheetEditor({
      t: this.t,
      errorText: (err) => this.#errorText(err),
      container: this.root,
      entry,
      workbook,
      formats: this.#config.sheetFormats,
      canSave: this.can('edit'),
      onSave: async (edited) => {
        const result = await this.provider.saveSheet(entry.path, edited);
        await this.refresh({ keepSelection: true });
        this.emit('sheetsaved', { entry, result });
        return result;
      },
    });
    this.emit('sheetopen', { entry, workbook });
    return workbook;
  }

  // ------------------------------------------------------------ адресний рядок

  /**
   * Turn the crumbs into a box the path can be typed into.
   *
   * Opened by a double click on the empty part of the crumb bar, which is
   * where every file manager puts it. `Enter` goes there, `Escape` and a click
   * elsewhere put the crumbs back.
   *
   * The path is checked *before* navigating rather than by navigating: a failed
   * navigation falls back to the root, and a typo throwing the user out of the
   * folder they were in is worse than being told the path is wrong.
   *
   * @returns {HTMLInputElement|null}
   */
  editPath() {
    if (!this.breadcrumbs) return null;
    if (this.#pathInput) {
      this.#pathInput.focus();
      this.#pathInput.select();
      return this.#pathInput;
    }

    const input = el('input.fsfm-crumbs-input', {
      type: 'text',
      value: this.#currentPath,
      spellcheck: false,
      autocomplete: 'off',
      autocapitalize: 'off',
      autocorrect: 'off',
      'aria-label': this.t('nav.pathPrompt'),
    });
    const problem = el('span.fsfm-crumbs-error', { hidden: true, role: 'alert' });

    clear(this.breadcrumbs);
    this.breadcrumbs.append(input, problem);
    this.breadcrumbs.classList.add('is-editing');
    this.#pathInput = input;
    input.focus();
    input.select();

    // Set while the path is being checked, so a blur caused by the request
    // rather than by the user does not abandon the edit.
    let submitting = false;

    const restore = () => {
      if (submitting || this.#pathInput !== input) return;
      this.#pathInput = null;
      this.breadcrumbs.classList.remove('is-editing');
      this.#renderBreadcrumbs();
    };

    const submit = async () => {
      // Relative paths, `..` and `~` all work, the same way they do in the
      // terminal — it is the same resolver.
      const target = resolvePath(this.#currentPath, input.value.trim() || '/');

      // `readOnly`, not `disabled`: disabling a focused element blurs it, and
      // the blur handler below would tear the box down along with the error
      // message it was about to show.
      submitting = true;
      input.readOnly = true;
      problem.hidden = true;
      let entry;
      try {
        entry = await this.provider.stat(target);
      } catch (err) {
        submitting = false;
        input.readOnly = false;
        problem.textContent = this.#errorText(err) || this.t('nav.pathNotFound');
        problem.hidden = false;
        input.focus();
        input.select();
        return;
      }

      submitting = false;
      this.#pathInput = null;
      this.breadcrumbs.classList.remove('is-editing');
      // A file is a perfectly reasonable thing to paste in; go to its folder
      // and select it rather than refusing on a technicality.
      if (entry.isDirectory) await this.navigate(target);
      else await this.reveal(entry);
      this.emit('pathedit', { path: entry.isDirectory ? target : parentPath(target), entry });
    };

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void submit();
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        restore();
        this.fileList.focus();
      }
    });

    // Abandoned on blur, never committed: navigating because the pointer
    // landed somewhere else is the one thing an address bar must not do. The
    // timeout lets a click on the bar's own contents settle first.
    input.addEventListener('blur', () => {
      setTimeout(restore, 0);
    });

    return input;
  }

  // -------------------------------------------------------------- terminal

  /** The terminal panel, or null when the option is off. */
  get terminal() {
    return this.#terminal;
  }

  /** Whether the panel is on screen. */
  get terminalVisible() {
    return this.#terminalVisible;
  }

  /**
   * Show or hide the terminal.
   *
   * @param {boolean} [visible] omitted flips it
   */
  toggleTerminal(visible = !this.#terminalVisible) {
    if (!this.#terminal) return false;
    this.#terminalVisible = Boolean(visible);
    this.#terminal.element.hidden = !this.#terminalVisible;

    // Only the state changes; the name stays the name.
    this.terminalToggle?.setAttribute('aria-pressed', String(this.#terminalVisible));
    // Showing it without putting the caret in it means the next thing typed
    // goes somewhere else, which is never what opening a terminal is for.
    if (this.#terminalVisible) this.#terminal.focus();
    this.emit('terminaltoggle', { visible: this.#terminalVisible });
    return this.#terminalVisible;
  }

  /**
   * Print a line in the terminal, if there is one.
   * @param {string} text
   */
  termNote(text) {
    this.#terminal?.note(text);
  }

  // ---------------------------------------------------------------- search

  /**
   * Search the whole tree below the current folder.
   *
   * Separate from the toolbar's filter box, which narrows what is already on
   * screen. This walks the filesystem: it can take seconds, it returns things
   * from folders the user is not looking at, and it can look inside files.
   *
   * @param {string} [query] prefill for the dialog
   * @param {{path?: string}} [options] where to start; defaults to the current folder
   */
  openSearch(query = '', { path = this.currentPath } = {}) {
    if (!this.options.search) return null;

    this.#searchDialog?.close();
    this.#searchDialog = openSearchDialog({
      t: this.t,
      errorText: (err) => this.#errorText(err),
      localeTag: this.#locale.tag,
      container: this.root,
      path,
      query: String(query ?? '').trim(),
      capabilities: this.#config.search ?? {},
      icons: {
        iconBasePath: this.options.iconBasePath,
        customize: this.options.customizeThumbnail,
      },
      onSearch: async (options, signal) => {
        const result = await this.provider.search(path, options, signal);
        this.emit('search', { path, options, result });
        return result;
      },
      // A result is somewhere else, so "show me" means going there and
      // selecting it — the file stays findable after the dialog closes.
      onReveal: (entry) => this.reveal(entry),
      onOpen: (entry) => {
        if (entry.isDirectory) this.navigate(entry.path);
        else this.reveal(entry).then(() => this.open(entry));
      },
    });
    return this.#searchDialog;
  }

  /**
   * Navigate to whatever folder holds an entry and select it there.
   * @param {object} entry
   */
  async reveal(entry) {
    const folder = entry.isDirectory ? parentPath(entry.path) : (entry.parent ?? parentPath(entry.path));
    if (folder !== this.currentPath) await this.navigate(folder);
    this.fileList.selectPaths([entry.path]);
    this.fileList.focus();
    this.emit('reveal', { entry });
    return entry;
  }

  // ------------------------------------------------------------- documents

  /** The document format this entry is, or null. */
  #documentFormatOf(entry) {
    if (!entry || entry.isDirectory) return null;
    const name = entry.name.toLowerCase();
    for (const [id, spec] of Object.entries(this.#config.documentFormats ?? {})) {
      if ((spec.extensions ?? []).some((extension) => name.endsWith(`.${extension}`))) return id;
    }
    return null;
  }

  /**
   * Open a document.
   *
   * docx, odt and doc open as rich text; a PDF opens as its pages. Which of
   * the two the pane shows is decided by the server's answer, not by the
   * extension, so a mislabelled file still lands in the right editor.
   *
   * @param {object} [entry] defaults to the current selection
   */
  async openDocument(entry = this.getSelection()[0]) {
    if (this.#guard('edit')) return null;
    if (!entry || !this.#documentFormatOf(entry)) {
      this.toasts.error(this.t('error.selectDocument'));
      return null;
    }

    this.#setBusy(true);
    let document_;
    try {
      document_ = await this.provider.readDocument(entry.path);
    } catch (err) {
      this.#reportError(err, this.t('error.openDocument'));
      return null;
    } finally {
      this.#setBusy(false);
    }

    this.#documentEditor?.close();
    this.#documentEditor = openDocumentEditor({
      t: this.t,
      errorText: (err) => this.#errorText(err),
      container: this.root,
      entry,
      document: document_,
      formats: this.#config.documentFormats,
      canSave: this.can('edit'),
      onSave: async (edited) => {
        const result = await this.provider.saveDocument(entry.path, edited);
        await this.refresh({ keepSelection: true });
        this.emit('documentsaved', { entry, result });
        return result;
      },
      onPages: async (plan, options) => {
        const result = await this.provider.saveDocumentPages(entry.path, plan, options);
        await this.refresh({ keepSelection: true });
        this.emit('documentsaved', { entry, result });
        return result;
      },
      onRead: (path) => this.provider.readDocument(path),
      onAskPath: (message, value) =>
        promptDialog({
          t: this.t,
          errorText: (err) => this.#errorText(err),
        errorText: (err) => this.#errorText(err),
      errorText: (err) => this.#errorText(err),
          container: this.root,
          title: message,
          label: this.t('nav.pathLabel'),
          // A suggested name is offered inside the folder being browsed; with
          // nothing suggested the folder itself is the starting point.
          value: value
            ? `${this.currentPath.replace(/\/+$/, '')}/${value}`
            : this.currentPath,
          hint: this.t('prompt.pathHint'),
          confirmText: this.t('common.done'),
        }),
    });
    this.emit('documentopen', { entry, document: document_ });
    return document_;
  }

  // -------------------------------------------------------------- archives

  /** True when this entry's name matches a format the server can unpack. */
  #archiveFormatOf(entry) {
    if (!entry || entry.isDirectory) return null;
    const id = archiveFormatOf(entry.name, this.#archiveIndex);
    if (!id) return null;
    return this.#config.archiveFormats?.[id]?.read ? id : null;
  }

  /**
   * Pack the selection into a new archive.
   * @param {object[]} [selection] defaults to the current selection
   */
  async compress(selection = this.getSelection()) {
    if (this.#guard('archive')) return null;
    if (!this.#requireSelection(selection)) return null;

    const base =
      selection.length === 1
        ? selection[0].name.replace(/\.[^.]+$/, '') || selection[0].name
        : this.#currentPath === '/'
          ? 'archive'
          : this.#currentPath.slice(this.#currentPath.lastIndexOf('/') + 1);

    const choice = await archiveDialog({
      t: this.t,
      errorText: (err) => this.#errorText(err),
      container: this.root,
      formats: this.#config.archiveFormats,
      selection,
      suggestedBase: base,
    });
    if (!choice) return null;

    const paths = selection.map((entry) => entry.path);
    return this.#run(async () => {
      const created = await this.provider.createArchive(paths, {
        format: choice.format,
        destination: this.#currentPath,
        name: choice.name,
      });
      await this.refresh({ select: [created.path] });
      this.toasts.success(
        this.t('toast.archiveCreated', {
          name: created.name,
          size: formatBytes(created.size, this.t),
        })
      );
      this.emit('archived', { entries: selection, archive: created, format: choice.format });
      return created;
    }, this.t('error.createArchive'));
  }

  /**
   * Unpack one archive beside itself.
   * @param {object} [entry] defaults to the current selection
   */
  async extract(entry = this.getSelection()[0]) {
    if (this.#guard('extract')) return null;
    if (!entry) {
      this.toasts.error(this.t('error.selectArchive'));
      return null;
    }
    if (!this.#archiveFormatOf(entry)) {
      this.toasts.error(this.t('error.notArchive', { name: entry.name }));
      return null;
    }

    return this.#run(async () => {
      const result = await this.provider.extract(entry.path);
      await this.refresh({ select: [result.path] });

      const files = this.t('count.files', { n: result.written });
      this.toasts.success(
        this.t('toast.extracted', { files, name: result.entry?.name ?? result.path })
      );
      // Entries refused by the extractor are reported rather than dropped: a
      // silent partial extraction is how a traversal attempt goes unnoticed.
      if (result.skipped?.length) {
        const shown = result.skipped.slice(0, 3).map((item) => `${item.name} — ${item.reason}`);
        this.toasts.error(
          this.t('toast.extractSkipped', {
            n: result.skipped.length,
            detail: shown.join('; '),
          }) +
            (result.skipped.length > shown.length ? ' …' : '')
        );
      }
      this.emit('extracted', { entry, result });
      return result;
    }, this.t('error.extract'));
  }

  /** Show what an archive holds without writing anything. */
  async showArchiveContents(entry = this.getSelection()[0]) {
    if (this.#guard('extract')) return null;
    if (!entry || !this.#archiveFormatOf(entry)) {
      this.toasts.error(this.t('error.selectArchive'));
      return null;
    }
    this.#setBusy(true);
    let contents;
    try {
      contents = await this.provider.listArchive(entry.path);
    } catch (err) {
      this.#reportError(err, this.t('error.readArchive'));
      return null;
    } finally {
      this.#setBusy(false);
    }
    await archiveContentsDialog({ container: this.root, entry, contents, t: this.t, errorText: (err) => this.#errorText(err) });
    return contents;
  }

  // ------------------------------------------------ properties and access

  /**
   * Show everything the server knows about one entry.
   * @param {object} [entry] defaults to the current selection
   */
  async showProperties(entry = this.getSelection()[0]) {
    if (!entry) {
      this.toasts.error(this.t('error.selectFirst'));
      return null;
    }
    let requested = null;
    await propertiesDialog({
      t: this.t,
      errorText: (err) => this.#errorText(err),
      localeTag: this.#locale.tag,
      container: this.root,
      provider: this.provider,
      entry,
      // The properties dialog closes before this one opens: two stacked modals
      // over a widget that may itself be in a modal is one too many.
      onEditMode: (details) => {
        requested = details;
      },
    });
    if (requested) return this.editPermissions(entry, requested);
    return null;
  }

  /**
   * Open the permissions editor for one entry and apply what it returns.
   * @param {object} [entry] defaults to the current selection
   * @param {object} [details] already-fetched properties, to skip a round trip
   */
  async editPermissions(entry = this.getSelection()[0], details = null) {
    if (this.#guard('chmod')) return null;
    if (!entry) {
      this.toasts.error(this.t('error.selectFirst'));
      return null;
    }

    let resolved = details;
    if (!resolved) {
      try {
        resolved = await this.provider.properties(entry.path);
      } catch (err) {
        this.#reportError(err, this.t('error.readPermissions'));
        return null;
      }
    }

    const change = await permissionsDialog({ container: this.root, details: resolved, t: this.t, errorText: (err) => this.#errorText(err) });
    if (!change) return null;

    return this.#run(async () => {
      const [updated] = await this.provider.chmod([entry.path], change);
      await this.refresh({ select: [entry.path] });
      this.toasts.success(
        this.t('toast.permissionsChanged', {
          name: entry.name,
          octal: updated.modeOctal,
          text: updated.modeText,
        })
      );
      this.emit('chmod', { entry, mode: updated.modeOctal, entries: [updated] });
      return updated;
    }, this.t('error.changePermissions'));
  }

  /**
   * Add or remove the execute bit on the selection.
   *
   * Adding follows the read bits, so a file readable only by its owner becomes
   * executable only by its owner — the shortcut never widens access, only what
   * may be done with the access that already exists.
   *
   * @param {boolean} executable
   * @param {object[]} [selection] defaults to the current selection
   */
  async setExecutable(executable, selection = this.getSelection()) {
    if (this.#guard('chmod')) return null;
    if (!this.#requireSelection(selection)) return null;

    const paths = selection.map((item) => item.path);
    return this.#run(async () => {
      const updated = await this.provider.chmod(paths, { executable });
      await this.refresh({ keepSelection: true });
      const shown = updated[0];
      this.toasts.success(
        selection.length === 1
          ? `«${shown.name}»: ${shown.modeOctal} (${shown.modeText})`
          : this.t(executable ? 'toast.madeExecutable' : 'toast.clearedExecutable', {
              n: updated.length,
            })
      );
      this.emit('chmod', { entries: updated, executable });
      return updated;
    }, this.t(executable ? 'error.makeExecutable' : 'error.clearExecutable'));
  }

  /** True when the manager may change permissions at all in this session. */
  #canChangeMode() {
    return this.can('chmod') && this.#config.chmodSupported !== false;
  }

  // ------------------------------------------------------------ UI plumbing

  #renderBreadcrumbs() {
    clear(this.breadcrumbs);

    // Pinned to the far end of the bar rather than sitting after the last
    // crumb: the crumbs grow and shrink with the path, and a button that moved
    // with them would never be where the pointer expects it.
    const copyButton = el('button.fsfm-crumb-copy', {
      type: 'button',
      title: this.t('nav.copyCurrentPath'),
      'aria-label': this.t('nav.copyCurrentPath'),
      html: icon('clipboard', 13),
      on: { click: () => this.copyPath(this.#currentPath) },
    });

    const upButton = el('button.fsfm-crumb-up', {
      type: 'button',
      title: this.t('nav.upKey'),
      'aria-label': this.t('nav.up'),
      disabled: this.#listing.parent === null,
      html: icon('arrowUp', 14),
      on: { click: () => this.navigateUp() },
    });
    this.breadcrumbs.append(upButton);

    const segments = pathSegments(this.#currentPath, this.options.rootLabel);
    segments.forEach((crumb, index) => {
      if (index > 0) {
        this.breadcrumbs.append(el('span.fsfm-crumb-sep', { html: icon('caretRightFill', 9) }));
      }
      const isLast = index === segments.length - 1;
      this.breadcrumbs.append(
        el('button.fsfm-crumb', {
          type: 'button',
          class: isLast ? 'is-current' : '',
          'aria-current': isLast ? 'page' : null,
          text: crumb.name,
          on: { click: () => !isLast && this.navigate(crumb.path) },
        })
      );
      // Every crumb is a drop target, so items can be moved up a level.
      const crumbNode = this.breadcrumbs.lastElementChild;
      crumbNode.addEventListener('dragover', (event) => {
        event.preventDefault();
        crumbNode.classList.add('is-drop-target');
      });
      crumbNode.addEventListener('dragleave', () => crumbNode.classList.remove('is-drop-target'));
      crumbNode.addEventListener('drop', (event) => {
        event.preventDefault();
        crumbNode.classList.remove('is-drop-target');
        this.#handleDropOn(crumb.path, event.dataTransfer);
      });
    });

    this.breadcrumbs.append(copyButton);
  }

  #onSelectionChange(selection) {
    this.#syncToolbar(selection);
    this.#renderStatus(selection);
    this.emit('selectionchange', { selection });
  }

  /**
   * What each toolbar action does with the current selection.
   *
   * Two different questions, deliberately kept apart:
   *
   *   `show`    — could this operation ever apply to what is selected? An
   *               archive-only action on a .txt, or an editor for a format
   *               this build does not handle, is not "temporarily off" — it is
   *               not part of the answer, and showing it greyed out forever
   *               only makes the toolbar harder to read.
   *   `enabled` — it applies, but not to *this* number of items. Those stay
   *               put and grey, because a button that appears and disappears
   *               as the count changes is a moving target for a finger.
   */
  #toolbarState(selection) {
    const count = selection.length;
    const one = count === 1 ? selection[0] : null;
    const file = one && !one.isDirectory ? one : null;
    const chmod = this.can('chmod') && this.#config.chmodSupported !== false;

    const always = (enabled = true) => ({ show: true, enabled });
    const gated = (permission, enabled = true) => ({ show: this.can(permission), enabled });

    return {
      newFolder: gated('create'),
      newFile: gated('create'),
      upload: gated('upload'),

      move: gated('move', count > 0),
      copy: gated('copy', count > 0),
      rename: gated('rename', count === 1),
      delete: gated('remove', count > 0),
      download: gated('download', count > 0),

      open: always(count === 1),
      preview: { show: Boolean(this.options.preview && one && canPreview(one)) },
      sheet: {
        show: Boolean(this.options.sheets && this.can('edit') && one && this.#sheetFormatOf(one)),
      },
      code: {
        show: Boolean(this.options.code && this.can('edit') && one && this.#languageOf(one)),
      },
      document: {
        show: Boolean(this.options.documents && this.can('edit') && one && this.#documentFormatOf(one)),
      },

      compress: gated('archive', count > 0),
      extract: { show: Boolean(this.can('extract') && one && this.#archiveFormatOf(one)) },
      archiveContents: { show: Boolean(this.can('extract') && one && this.#archiveFormatOf(one)) },

      // The execute bit means "may be entered" on a directory, not "may be
      // run", so the button is offered for files only.
      executable: { show: Boolean(chmod && file) },
      permissions: { show: chmod, enabled: count === 1 },

      copyPath: always(),
      properties: always(count === 1),
      selectAll: always(),
      refresh: always(),
    };
  }

  #syncToolbar(selection = this.getSelection()) {
    if (!this.toolbar) return;

    const state = this.#toolbarState(selection);
    for (const [action, button] of this.toolbar.buttons) {
      const rule = state[action] ?? { show: true };
      button.hidden = rule.show === false;
      button.disabled = rule.enabled === false;
    }

    // The label of this one is the action, and the action flips.
    const executable = this.toolbar.buttons.get('executable');
    if (executable) {
      const [entry] = selection;
      const label = this.t(entry?.executable ? 'action.clearExecutable' : 'action.makeExecutable');
      executable.title = label;
      executable.setAttribute('aria-label', label);
    }

    // A separator earns its place only between two groups that both have
    // something visible; otherwise a hidden group leaves a stray divider.
    let seenVisible = false;
    for (const group of this.toolbar.groups ?? []) {
      const visible = group.buttons.some((button) => !button.hidden);
      if (group.separator) group.separator.hidden = !visible || !seenVisible;
      seenVisible = seenVisible || visible;
    }
  }


  #renderStatus(selection = this.getSelection()) {
    if (!this.status) return;
    const visible = this.fileList.getVisible();
    const folders = visible.filter((entry) => entry.isDirectory).length;
    const files = visible.length - folders;
    const totalBytes = visible.reduce((sum, entry) => sum + (entry.size ?? 0), 0);

    const parts = [
      this.t('count.folders', { n: folders }),
      this.t('count.files', { n: files }),
    ];
    if (totalBytes > 0) parts.push(formatBytes(totalBytes, this.t));
    if (selection.length > 0) {
      const selectedBytes = selection.reduce((sum, entry) => sum + (entry.size ?? 0), 0);
      parts.push(
        this.t('status.selected', { n: selection.length }) +
          (selectedBytes > 0 ? ` (${formatBytes(selectedBytes, this.t)})` : '')
      );
    }
    if (this.#readOnly) parts.push(this.t('status.readOnlyBadge'));

    clear(this.status).append(
      el('span.fsfm-status-left', { text: parts.join(' · ') }),
      el('span.fsfm-status-right', { text: this.#currentPath })
    );
  }

  #openContextMenu(event, entry) {
    const selection = this.getSelection();
    const count = selection.length;
    const single = count === 1;

    // Items for operations that are withheld outright are left out entirely,
    // rather than listed permanently greyed out.
    const permitted = (action, item) => (this.can(action) ? item : null);
    const t = this.t;

    const items = (entry
      ? [
          { label: t(entry.isDirectory ? 'action.open' : 'menu.openOrDownload'), icon: icon('caretRightFill', 12), onSelect: () => this.open(entry) },
          this.options.preview && canPreview(entry)
            ? { label: t('action.preview'), shortcut: 'Space', onSelect: () => this.preview(entry) }
            : null,
          { separator: true },
          permitted('move', { label: t('menu.move'), icon: icon('arrowLeftRight', 12), disabled: count === 0, onSelect: () => this.moveSelection() }),
          permitted('copy', { label: t('menu.copy'), icon: icon('clipboardCheck', 12), disabled: count === 0, onSelect: () => this.copySelection() }),
          permitted('rename', { label: t('action.rename'), shortcut: 'F2', icon: icon('pencilSquare', 12), disabled: !single, onSelect: () => this.renameSelection() }),
          permitted('download', { label: t('action.download'), icon: icon('fileEarmarkArrowDown', 12), disabled: count === 0, onSelect: () => this.downloadSelection() }),
          { separator: true },
          permitted('remove', { label: t('common.delete'), shortcut: 'Del', icon: icon('trashFill', 12), danger: true, disabled: count === 0, onSelect: () => this.deleteSelection() }),
          { separator: true },
          this.options.sheets && this.can('edit') && this.#sheetFormatOf(entry)
            ? { label: t('action.sheet'), onSelect: () => this.openSheet(entry) }
            : null,
          this.options.code && this.can('edit') && this.#languageOf(entry)
            ? { label: t('action.code'), icon: icon('pencilSquare', 12), onSelect: () => this.openCode(entry) }
            : null,
          this.options.documents && this.can('edit') && this.#documentFormatOf(entry)
            ? {
                label: t(
                  this.#documentFormatOf(entry) === 'pdf' ? 'menu.pdfPages' : 'action.document'
                ),
                icon: icon('pencilSquare', 12),
                onSelect: () => this.openDocument(entry),
              }
            : null,
          this.can('archive')
            ? { label: t('action.compress'), onSelect: () => this.compress() }
            : null,
          this.can('extract') && this.#archiveFormatOf(entry)
            ? { label: t('action.extract'), onSelect: () => this.extract(entry) }
            : null,
          this.can('extract') && this.#archiveFormatOf(entry)
            ? { label: t('menu.archiveContents'), onSelect: () => this.showArchiveContents(entry) }
            : null,
          { separator: true },
          // Only offered for files: the execute bit on a directory means
          // "may be traversed", which is not what "make executable" suggests
          // and is not something to toggle from a one-click menu item.
          this.#canChangeMode() && !entry.isDirectory
            ? {
                label: t(entry.executable ? 'action.clearExecutable' : 'action.makeExecutable'),
                onSelect: () => this.setExecutable(!entry.executable),
              }
            : null,
          this.#canChangeMode()
            ? { label: t('action.permissions'), onSelect: () => this.editPermissions(entry) }
            : null,
          { label: t('action.copyPath'), icon: icon('clipboard', 12), onSelect: () => this.copyPath() },
          { label: t('action.properties'), shortcut: 'Alt+Enter', onSelect: () => this.showProperties(entry) },
        ]
      : [
          permitted('create', { label: t('action.newFolder'), icon: icon('folderPlus', 12), onSelect: () => this.createFolder() }),
          permitted('create', { label: t('action.newFile'), icon: icon('fileEarmarkPlus', 12), onSelect: () => this.createFile() }),
          permitted('upload', { label: t('menu.upload'), icon: icon('fileEarmarkArrowUp', 12), onSelect: () => this.upload() }),
          { separator: true },
          { separator: true },
          { label: t('menu.copyFolderPath'), icon: icon('clipboard', 12), onSelect: () => this.copyPath(this.#currentPath) },
          { label: t('action.selectAll'), shortcut: 'Ctrl+A', onSelect: () => this.fileList.selectAll() },
          { label: t('action.refresh'), shortcut: 'F5', icon: icon('arrowClockwise', 12), onSelect: () => this.refresh() },
        ]
    ).filter(Boolean);

    // Dropping items can leave a separator first, last, or doubled up.
    const cleaned = items.filter((item, index, list) => {
      if (!item.separator) return true;
      if (index === 0 || index === list.length - 1) return false;
      return !list[index - 1]?.separator;
    });

    this.menu.open(event.clientX, event.clientY, cleaned);
  }

  #handleShortcut(event) {
    const target = event.target;

    // Checked before the guards below on purpose: "find in files" is the one
    // shortcut whose whole point is being reachable from the search box, which
    // is exactly where the guard would stop it.
    if (
      (event.ctrlKey || event.metaKey) &&
      event.shiftKey &&
      event.key.toLowerCase() === 'f' &&
      this.options.search
    ) {
      event.preventDefault();
      this.openSearch(this.searchInput?.value ?? '');
      return;
    }

    // Same reasoning as above: the terminal's own input is the place people
    // press this from, and the guard below would swallow it.
    if ((event.ctrlKey || event.metaKey) && event.key === '`' && this.options.terminal) {
      event.preventDefault();
      this.toggleTerminal();
      return;
    }

    // Other shortcuts must not fire while the user is typing in the search box
    // or a dialog field.
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
    if (this.root.querySelector('.fsfm-backdrop')) return;

    // Select-all is handled by the list when the list has focus; catching it
    // here too makes the shortcut work right after using the toolbar, which is
    // where the pointer usually is.
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      if (this.fileList.element.contains(target)) return;
      event.preventDefault();
      this.fileList.selectAll();
      return;
    }

    switch (event.key) {
      case ' ': {
        // Space is the file-manager convention for "quick look".
        const selected = this.getSelection();
        if (selected.length === 1 && this.options.preview && canPreview(selected[0])) {
          event.preventDefault();
          this.preview(selected[0]);
        }
        break;
      }
      case 'Enter':
        // Alt+Enter is the long-standing shortcut for a properties sheet.
        if (event.altKey) {
          event.preventDefault();
          this.showProperties();
        }
        break;
      case 'F2':
        event.preventDefault();
        this.renameSelection();
        break;
      case 'F5':
        event.preventDefault();
        this.refresh();
        break;
      case 'Delete':
        event.preventDefault();
        this.deleteSelection();
        break;
      default:
        break;
    }
  }

  // ------------------------------------------------------------- primitives

  /** Run a mutating operation with the busy overlay and uniform error toasts. */
  async #run(operation, failureMessage) {
    this.#setBusy(true);
    try {
      return await operation();
    } catch (err) {
      this.#reportError(err, failureMessage);
      return null;
    } finally {
      this.#setBusy(false);
    }
  }

  #setBusy(busy) {
    this.#busyDepth = Math.max(0, this.#busyDepth + (busy ? 1 : -1));
    const active = this.#busyDepth > 0;
    this.overlay.hidden = !active;
    this.root.classList.toggle('is-busy', active);
  }

  /**
   * The sentence to show for an error.
   *
   * The server answers in English and cannot know what language this widget
   * speaks, so it sends a stable `code` and the values it interpolated. When
   * this language has a sentence for that code, it is used; otherwise the
   * server's own English text is shown, which is still an answer rather than
   * a blank. Errors raised inside the widget carry no code and pass straight
   * through — they were already written in the right language.
   */
  #errorText(err) {
    const code = err?.code;
    if (code) {
      const key = `srv.${code}`;
      const params = { ...(err.params ?? {}), status: err.status };
      // The server sends the permission key, not its English name, so the
      // operation is named in this language too.
      if (params.permission) params.operation = this.t(`op.${params.permission}`);
      const translated = this.t(key, params);
      if (translated !== key) return translated;
    }
    return err instanceof Error ? err.message : String(err ?? '');
  }

  #reportError(err, fallback) {
    const message = this.#errorText(err);
    this.toasts.error(message || fallback);
    this.emit('error', { error: err, message: message || fallback });
  }

  /** True when the operation is not permitted; also tells the user why. */
  #guard(action) {
    if (this.can(action)) return false;
    this.toasts.error(
      this.#readOnly
        ? this.t('error.readOnlyMode')
        : this.t('error.notAvailable')
    );
    return true;
  }

  #requireSelection(selection) {
    if (selection.length > 0) return true;
    this.toasts.error(this.t('error.selectFirst'));
    return false;
  }

  #describe(selection) {
    if (selection.length === 1) return selection[0].name;
    return this.t('count.items', { n: selection.length });
  }

  #validateName(value, existingLowercase) {
    if (INVALID_NAME.test(value)) return this.t('error.nameChars');
    if (value === '.' || value === '..') return this.t('error.nameInvalid');
    if (/[. ]$/.test(value)) return this.t('error.nameEnding');
    if (value.length > 255) return this.t('error.nameLong');
    if (existingLowercase?.has(value.toLowerCase())) return this.t('error.nameTaken');
    return null;
  }

  /** "Нова тека" -> "Нова тека (2)" when the plain name is taken. */
  #suggestName(base, existing) {
    if (!existing.has(base.toLowerCase())) return base;
    const dot = base.lastIndexOf('.');
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const extension = dot > 0 ? base.slice(dot) : '';
    for (let n = 2; n < 100; n += 1) {
      const candidate = `${stem} (${n})${extension}`;
      if (!existing.has(candidate.toLowerCase())) return candidate;
    }
    return base;
  }

  #onRootKeyDown = null;
}

export default FileManager;
