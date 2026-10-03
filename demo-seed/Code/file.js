// Imported the way a host imports it — `bookmark-file-manager/style.css`.
// Leaning on the entry point's own `import './styles.css'` looked equivalent
// and was not: the bundler treated it as a removable side effect and dropped
// it, so the demo ran with no stylesheet at all — which is what made the
// widget look as though it had no responsive layout.
import '../src/styles.css';
import { FileManager, LOCALES, icon } from '../src/index.js';

// The widget speaks English unless told otherwise; the demo starts there and
// offers the other four so the option can be seen working.
let locale = 'en';

let manager = mount({ showTree: true, view: 'grid', iconBasePath: null, toolbarActions: false });

function mount(options) {
  const host = document.getElementById('host');
  host.innerHTML = '';
  const instance = new FileManager(host, {
    endpoint: '/api/files',
    locale,
    ...options,
  });

  // What used to go to the log panel now goes to the widget's terminal, which
  // is what that panel became. The manager already echoes the operations it
  // performs, so only the demo's own notes are left here.
  const note = (message) => instance.termNote(message);
  instance.on('ready', ({ path, readOnly }) =>
    note(`ready: ${path}${readOnly ? ' (read-only)' : ''}`)
  );
  instance.on('download', ({ entries, asArchive }) =>
    note(`download ${entries.length}${asArchive ? ' (zip)' : ''}`)
  );

  return instance;
}

// Remounting is the honest way to show that a different option set works, and
// it exercises destroy() at the same time.
function remount(patch) {
  const previous = {
    showTree: manager.options.showTree,
    view: manager.fileList.view,
    iconBasePath: manager.options.iconBasePath,
    toolbarActions: manager.options.toolbarActions,
    initialPath: manager.currentPath,
    terminal: manager.options.terminal,
  };
  manager.destroy();
  manager = mount({ ...previous, ...patch });
  // The theme classes and the controls were on the old root and the old
  // toolbar, both of which destroy() took with it.
  applyTheme();
}

/**
 * The theme, and why it is three states rather than two.
 *
 * Toggling `fsfm-dark` alone is not enough: taking it off hands control back to
 * `prefers-color-scheme`, so on a machine that is in dark mode the light theme
 * could never be selected — the button appeared to do nothing all evening. The
 * stylesheet has `fsfm-light` for exactly this, and a choice has to set one of
 * the two classes, never neither.
 *
 * `auto` is kept as the starting state so the page still follows the system
 * until someone actually picks a side.
 */
let theme = 'auto';
const darkQuery = window.matchMedia?.('(prefers-color-scheme: dark)') ?? null;
const effectiveTheme = () => (theme === 'auto' ? (darkQuery?.matches ? 'dark' : 'light') : theme);

function applyTheme() {
  manager.root.classList.toggle('fsfm-dark', theme === 'dark');
  manager.root.classList.toggle('fsfm-light', theme === 'light');
  renderControls();
}

// While nobody has chosen, the system changing at sunset should still be
// followed — and the controls have to keep up with it.
darkQuery?.addEventListener('change', () => {
  if (theme === 'auto') applyTheme();
});

/**
 * The demo's own controls, as icons inside the widget's toolbar.
 *
 * They are rebuilt rather than mutated, because most of them change what they
 * mean when they are pressed — the theme button turns into its opposite, the
 * actions button walks through four states — and rebuilding keeps the icon,
 * the tooltip and the pressed state from ever disagreeing.
 */
function demoControls() {
  const dark = effectiveTheme() === 'dark';
  const actions = manager.options.toolbarActions;

  return [
    {
      icon: 'layoutSidebar',
      // The tooltip names what a press does, not what is on screen now.
      title: manager.options.showTree ? 'Hide the tree' : 'Show the tree',
      pressed: manager.options.showTree,
      onClick: () => remount({ showTree: !manager.options.showTree }),
    },
    {
      icon: dark ? 'sun' : 'moon',
      title: dark ? 'Light theme' : 'Dark theme',
      // Lit once a side has been picked, so "following the system" is visibly
      // a different state from "explicitly light".
      pressed: theme !== 'auto',
      onClick: () => {
        theme = dark ? 'light' : 'dark';
        applyTheme();
      },
    },
    {
      // '/icons' is the bundled artwork, copied from assets/ by Vite's publicDir.
      icon: 'palette',
      title: manager.options.iconBasePath ? 'Icons: drawn' : 'Icons: artwork',
      pressed: Boolean(manager.options.iconBasePath),
      onClick: () =>
        remount({ iconBasePath: manager.options.iconBasePath ? null : '/icons' }),
    },
    {
      // false -> all eight -> a named subset -> back to none, so the demo shows
      // every shape the option accepts.
      icon: 'menuButtonWide',
      title:
        actions === false
          ? 'Action buttons: show'
          : actions === true
            ? 'Action buttons: a subset'
            : 'Action buttons: hide',
      pressed: actions !== false,
      onClick: () =>
        remount({
          toolbarActions: actions === false ? true : actions === true ? ['upload', 'delete'] : false,
        }),
    },
    {
      icon: 'house',
      title: 'Go to the root',
      onClick: () => manager.navigate('/'),
    },
    {
      // Cycles through the shipped languages. Remounting is what a host would
      // do to change language at runtime, so the demo does the same.
      icon: 'translate',
      title: `Language: ${LOCALES[locale].name}`,
      onClick: () => {
        const ids = Object.keys(LOCALES);
        locale = ids[(ids.indexOf(locale) + 1) % ids.length];
        remount({});
      },
    },
    // The terminal's own show/hide button is built by the widget and already
    // sits in this toolbar, a few places to the right. A second one here would
    // be the same control twice.
  ];
}

/**
 * Put them in the toolbar, ahead of the search box.
 *
 * The toolbar belongs to the widget and a remount replaces it, so this runs
 * again after every mount rather than once at startup.
 */
function renderControls() {
  const toolbar = manager.toolbar?.element;
  const end = toolbar?.querySelector('.fsfm-toolbar-end');
  if (!end) return;

  for (const stale of end.querySelectorAll('.demo-tool')) stale.remove();

  const group = document.createDocumentFragment();
  for (const spec of demoControls()) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'fsfm-tool fsfm-tool-icon-only demo-tool';
    button.title = spec.title;
    button.setAttribute('aria-label', spec.title);
    // Deliberately not `aria-pressed`: the label says what a press *does*
    // ("Hide the tree"), and pairing that with "pressed" reads to a screen
    // reader as a contradiction. The state is a visual cue only, and the
    // label already implies it — "Hide" can only mean it is showing.
    if (spec.pressed) button.classList.add('is-on');
    button.innerHTML = icon(spec.icon, 15);
    button.addEventListener('click', spec.onClick);
    group.append(button);
  }

  // Before the search box, which is what "to the left of it" means; if the
  // host turned the search off, they go first in the group instead.
  end.insertBefore(group, end.querySelector('.fsfm-search-wrap') ?? end.firstChild);
}

applyTheme();
