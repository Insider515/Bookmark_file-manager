# Bookmark_file-manager

[![npm](https://img.shields.io/npm/v/bookmark-file-manager)](https://www.npmjs.com/package/bookmark-file-manager)
[![npm downloads](https://img.shields.io/npm/dm/bookmark-file-manager)](https://www.npmjs.com/package/bookmark-file-manager)
[![bundle size](https://img.shields.io/bundlephobia/minzip/bookmark-file-manager)](https://bundlephobia.com/package/bookmark-file-manager)
[![no dependencies](https://img.shields.io/badge/dependencies-1-brightgreen)](https://www.npmjs.com/package/bookmark-file-manager?activeTab=dependencies)
[![licence](https://img.shields.io/npm/l/bookmark-file-manager)](LICENSE)

An embeddable file manager: a dependency-free front-end widget and a framework-free
Node handler over a real filesystem.

- **The widget** is a plain JS class that mounts into any DOM element. It drags in no
  Bootstrap, no jQuery, no icon font, nothing at all: zero runtime dependencies.
  The build is 98 KB of JS and 7 KB of CSS gzipped, of which ~26 KB is the four
  non-English languages (English alone would be 73 KB).
- **Five languages out of the box** — English (the default), Ukrainian, Spanish,
  German, French. Your own language is an object with a dictionary in it.
- **The back end** is a single `(req, res)` function with no framework: it mounts in
  Express, AdonisJS, Fastify, Nest or bare `node:http`. It starts no server of its own
  and keeps no global state.
- Works in React / Vue / Angular / Svelte / no framework at all — it is just the DOM.

<!-- Placeholder. Drop a real screenshot over docs/screenshot.png — the name is
     referenced here and in README.uk.md, so nothing else needs changing. -->
![The file manager](docs/screenshot.png)

> 🇺🇦 [Ця сторінка українською](README.uk.md)

---

## Installation

```bash
npm install bookmark-file-manager
```

No framework to install — neither on the client nor on the server.

---

## Quick start

### Server

One function, no framework. It has the `(req, res)` shape, which is exactly what
Express takes as middleware and what any Node framework can hand its raw objects to.

```js
import express from 'express';
import { createFileManagerRouter } from 'bookmark-file-manager/server';

const app = express();

app.use('/api/files', createFileManagerRouter({
  root: './storage',          // the one directory the client can see
}));

app.listen(3000);
```

Express here is your choice, not a requirement: [the same thing in Adonis, Fastify,
Nest or bare `node:http`](#where-you-can-mount-it).

### Client

```js
import { FileManager } from 'bookmark-file-manager';
import 'bookmark-file-manager/style.css';

const manager = new FileManager('#file-manager', {
  endpoint: '/api/files',
});
```

```html
<div id="file-manager" style="height: 600px"></div>
```

The container needs a height — the widget fills it completely.

---

## What it does

**Eight primary operations.** By default their buttons are not on the toolbar — the
operations are reached from the context menu and from keyboard shortcuts. To bring the
buttons back: `toolbarActions: true` (see [below](#toolbar-buttons)).

| Button | What it does |
| --- | --- |
| New folder | Name dialog, with the name checked for collisions before anything is sent |
| New file | The same; the extension picks the icon |
| Move | Destination chosen in the tree; a folder cannot be moved inside itself |
| Copy | Recursive, renaming automatically on a collision |
| Rename | Exactly one selected item, `F2` |
| Delete | With confirmation and a list of what is going, `Delete` |
| Download | One file streams; a folder or a multiple selection becomes a ZIP on the fly |
| Upload | Multiple files with progress and cancellation; drag & drop |

**Besides that:**

- A folder tree that loads its levels lazily
- Image thumbnails drawn in the tiles themselves, and a viewer for images and PDFs over
  the widget, with arrows walking the folder ([more](#preview-and-thumbnails))
- File properties and permission changes from the context menu
  ([more](#permissions-and-properties))
- Packing and unpacking 13 archive formats ([more](#archives))
- Search across the whole tree: masks, regular expressions, extensions, files only or
  folders only, and inside file contents ([more](#search))
- A terminal with the file manager's own commands — ls, cd, cat, find, grep, mkdir, rm
  and more ([more](#terminal))
- Viewing and editing spreadsheets: csv, xlsx, xls, ods ([more](#spreadsheets))
- Viewing and editing documents: docx, odt, doc; PDF page by page ([more](#documents))
- A code editor with highlighting and line numbers ([more](#code-editor))
- Two views: tiles and a table sorted by name / size / date
- Clickable breadcrumbs, a `..` tile, "up" and "copy path" buttons
- Double-clicking the empty part of the breadcrumb strip turns it into an address bar —
  the path can be typed by hand ([more](#address-bar))
- Copying the virtual path to the clipboard: from the menu and from a button by the crumbs
- Selection: click, `Ctrl`/`Cmd`+click, `Shift`+click for a range, `Ctrl+A`
- Drag & drop: between folders, onto the tree and the crumbs; uploading files from the OS
- Context menu, keyboard navigation (arrows, `Enter`, `Backspace`, `Home`/`End`)
- A name filter for the current folder
- Preview in a new tab for text, images, PDF, audio and video
- A status bar: counts, size, selection, current path
- Five languages: English (the default), Ukrainian, Spanish, German, French; your own
  language is an object with a dictionary ([more](#language))
- Light and dark themes; colours, fonts and metrics are set at integration time
  ([more](#appearance-colours-fonts-metrics))
- Adapts to the width of its container, honours `prefers-reduced-motion`

---
## Widget options

```js
new FileManager(target, {
  endpoint: '/api/files',   // base of the REST API
  provider: null,           // your own provider instead of HTTP (see below)
  locale: null,             // 'en' | 'uk' | 'es' | 'de' | 'fr' | your dictionary;
                            //   null means English
  theme: null,              // colours, fonts and metrics; null keeps the built-in one
  rootLabel: null,          // label of the root in the tree and crumbs; null follows the language
  initialPath: '/',
  view: 'grid',             // 'grid' | 'list'
  iconBasePath: null,       // folder of per-extension artwork; null draws the icons
  permissions: null,        // { create, upload, move, copy, rename, remove,
                            //   download, chmod }
  customizeThumbnail: null, // (entry) => URL | '<svg…>' | null
  preview: true,            // images and PDFs in a viewer over the widget
  thumbnails: true,         // tiles drawn from the files themselves
  sheets: true,             // csv/xlsx/xls/ods open in the spreadsheet editor
  code: true,               // text and source files open in the code editor
  documents: true,          // docx/odt/doc in the document editor,
                            //   pdf page by page (from the context menu)
  search: true,             // recursive search: the magnifier, Enter in the filter, Ctrl+Shift+F
  terminal: true,           // the terminal panel at the bottom; its button and Ctrl+` hide it
  showTree: true,
  showToolbar: true,      // the top bar itself (search, refresh, view)
  toolbarActions: false,  // action buttons on it: false | true | ['upload', …]
  showStatusBar: true,
  showSearch: true,
  confirmDelete: true,
  headers: null,            // an object or a function — for authorisation tokens
  credentials: 'same-origin',
});
```

`target` is an element or a CSS selector.

### Toolbar buttons

By default the top bar carries only search, "Refresh" and the view toggle. There are no
action buttons on it:

```js
new FileManager('#host');                                   // no buttons
new FileManager('#host', { toolbarActions: true });         // all of them
new FileManager('#host', { toolbarActions: ['upload', 'delete'] });
new FileManager('#host', { toolbarActions: TOOLBAR_PRIMARY_ACTIONS }); // the eight primary ones
```

The buttons are **icons, with the name in a tooltip**. That is not cosmetic: with
twenty-one operations the labels would wrap the toolbar onto three rows and leave no
room for the file list. As icons they fit one line (measured: 47 px tall at 1280 wide).

| Group | Identifiers |
| --- | --- |
| Creating | `newFolder`, `newFile`, `upload` |
| Primary | `move`, `copy`, `rename`, `delete`, `download` |
| Opening | `open`, `preview`, `sheet`, `code`, `document` |
| Archives | `compress`, `extract`, `archiveContents` |
| Permissions | `executable`, `permissions` |
| Other | `copyPath`, `properties`, `selectAll` |

The full list is exported as `TOOLBAR_ACTIONS`, the eight primary ones as
`TOOLBAR_PRIMARY_ACTIONS`. An array **filters** that list without reordering it: any set
reads left to right the same way, and separators appear only between groups that have
something in them. An unknown identifier is dropped with a console warning — a typo that
makes a button quietly not appear is worth the evening it would otherwise cost.

### Why the whole context menu is on the toolbar

A touch device has no right click, so there is nothing to open a context menu with.
Without these buttons half the manager is simply unreachable on a tablet. That is why
the toolbar carries the same operations as the menu.

Two different behaviours, deliberately kept apart:

- **Type-dependent** — "Extract", "Open spreadsheet", "Preview", "Make executable" —
  **appear only when they apply**. An extract button on a `.txt` is not "temporarily
  disabled"; it is simply not part of the answer.
- **Count-dependent** — "Rename", "Properties", "Delete" — stay put and go grey. A
  button that appears and disappears as the selection changes is a moving target for a
  finger.

Hiding the buttons removes a row of buttons, not the operations. Everything stays
reachable:

| Operation | Where it is without a button |
| --- | --- |
| New folder / file, Upload | context menu on empty space |
| Move, Copy, Rename, Download, Delete | context menu on an item |
| Rename | `F2` |
| Delete | `Delete` |
| Upload | dragging files into the window |
| any | `manager.createFolder()`, `manager.upload()`, … |

`showToolbar: false` still removes the bar entirely. When there are no action buttons,
the bar gets the class `fsfm-toolbar-bare` — a hook, if it needs restyling or hiding.

---
### Language

The widget speaks English unless told otherwise. To take another one, pass `locale`:

```js
new FileManager('#host', { locale: 'de' });
```

It accepts `'en'`, `'uk'`, `'es'`, `'de'`, `'fr'`, or a full tag whose base matches one
of them: `'de-AT'` gives German. Anything unrecognised gives English rather than an
error — a typo in a config value should not take the file manager down.

The language changes more than the words: dates are formatted for its tag, size units
become local (`1.5 Ko` instead of `1.5 KB`), and plurals follow the language's own rule —
Ukrainian has three forms (1 тека, 2 теки, 5 тек), the rest have two. The widget's root
element gets a `lang` attribute.

The language is chosen at mount time. To switch it at runtime, remount:

```js
manager.destroy();
manager = new FileManager('#host', { ...options, locale: 'fr' });
```

#### Your own language

If the one you need is not there, pass your own dictionary. It may be partial: anything
it leaves out comes from English, so translating a dozen strings and leaving the rest is
a working option.

```js
import { FileManager, PLURAL_RULES } from 'bookmark-file-manager';

new FileManager('#host', {
  locale: {
    id: 'sv',
    name: 'Svenska',
    tag: 'sv',                    // for dates and the lang attribute
    plural: PLURAL_RULES.default, // or .slavic for three forms
    strings: {
      'action.newFolder': 'Ny mapp',
      'common.save': 'Spara',
      'count.files': { one: '{n} fil', other: '{n} filer' },
    },
  },
});
```

A shipped dictionary is a convenient starting point:

```js
import { en, uk } from 'bookmark-file-manager';

console.log(Object.keys(en.strings).length);  // how many strings there are
console.log(en.strings['action.newFolder']);  // 'New folder'
```

The shipped dictionaries are ordinary package exports (`import { en, uk, es, de, fr }`),
and in the repository they live in `src/locales/` — one file per language, plain objects,
edited by hand. A test keeps the key sets identical across all five, keeps plural sets
plural everywhere, and refuses a translation that introduces a placeholder English does
not have.

All five languages are in the bundle so that `locale: 'de'` works without a second
import and without an async step. That costs ~26 KB gzipped: English alone is 73 KB, all
five are 98 KB.

#### Messages from the server

The server answers in English and cannot know what language a particular widget speaks.
So along with the text it sends a stable `code` and the values it interpolated:

```json
{ "error": "Not found: /reports", "code": "NOT_FOUND", "params": { "path": "/reports" } }
```

The widget looks up its own string for that code (`srv.NOT_FOUND`) and builds the
sentence itself. When there is no translation for a code, the server's English text is
shown: worse than a translation, better than nothing. Codes that carry several different
sentences (`INVALID_NAME`, `INVALID_PATH`) are deliberately not translated — guessing
which one happened would be worse.

---
### Appearance: colours, fonts, metrics

Pass nothing and the widget looks the way the demo does. That is the default scheme.

To change it:

```js
new FileManager('#host', {
  theme: {
    // fonts and metrics — one value each, independent of the scheme
    font: "'Inter', system-ui, sans-serif",
    fontSize: '15px',
    codeFont: "'JetBrains Mono', monospace",
    codeSize: '13px',
    radius: '2px',
    sidebarWidth: '280px',
    tileWidth: '140px',
    rowHeight: '44px',

    // colours — either for both schemes at once…
    colors: { accent: '#7c3aed', accentHover: '#6d28d9', accentSoft: '#ede9fe' },
    // …or separately for light and dark
    light: { bg: '#fffdf7', text: '#2b2415' },
    dark:  { bg: '#0b1020', accent: '#a78bfa' },
  },
});
```

`colors` applies to both schemes; `light` and `dark` narrow it. If you theme only
`light`, the remaining colours in the dark scheme stay built-in — a white background
will not appear at night.

#### The keys

**Fonts and metrics:** `font`, `fontSize`, `codeFont`, `codeSize`, `codeLineHeight`,
`radius`, `radiusLarge`, `sidebarWidth`, `tileWidth`, `rowHeight`.

**Colours** (under `colors`, `light` or `dark`): `bg`, `bgSubtle`, `bgSunken`, `border`,
`borderStrong`, `text`, `textMuted`, `textInverse`, `accent`, `accentHover`,
`accentSoft`, `accentContrast`, `danger`, `dangerHover`, `success`, `warning`,
`terminalBg`, `shadow`, `shadowLarge`.

**Code highlighting** goes in a nested `tokens` object: `comment`, `string`, `number`,
`keyword`, `type`, `builtin`, `tag`, `attr`, `property`, `variable`, `operator`,
`punctuation`, `heading`, `link`, `meta`.

```js
theme: { dark: { tokens: { string: '#9ece6a', keyword: '#bb9af7' } } }
```

The lists are available from code too — `METRIC_PROPERTIES`, `COLOR_PROPERTIES`,
`TOKEN_PROPERTIES`.

#### Details worth knowing

Values are ordinary CSS, so `rgb(124 58 237 / 90%)`, `hsl(...)`, `calc(...)` and even
`var(--your-variable)` all work.

An unknown key **throws** rather than being silently ignored: `acent` instead of
`accent` should not cost you an evening. If a variable you need is not in the lists,
pass it as it is — a key starting with `--` goes straight through:

```js
theme: { '--fsfm-tile-width': '150px' }
```

Values are checked: anything that could close the rule and open one of its own (`;`,
`}`, `url(`, comments) is refused with an error. That matters if your colours come from
your own users.

A theme applies to **one** widget — two managers on a page can look different.

#### If plain CSS suits you better

The theme is only a convenient way to set the same CSS variables. Nothing stops you
doing it in a stylesheet:

```css
.fsfm { --fsfm-accent: #7c3aed; --fsfm-font-size: 15px; }
.fsfm.fsfm-dark { --fsfm-accent: #a78bfa; }
```

---
### Operation permissions

```js
new FileManager('#host', {
  permissions: { remove: false, move: false },
});
```

Buttons for withheld operations are **removed** from the toolbar and the context menu
rather than shown permanently greyed out. Omitted keys count as allowed.

This is UI only. The server declares its own set in `/config`, and the **intersection**
applies — the client cannot allow what the server forbids. Server-side permissions use
the same option on the handler and are checked on every route:

```js
createFileManagerRouter({ root: './storage', permissions: { remove: false } });
```

The current state is available as `manager.permissions` and `manager.can('remove')`.

### Custom icons

`customizeThumbnail` is called for every entry. Return an image URL, a string of `<svg>`,
or `null` to fall through to the built-in icon:

```js
new FileManager('#host', {
  customizeThumbnail: (entry) => {
    if (entry.isDirectory) return null;
    if (entry.name.endsWith('.psd')) return '/icons/photoshop.svg';
    return null;
  },
});
```

If the image at the URL fails to load, the built-in icon takes its place. An exception
inside the callback is caught and does not break the rendering of the list.
### Methods

```js
await manager.ready;                    // the first listing is on screen
manager.navigate('/Documents');
manager.navigateUp();
manager.refresh();
manager.open(entry);
manager.preview();                      // preview the current selection
manager.preview(entry);                 // or a particular file
manager.showProperties();               // properties of the selection
manager.editPermissions();              // the permissions editor
manager.setExecutable(true);            // +x on the selection
manager.compress();                     // pack the selection (format dialog)
manager.extract(entry);                 // extract an archive
manager.showArchiveContents(entry);     // look at what is inside
manager.openSheet(entry);               // open a spreadsheet in the editor
manager.openCode(entry);                // open a file in the code editor
manager.copyPath();                     // path(s) of the selection to the clipboard
manager.copyPath('/Documents');         // or a particular path
manager.setView('list');
manager.getSelection();                 // array of the selected entries
manager.currentPath;
manager.readOnly;
manager.permissions;                    // the effective permission set
manager.can('remove');

manager.createFolder();                 // the same operations the buttons run
manager.createFile();
manager.moveSelection();
manager.copySelection();
manager.renameSelection();
manager.deleteSelection();
manager.downloadSelection();
manager.upload();

manager.destroy();                      // removes everything, listeners included
```

### Events

```js
manager.on('ready',           ({ path, readOnly }) => {});
manager.on('navigate',        ({ path, listing }) => {});
manager.on('selectionchange', ({ selection }) => {});
manager.on('open',            ({ entry }) => {});
manager.on('created',         ({ entry }) => {});
manager.on('renamed',         ({ from, to }) => {});
manager.on('moved',           ({ entries, destination }) => {});
manager.on('copied',          ({ entries, destination }) => {});
manager.on('deleted',         ({ paths }) => {});
manager.on('uploaded',        ({ entries, failures, destination }) => {});
manager.on('download',        ({ entries, asArchive }) => {});
manager.on('viewchange',      ({ view }) => {});
manager.on('preview',         ({ entry }) => {});
manager.on('chmod',           ({ entries, executable }) => {});
manager.on('archived',        ({ entries, archive, format }) => {});
manager.on('extracted',       ({ entry, result }) => {});
manager.on('codeopen',        ({ entry, document }) => {});
manager.on('codesaved',       ({ entry, result }) => {});
manager.on('sheetopen',       ({ entry, workbook }) => {});
manager.on('sheetsaved',      ({ entry, result }) => {});
manager.on('pathcopied',      ({ paths, text }) => {});
manager.on('error',           ({ error, message }) => {});
```

`on()` returns a function that unsubscribes.

---
## Where you can mount it

`createFileManagerHandler()` returns a plain `(req, res)` function over node's own
objects. It has no dependency on a framework, which is why it mounts anywhere those
objects can be reached.

`basePath` is the prefix to strip from the URL. Express rewrites `req.url` itself, so
there it can be left out; Adonis, Fastify and `node:http` do not.

### AdonisJS

```js
// start/routes.ts
import app from '@adonisjs/core/services/app'
import router from '@adonisjs/core/services/router'
import { createFileManagerHandler } from 'bookmark-file-manager/server'

const files = createFileManagerHandler({
  root: app.makePath('public'),     // your folder
  basePath: '/api/files',
})

router.any('/api/files/*', ({ request, response }) =>
  files(request.request, response.response))
```

### Fastify

```js
const files = createFileManagerHandler({ root: './storage', basePath: '/api/files' })
fastify.all('/api/files/*', (req, reply) => files(req.raw, reply.raw))
```

### NestJS

```ts
const files = createFileManagerHandler({ root: './storage', basePath: '/api/files' })

@All('api/files/*')
handle(@Req() req: Request, @Res() res: Response) {
  return files(req, res)
}
```

### Bare `node:http`

```js
const files = createFileManagerHandler({ root: './storage' })
http.createServer(files).listen(3000)
```

### Express

```js
app.use('/api/files', createFileManagerRouter({ root: './storage' }))
```

`createFileManagerRouter` is the same function under the name Express users already
call. Nothing to change.

### What you give up by going around Express

Nothing: the Origin check (CSRF), `nosniff`, the CSP on downloads, body limits and the
image-processing queue all live inside the handler, not in Express. The only thing
Express itself provided was routing, and there is none to do here: all 27 routes have
fixed paths.

If you would rather register the routes yourself:

```js
files.paths()   // [{ method: 'GET', path: '/list' }, …]
files.fsOps     // the engine itself, if you do not want REST at all
```

---

## Handler options

```js
createFileManagerRouter({
  root: './storage',              // required; created if missing
  readOnly: false,                // refuse every operation that writes

  // Individual refusals. Anything omitted is allowed. readOnly: true turns off
  // every write and cannot be overridden by this object.
  // chmod is FORBIDDEN by default; archive and extract follow the value of create.
  permissions: { create: true, upload: true, move: true, copy: true,
                 rename: true, remove: true, download: true, chmod: false,
                 archive: true, extract: true, edit: true },

  // Limits. Each one is a ceiling, not a hint.
  maxUploadSize: 100 * 1024 * 1024,       // bytes per file
  maxUploadFiles: 50,                     // files in one request
  maxRequestSize: 1024 * 1024 * 1024,     // bytes for a whole upload request
  maxConcurrentUploads: 8,                // uploads in flight; beyond that, 503
  maxBatchPaths: 1000,                    // entries per move/copy/delete/download/chmod
  maxSizeWalkEntries: 200000,             // ceiling on the walk that totals a folder's size

  // Archives. Without external tools only zip, tar, tar.gz and gz remain.
  archiveTools: true,
  archiveLimits: {
    maxEntries: 100000,                   // entries in an archive
    maxTotalBytes: 5 * 1024 * 1024 * 1024, // unpacked size in total
    maxEntrySize: 2 * 1024 * 1024 * 1024,  // a single entry
    toolTimeout: 10 * 60 * 1000,           // how long a tool may run
  },
  minFreeSpace: 64 * 1024 * 1024,         // refuse uploads below this much free space
  maxListEntries: 50000,                  // ceiling on /list; 0 means no ceiling
  maxTreeChildren: 2000,                  // subdirectories per tree node
  concurrency: 32,                        // parallel stat/readdir per request

  // Free space is the server's disk, not the user's files.
  // /config does not report it by default.
  exposeUsage: false,

  // Thumbnails. The sizes are a whitelist: an arbitrary ?size= would turn the
  // endpoint into a way to spend CPU on renders nobody will ask for twice.
  thumbnails: true,
  thumbnailSizes: [64, 128, 256],
  maxRawThumbnailSize: 512 * 1024,        // ceiling for serving a file as it is
  thumbnailPixelLimit: 50 * 1024 * 1024,  // guard against decompression bombs, in pixels
  maxConcurrentThumbnails: 4,             // image renders at once
  maxQueuedThumbnails: 64,                // how many wait in the queue; beyond that, 503

  // Requests that change data are accepted from the same origin only. You may give
  // a list, a function, or false (only if you have your own CSRF defence).
  allowedOrigins: ['https://dashboard.example'],

  // Called before every operation. false -> 403.
  // context = { route, paths, destination, name }
  authorize: (req, action, context) =>
    context.paths.every((p) => p.startsWith(`/users/${req.user.id}`)),

  onWarning: (message, detail) => logger.warn(message, detail),
});
```

### `authorize`

The hook's third argument tells it **what** the operation is about, not merely which
route it came in on:

| Field | Meaning |
| --- | --- |
| `route` | the route inside the handler, e.g. `/delete` |
| `paths` | the virtual paths the operation reads or writes |
| `destination` | the destination directory for `move`/`copy`/`create`/`upload`, otherwise `null` |
| `name` | the new name for `create`/`rename`, otherwise `null` |
| `pending` | `true` on the first of the two calls for `/upload` |

For `/upload` the hook is called **twice**: before the body is parsed (`pending: true`,
the destination not yet known) and again with the final destination, before a single
byte is written. That is because the destination can arrive not only in `?path=` but as
a form field; checking `req.query.path` alone would be checking a value the upload is
not obliged to honour.

The handler keeps no global state, so several roots can be mounted at once:

```js
app.use('/api/public',  createFileManagerRouter({ root: './public' }));
app.use('/api/private', createFileManagerRouter({ root: './private', readOnly: true }));
```
### REST API

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/config` | Limits and mode (free space only with `exposeUsage`) |
| `GET` | `/list?path=` | Folder contents |
| `GET` | `/tree?path=&depth=` | Directories only, for the tree |
| `GET` | `/stat?path=` | A single entry |
| `GET` | `/thumbnail?path=&size=` | Image thumbnail; `ETag`/`If-None-Match` |
| `GET` | `/render?path=&width=` | A displayable version of tiff/heic; `ETag`/`If-None-Match` |
| `GET` | `/properties?path=&size=` | Full metadata; `size=1` totals the folder |
| `GET` | `/archive/list?path=` | Archive contents without extracting |
| `GET` | `/sheet?path=` | A spreadsheet as a workbook (sheets and cells) |
| `GET` | `/document?path=` | A document: text blocks, or PDF pages |
| `GET` | `/search?path=&query=&mode=&type=&scope=&extensions=&caseSensitive=` | Search across the tree |
| `GET` | `/text?path=` | A file as text, with its encoding and line endings |
| `GET` | `/download?paths=…` | A streamed file or a ZIP; `Range`, `ETag`/`If-None-Match` |
| `POST` | `/directory` | `{ path, name }` |
| `POST` | `/file` | `{ path, name, content }` |
| `POST` | `/rename` | `{ path, name }` |
| `POST` | `/move` | `{ paths[], destination, overwrite? }` |
| `POST` | `/copy` | `{ paths[], destination, overwrite? }` |
| `POST` | `/delete` | `{ paths[] }` |
| `POST` | `/chmod` | `{ paths[], mode \| executable, recursive? }` |
| `POST` | `/archive` | `{ paths[], format, destination?, name? }` |
| `POST` | `/extract` | `{ path, destination? }` |
| `POST` | `/sheet/save` | `{ path, workbook, format? }` |
| `POST` | `/document/save` | `{ path, document, format? }` |
| `POST` | `/document/pages` | `{ path, plan[], sources?[], target? }` — PDF pages |
| `POST` | `/text/save` | `{ path, text, encoding?, bom?, newline? }` |
| `POST` | `/upload?path=` | `multipart/form-data` |

All paths are **virtual**, relative to `root` (`/Documents/report.txt`). Absolute
server paths never appear in a response.

A path being addressed is checked for two things: a NUL byte and `..` (including one
written with a backslash — on Windows that is a separator). Everything else the
filesystem allows is addressed as it is: `report?.txt`, `note:2026.md`, `a\b.txt` are
ordinary names on Linux and macOS, and the manager is obliged to show them.

Names the client asks to **create** are checked more strictly: `/ \ : * ? " < > |`
and control characters are refused (`INVALID_NAME`). That is a portability rule — a file
created here should survive being copied to Windows. Such a name can be read, but not
created.

Errors come back as `{ error, code }` with a meaningful HTTP status:
`INVALID_NAME`, `INVALID_PATH`, `OUTSIDE_ROOT`, `NOT_FOUND`, `EXISTS`, `READ_ONLY`,
`PERMISSION_DENIED`, `INTO_SELF`, `TOO_LARGE`, `NO_SPACE`, `CROSS_ORIGIN`, `TOO_MANY`,
`BUSY`, `INVALID_MODE`, `SPECIAL_BITS_REFUSED`, `CHMOD_UNSUPPORTED`, `NOT_AN_ARCHIVE`,
`FORMAT_UNAVAILABLE`, `FORMAT_READ_ONLY`, `FORMAT_SINGLE_FILE`, `ARCHIVE_TOO_LARGE`,
`ARCHIVE_ENTRY_TOO_LARGE`, `ARCHIVE_TOO_MANY`, `ARCHIVE_UNREADABLE`, `ARCHIVE_TIMEOUT`,
`NOT_VIEWABLE`, `NO_RENDER`, `NOT_A_SHEET`, `NOT_A_WORKBOOK`, `SINGLE_SHEET_FORMAT`,
`TOO_MANY_ROWS`, `TOO_MANY_COLUMNS`, `TOO_MANY_CELLS`, `TOO_MANY_SHEETS`, `NOT_TEXT`,
`TEXT_TOO_LARGE`, `INVALID_TEXT`, `NOT_A_DOCUMENT`, `INVALID_DOCUMENT`, `INVALID_PLAN`,
`TOO_MANY_BLOCKS`, `BLOCK_TOO_LONG`, `DOCUMENT_TOO_LONG`, `DOCUMENT_TOO_LARGE`,
`NOT_A_DOC`, `DOC_TOO_OLD`, `DOC_ENCRYPTED`, `NOT_A_PDF`, `PDF_ENCRYPTED`,
`PDF_NO_PAGES`, `PDF_NO_PAGES_SELECTED`, `PDF_BAD_PAGE`, `TOO_MANY_PAGES`,
`EMPTY_QUERY`, `INVALID_REGEX`, `QUERY_TOO_LONG`, `TOO_MANY_EXTENSIONS`,
`CONTENT_NEEDS_FILES`, `SEARCH_FAILED`.

`/config` returns `{ readOnly, permissions, maxUploadSize, maxUploadFiles,
maxRequestSize, thumbnails, thumbnailSizes, chmodSupported, archiveFormats, imageView,
sheetFormats, documentFormats, search, usage }`. `readOnly` is derived: it is true
exactly when every write operation is forbidden, so it cannot drift out of step with
`permissions`. `usage` is `null` unless the handler was started with
`exposeUsage: true`.

`/list` may come back with `truncated: true` and `total` when a directory holds more
than `maxListEntries` entries; the widget then says so rather than passing a part off as
the whole.

---
## Preview and thumbnails

Two independent things, both on by default.

**Thumbnails in tiles** (`thumbnails`). A tile is drawn from the file itself. There is a
separate `/thumbnail` route rather than `/download`, for a simple reason: a folder of
photographs drawn from the originals would cost the browser hundreds of megabytes for
the sake of 128×128 squares. Measured on a test file: a 168 KB original became a 356-byte
thumbnail.

| Format | How the thumbnail is made |
| --- | --- |
| `jpg`, `jpeg`, `png`, `webp`, `gif`, `avif`, `tif`, `tiff`, `heic`, `heif` | decoded and re-encoded to WebP (needs `sharp`; heic as in the viewer) |
| `ico`, `bmp` | served as they are — libvips cannot read them, the browser can draw them |
| `svg` | served as it is — rasterising a vector for 128 px makes no sense |
| `pdf` | **no thumbnail**; the drawn icon stays |

`sharp` is an optional peer dependency. Without it the route still works: files smaller
than `maxRawThumbnailSize` are served as they are, the rest get a 415, and the tile falls
back to a drawn icon. Install it with a plain `npm install sharp`.

Why a PDF has no thumbnail: rasterising the first page needs an engine (poppler, mupdf,
pdfium), and the prebuilt `sharp` binaries are built without one. Dragging one in for the
sake of a tile is out of proportion; a PDF is shown in full in the viewer.

**The viewer** (`preview`). A double click or `Space` opens a file over the widget rather
than in a new tab: the user stays in the folder, and `←` `→` walk its files. `Esc`
closes. A PDF goes into an `<iframe>`, where the browser's own viewer draws it with its
own paging, zoom and search.

Thirteen image formats are supported, but **not all in the same way**:

| Format | How it is shown |
| --- | --- |
| `jpeg`, `jpg`, `png`, `gif`, `webp`, `avif`, `bmp`, `ico`, `svg` | directly by the browser; the file is served **byte for byte** |
| `tiff`, `tif`, `heic`, `heif` | converted to WebP by the server through `/render` |

That split was tested, not taken from documentation: each format was loaded into Chrome
from a `data:` URL — the ones in the first row reported their dimensions, `tiff` and
`heic` did not render. Safari displays HEIC on its own, but relying on that would make
the viewer work in one browser and quietly break in the rest.

The formats in the first row are **not repacked**: re-encoding a JPEG just to look at it
means losing quality for nothing. Conversion is turned on exactly where there is no way
around it, and the result is capped by width (`1024`/`1600`/`2048`/`2560`) so a
hundred-megapixel scan does not arrive whole. The caption then reports the dimensions of
the **original**, not of the image being shown.

### What tiff and heic need

`tiff` needs `sharp`. `heic` is harder, and worth knowing in advance: the stock `sharp`
binaries carry libheif **without an HEVC decoder** (HEVC is patent-encumbered, unlike
AV1, which is why AVIF works and HEIC does not). So the capability is **probed at
startup by actually decoding**, rather than declared: libheif parses an HEIC container
successfully and only fails when asked for pixels, so a header probe would report support
that is not there.

If `sharp` cannot do it, an external converter is looked for — `heif-convert` (from
libheif), `magick`, `convert`, or `sips` (macOS). That one is checked **by attempting a
conversion** too, not by the file existing. What came of it is visible in
`/config.imageView.heif`: `'sharp'`, `'tool'` or `false`.

If there is no path at all, the format simply does not appear in
`/config.imageView.render`, and the viewer says plainly that it cannot show it and offers
a download — instead of a broken-image icon with no explanation.

Anything the viewer will not show still opens in a new tab. `preview: false` restores the
previous behaviour entirely.

```js
manager.on('preview', ({ entry }) => analytics.track('preview', entry.path));
manager.preview();                      // the current selection
manager.preview(someEntry);             // a particular file; false if there is nothing to show
```

### Isolating what is displayed

Tested, not assumed — the cases differ:

- **Markup carrying a script** (an `.svg`, say) is stopped by the response header
  `Content-Security-Policy: default-src 'none'; sandbox`. A hostile SVG placed in a
  same-origin `<iframe>` does not run its script, and `contentDocument` reads as `null`.
- **PDF is the exception.** Chrome hands the frame to its own viewer, and that document
  stays same-origin: `contentDocument` is reachable. What is in it, though, is not the
  file but Chrome's own empty `pdf_embedder` shell; the PDF is drawn by the extension in
  a nested frame. A script inside the PDF runs in the browser's sandbox and never reaches
  the page's DOM. The isolation there is the browser's, not this header's.

The `sandbox` attribute is deliberately **not** set on the `<iframe>`. It looks like an
obvious extra precaution and is not: an empty `sandbox` takes away rights Chrome's PDF
viewer needs, and "Chrome blocked this page" appears instead of the document. A viewer
that shows nothing is not safer.

---
## Archives

Thirteen formats are supported. "Create archive…", "Extract" and "Show contents…" are in
the context menu.

| Format | Read | Write | What does it |
| --- | :---: | :---: | --- |
| `zip` | ✅ | ✅ | own implementation (Zip64 writer + reader) |
| `tar` | ✅ | ✅ | own implementation |
| `tar.gz`, `tgz` | ✅ | ✅ | own tar + `zlib` |
| `gz` | ✅ | ✅ | `zlib` |
| `tar.bz2`, `tbz2` | ✅ | ✅ | own tar + `bzip2` |
| `bz2` | ✅ | ✅ | `bzip2` |
| `tar.xz`, `txz` | ✅ | ✅ | own tar + `xz` |
| `xz` | ✅ | ✅ | `xz` |
| `tar.zst` | ✅ | ✅ | own tar + `zlib` (Node ≥ 22.15) or `zstd` |
| `zst` | ✅ | ✅ | the same |
| `7z` | ✅ | ✅ | own tar + `bsdtar` (libarchive) |
| `rar` | ✅ | ❌ | `bsdtar` / `unrar` |

### Why RAR is read-only

Not for lack of time. The RAR compressor is proprietary, the licence on the reference
sources expressly forbids using them to build a compatible archiver, and no free
implementation exists. Verified rather than assumed: `7zz a -trar` answers `E_NOTIMPL`,
and libarchive has no write support for the format at all. Anything claiming to create
RAR would be lying.

An attempt to pack into rar returns `FORMAT_READ_ONLY` with that explanation, and the
widget simply does not offer the option.

### What is available on a given machine

`zip`, `tar`, `tar.gz` and `gz` always work — they are entirely own code plus `zlib`.
The rest need `bzip2`, `xz`, `zstd` or `bsdtar`. The handler looks for them once at
startup and publishes the result in `/config.archiveFormats`; the widget draws exactly
what is there and never offers a format that will not work.

`archiveTools: false` turns subprocesses off entirely — the four `zlib` formats remain.

### How it works

Everything, including the formats a subprocess handles, goes through **our own** tar
layer. A subprocess is never handed names from an archive:

- `bz2`, `xz`, `zst` run as `-dc`, stdin → stdout. They never see a file name at all.
- `7z` and `rar` are turned into a tar stream by `bsdtar`, which our own tar reader then
  reads.
- Packing into `7z`, our tar writer feeds the stream to `bsdtar`, which is given only the
  destination path — chosen by this code.

The point is that the decision of "what lands on disk, under what name" is made in one
place that can be read, and made the same way for every format. Nothing runs through a
shell: argv arrays only, so a file name cannot be parsed as an option or a command.

### Safety while extracting

An archive is untrusted input whose entries are **file names**. The rule adopted is
**refuse, do not repair**. A name that has to be rewritten to become safe belongs either
to a broken archive or to a hostile one, and quietly substituting it hides both cases.

Refused: `..` in any spelling (including `..\` from Windows archives), absolute paths,
paths with a drive letter and UNC paths, NUL bytes, reserved names, over-long segments
and over-deep nesting.

Symbolic and hard links **are not extracted at all**. That is the other half of the same
problem: a symlink entry pointing at `/etc`, followed by a file written "through" it,
leaves a directory every name in which passed the check.

The entry count, the total unpacked size and the size of a single entry are all capped —
both by the declared size (before a byte is written) and by the bytes actually read,
because an archive can lie about the first.

Everything refused comes back to the client in `skipped` and is shown to the user: a
silent partial extraction is exactly the case where an attempted escape goes unnoticed.

### Where it extracts to

Never straight into the current folder — that is how an untidy archive scatters forty
files through someone's documents. But no needless wrapper appears either: if there is
exactly one top-level directory inside (which is what this code writes, and most others
too), that becomes the result; otherwise a folder named after the archive is created.
The decision is made after extracting to a temporary directory — for a tar stream the
shape cannot be known in advance.

Bare `gz`, `bz2`, `xz`, `zst` are the exception: inside is one file with an obvious name,
and there is nothing to wrap. Only a single regular file can be packed into them; for a
folder or several items the widget offers the matching `tar.*`.

---

## Code editor

A double click on a text file opens the editor over the widget: **line numbers**, syntax
highlighting, `Tab` to indent, `Enter` keeping the indentation, `Ctrl`/`Cmd`+`S` to save,
`Esc` to leave. The footer shows line and column; the header shows the language, the
encoding, the kind of line ending and the size.

Every extension asked for is supported:

| Language | Extensions |
| --- | --- |
| TypeScript | `ts` `tsx` `mts` `cts` `d.ts` `d.mts` `d.cts` |
| JavaScript | `js` `mjs` `cjs` `jsx` |
| Styles | `css` `scss` `sass` `less` `styl` |
| Markup | `html` `htm` `xml` `svg` |
| Data | `json` `yaml` `yml` |
| Other | `md` `sh` `py` `php` `txt`, and files with no extension (`Makefile`, `.env`, …) |

`yml` sits alongside `yaml`: it is the same thing under the commoner spelling, and
without it most real configs would fall through to plain text.

### How it is built

An ordinary `<textarea>` with a highlighted copy underneath it. A deliberate choice: it
gets undo and redo, IME input, the mobile keyboard, accessibility and a selection that
behaves like any other text field, all for free. All of that would have to be rewritten —
and rewritten worse — on `contenteditable`.

Lines **do not wrap**. Otherwise one logical line takes several screen lines, and the
number column would have to measure the height of each — a source of drift that is never
quite cured. Without wrapping a line is a row, and the numbering is right by
construction.

The highlighting is a tokeniser, not a parser: rules are tried in order and the first
match wins. That is why half-written code — which is most of what an editor shows — is
highlighted sensibly instead of falling apart. The price is stated plainly:
interpolation inside a template string is coloured as part of the string; `/` as "regex
or division" is decided by a heuristic on the preceding character; inside `<script>` and
`<style>` the language does not switch.

Highlighting is turned off for files over 512 KB — editing still works, and the header
says why the colour went away.

### What is preserved along with the text

The encoding, the BOM and the line endings are detected on opening and **put back** on
saving. Opening a CRLF file on a Linux server and writing it as LF rewrites every line: a
one-character edit becomes a diff nobody can review.

Single-byte encodings (`windows-1251` and others) are recognised, but Node can only read
them. Such a file is saved as UTF-8 **with a warning**, not silently.

A binary file cannot be opened: the presence of a NUL byte is what the decision rests on.
Without it the decoder would fall back to `windows-1252`, which maps every byte, and an
image would "open" as megabytes of rubbish.

The write goes to a temporary file and is renamed into place. The permission is the same
`edit` the spreadsheets use: in read-only mode the editor is not offered.

---
## Spreadsheets

Four formats, all readable and writable, **with no dependency at all**:

| Format | How it is built | What you get |
| --- | --- | --- |
| `csv` (`tsv`, `txt`) | plain text | the delimiter, line ending, encoding and BOM are detected and **preserved** |
| `xlsx` (`xlsm`) | ZIP of XML | sheets, values, dates, formulas |
| `ods` | ZIP of XML | the same |
| `xls` | BIFF8 inside an OLE2 container | the same |

The project already had a ZIP reader and writer, so xlsx and ods needed only XML
parsing. The only thing that had to be built from scratch was the OLE2 container and the
BIFF8 records for `xls`.

Verified against something other than itself: files written by this code open in
**openpyxl** (xlsx), **odfpy** (ods) and **xlrd** (xls); files those tools create are
read here. Both directions are pinned by tests against real files.

### The editor

A double click on a spreadsheet opens a grid over the widget: sheet tabs, column
headers, editing in place, arrows to move, `Enter`/`Tab` to commit, `Delete` to clear.
Numbers are right-aligned. The "Row" and "Column" buttons extend the editable area.

The **server** decides a cell's type, not the browser: the client sends what the user
typed, and `"99.9"` becomes a number on the server. A client that declared
`type: "number"` with a string inside achieves nothing by it.

### What the editor does not do

It works **with values**. Saving does not carry over formatting, column widths, charts,
pivot tables, conditional formatting or macros. That is written in the editor's header,
because the worst thing an editor can do is silently throw away what it did not
understand.

Formulas are not evaluated. A file stores a formula's last result alongside it, and that
is what is shown. For `xlsx` and `ods` the formula text is preserved; for `xls` it is
not: BIFF8 stores the expression as a stream of RPN tokens, and a decompiler for that is
out of scope here.

CSV holds one sheet. Trying to save a two-sheet workbook into it is **refused**
(`SINGLE_SHEET_FORMAT`) rather than quietly dropping the second.

Encodings: `windows-1251`, `koi8-r` and other single-byte ones are recognised on reading,
but Node can only decode them. Such a file is saved as UTF-8, and that is reported in
`warnings` rather than happening behind your back.

### Saving

The write goes to a temporary file in the same directory and is renamed into place — an
interrupted save will not leave half a spreadsheet under the real name. Permissions: the
operation is gated by the `edit` key, which by default follows `create`, so a manager in
read-only mode does not offer the editor.

---

## Terminal

A panel at the bottom of the widget: a prompt with the current path, a command line, and
output. On by default; the terminal icon on the right of the toolbar and ``Ctrl+` ``
hide and show it. The panel can be dragged by its top edge — the height follows the task.

**This is not a system shell.** No command starts a process: each one goes through the
same REST API the buttons use. Everything else follows from that — there is no sandbox to
escape from because there is no shell; leaving the root is impossible for the same reason
it is in the listing; and a manager opened without the `remove` permission will not run
`rm`, and says so before sending a request.

### Commands

| Command | What it does |
| --- | --- |
| `help [command]` | list the commands, or explain one |
| `pwd` | current folder |
| `ls [-l] [path]` | contents; `-l` adds permissions, size, date |
| `cd [path]` | go there (the listing and the tree follow) |
| `cat <file>` | the text of a file |
| `stat <path>` | properties |
| `du [path]` | total size of a folder |
| `tree [path] [depth]` | folder tree |
| `find <mask> [path]` | find by name in every subfolder |
| `grep <text> [path]` | find text inside files |
| `mkdir <name...>` | create a folder |
| `touch <name...>` | create an empty file |
| `rm <path...>` | delete |
| `cp <from...> <to>` | copy into a folder |
| `mv <from...> <to\|name>` | move or rename |
| `chmod <mode> <path...>` | change permissions: `chmod 755 build.sh` |
| `open <path>` | open in the widget's viewer or editor |
| `download <path...>` | download |
| `clear` | clear the screen |

`find` and `grep` are the same search the dialog runs ([above](#search)), with the same
limits and the same protection.

### Input

- `Tab` completes: a command name in the first position, otherwise a file or folder name;
  with several candidates it fills in the common part and lists them.
- `↑` / `↓` walk the history, `Ctrl+L` clears, `Ctrl+C` abandons the line.
- Quotes and backslashes work as they do in a shell: `rm "My report.txt"` and
  `rm My\ report.txt` both delete one file, not two that do not exist. `Tab` completion
  adds the quotes itself when a name contains a space.

### The panel remembers what the mouse did

It replaced an event log and kept doing that work: creating, renaming, moving, deleting,
uploading and errors are printed here too, in a muted colour. The history of a session
reads as one thing, whichever way an operation was performed.

`cd` moves both the listing and the tree; the reverse holds too — navigating with the
mouse moves the prompt. It is one place reachable two ways.

### What is available from code

```js
const manager = new FileManager('#host', { terminal: true });

manager.toggleTerminal(false);        // hide
manager.toggleTerminal();             // toggle; returns the new state
manager.termNote('a line of my own'); // print it muted
manager.terminal.run('ls -l');        // run a command
manager.on('terminaltoggle', ({ visible }) => …);
```

The command language lives in `src/core/terminal-commands.js` and never touches the DOM —
it can be used on its own, and it is covered by tests: argument parsing and path
arithmetic are what break in a command line, and there is no reason to check them in a
browser.

---
## Address bar

A double click on the **empty part** of the breadcrumb strip turns it into an input
holding the current path. `Enter` goes there, `Escape` or a click elsewhere brings the
crumbs back. A double click on a crumb itself, or on a button, stays what it was: two
clicks on a control.

The path is understood the way the terminal understands it — by the same resolver:

| Input | Where |
| --- | --- |
| `/Projects/web` | an absolute path |
| `src` | relative to the current folder |
| `../Archive` | up one level and down |
| `~` | to the root |
| `/Projects/web/style.css` | to the file's folder, with the file selected |

**The path is checked before navigating.** That is not a detail: a failed navigation
falls back to the root, so a typo would throw the user out of the folder they were
working in. Instead a path that does not exist is reported as an error in the bar itself,
the field stays open, and the mistake can be fixed in place.

From code: `manager.editPath()`; the `pathedit` event reports where it went.

---

## Search

Two different things, deliberately kept apart.

**The filter in the toolbar** narrows the folder already on screen: it answers instantly,
because the data is already here, and it loads nothing. That is what was there before and
still is.

**Search** walks the tree on the server. It opens from the magnifier next to the filter,
from `Enter` in the filter itself (what was typed carries over into the query), or from
`Ctrl+Shift+F`.

### What it can do

| Capability | How |
| --- | --- |
| Across every subfolder | walks down from the current folder |
| Ignore case | **by default**; the "Match case" box turns it off |
| Masks | "Mask" mode: `*` `?` `[a-z]` `{js,ts}`; `**` crosses a slash |
| Regular expressions | "Regular expression" mode, JavaScript syntax |
| Files only / folders only | the "Look for" list |
| By extension | the "Extensions" field: `js, ts, md` — works with no query at all |
| Inside file contents | the "Search inside files" box; shows matching lines with numbers |

A mask describes the **whole name**: `*.js` finds `main.js` but not `main.js.map`, and
`main` with no asterisks finds only a file named exactly `main`. If the mask contains a
slash, it is matched against the path relative to where the search started: `**/src/*.js`.

Extensions filter on the name, not the content, so `.TXT` is caught by `txt` (extension
case is ignored too).

The query can be left out entirely when extensions are given: "every `.js` below this
folder" is a search in its own right. With neither a query **nor** extensions the search
is refused (`EMPTY_QUERY`): otherwise it would be an ordinary listing pretending to be a
search.

### Searching inside files

Only text files are read. Binary ones are skipped by the same sign the code editor uses —
a NUL byte: without it every JPEG in the tree would be decoded into megabytes of mojibake
and searched. The encoding is detected by the same code the CSV reader and the editor
use.

Files over 2 MB are not read, at most 5 lines come back per file, and a long line is
trimmed to a window around the match. All of that is configurable through `searchLimits`.

The permission is separate: searching contents requires `download`. Seeing that a file
exists and reading what is written in it are different things, and a search that blurs
them would become a way to read files a line at a time. Without the permission,
`/config.search.content` is `false` and the widget does not offer the box.

### Why the search runs in a worker thread

Search is the one place where the user hands the server a **program**: a regular
expression. JavaScript's regex engine backtracks, so a pattern like `^(a+)+$` against a
string of four hundred `a`s does not "take longer" — it never finishes. Checking the
clock between files is useless: the whole request sits inside a single `exec` call, and
there is nothing inside it to interrupt.

Measured: the same pattern on the same string, in an ordinary process, was still running
after eight seconds and the process had to be killed. So the walk lives in a worker
thread, which can be **terminated**; matches are posted out in batches, so a stopped
search still returns what it found. The main event loop is not blocked meanwhile, and the
server keeps answering.

The `maxConcurrent` limit (4 by default) comes from the same place: every search is a
thread, and without a cap a dozen requests in a row would be a way to bring the server
down. Past the cap, `429 BUSY`.

### Limits, and an honest answer

```js
createFileManagerRouter({
  root: './files',
  searchLimits: {
    maxResults: 500,        // matches in the response
    maxEntries: 200000,     // entries visited
    maxDepth: 32,           // levels of nesting
    timeout: 10000,         // ms for the walk
    maxContentBytes: 2 * 1024 * 1024,
    maxMatchesPerFile: 5,
    maxConcurrent: 4,       // searches at once
  },
});
```

The response always says whether it is complete: `truncated` means a limit was hit,
`timedOut` means the walk was stopped on time. The widget reports that in the results
line rather than passing a part off as the whole.

Symbolic links are followed by the same rule as in the listing: only while they lead
inside the root. A link to an ancestor within the root is legitimate and is handled —
visited directories are remembered by their real path, or the walk would never end.

### Results

Every match shows **where** it is — otherwise a list of names is useless, since the whole
point is that the file is somewhere else. A click goes to the folder and selects the
file; a double click opens it.

```js
const result = await manager.provider.search('/', {
  query: 'function',
  mode: 'substring',
  scope: 'content',
  extensions: 'js,ts',
});
// result.matches[0] → { path, parent, name, isDirectory, size, modified,
//                       matchedIn: 'content', lines: [{ line, column, text }] }
```

---
## Documents

Four formats, again with no dependency at all:

| Format | How it is built | What is available |
| --- | --- | --- |
| `docx` | ZIP of XML (WordprocessingML) | reading and writing text with its styling |
| `odt` | ZIP of XML (OpenDocument) | the same |
| `doc` | binary records inside an OLE2 container | the same, with a caveat (below) |
| `pdf` | a graph of numbered objects | reading text and **page operations** |

The ZIP reader, the writer and the OLE2 container already existed — from the
spreadsheets. What had to be built anew was parsing `.doc` (the piece table and the
formatted-property pages) and parsing PDF.

Verified against something other than itself: files written by this code open in
**python-docx** (docx), **odfpy** (odt), **textutil** (doc) and **pypdf** (pdf); files
those tools create are read here. Both directions are pinned by tests.

### The text editor

A double click on a `docx`, `odt` or `doc` opens the editor over the widget: every
paragraph is a row with a type selector (paragraph, heading 1–6, list item) and an input.
Bold, italic and underline come from buttons or `Ctrl+B`/`I`/`U`; `Ctrl+S` saves.

### What survives an edit

The central property: **editing one paragraph does not touch the rest of the document**.
Every block remembers the markup it was read from, and on saving a block nobody touched
is written back verbatim; only the changed one is rebuilt. That is why tables, images,
headers and footers, styles and numbering stay where they were, even though the editor
does not show them. Formatting can only be lost **inside the paragraph you changed**.

Anything the editor cannot show appears in it as a locked block, "`[table]`" — so that it
is clear something is there and that it will be kept. Purely structural elements
(`sectPr`, bookmarks) are not shown at all, and are preserved the same way.

The original markup **never goes to the browser**. The client receives only text, styling
and a block number; on saving, the server re-reads the file itself and matches blocks by
those numbers. Markup sent by a client is ignored — otherwise any request could write
arbitrary XML into the document.

`.doc` is the exception. It is rebuilt in full on saving, because Word's binary
structures cannot be restored piecemeal. Images and text boxes will not survive a write
to `.doc`, and list markers become indentation; that is said in the editor's header and
returned in `warnings`. To keep everything, use `.docx`.

### Why PDF is not edited as text

A PDF page contains no paragraphs. It contains operators like
`BT /F1 12 Tf 72 700 Td (Hello) Tj ET` — "put these glyphs at this point". There are no
words, lines or line breaks in the file: they emerge from coordinates. On top of that the
font is usually embedded subsetted — only the glyphs already used — so a letter that was
not in the document is nowhere to be had.

So "editing PDF text" inevitably means either redrawing the page as an image or breaking
the layout. Neither happens here. Text is **extracted and shown** (the "Text" tab, page
by page), and `textLayer` reports whether there is any at all: a scan has none, and the
editor says so instead of showing emptiness.

### PDF page operations

Deleting, reordering, rotating, splitting and merging are all one write: a plan lists the
pages wanted, in the order wanted, naming the file and the rotation.

```js
await manager.provider.saveDocumentPages('/contract.pdf', [
  { page: 2 },                        // the third page of the source
  { page: 0, rotate: 90 },            // the first, rotated
  { source: 1, page: 0 },             // the first page of an appended file
], { sources: ['/appendix.pdf'], target: '/summary.pdf' });
```

Without `target` the file is rewritten in place; with it a new file is written (which is
what "split" and "save as" are). Appended files go through the same root-containment
check as everything else: merging with a file outside the root is not possible.

Pages are copied together with everything they refer to — fonts, descriptors, embedded
font files. Copying a page without that gives a file whose text is invisible.

### What is read, and what is refused

The PDF reader **does not trust the cross-reference table** at the end of the file:
objects are found by scanning. The table is the fast path, but it is also the first thing
to be wrong in a file assembled by a script or truncated in transit. One pass over the
bytes opens files that "correct" parsers reject; a test on a file with a corrupted table
pins that down.

Refused rather than half-read: an encrypted PDF (`PDF_ENCRYPTED`), a `.doc` in the Word
6.0/95 format (`DOC_TOO_OLD`) and a password-protected `.doc` (`DOC_ENCRYPTED`). Half a
document passed off as the whole is worse than an honest refusal.

### Saving

As with spreadsheets: a write to a temporary file alongside, then a rename into place.
The operation is gated by the `edit` key; in read-only mode neither the editor nor the
page operations are offered.

---

## Permissions and properties

### Properties

`Alt+Enter`, or "Properties" in the context menu — always available, needing no
permission of their own. It shows the name, the type, the size (and how much is used on
disk — for a sparse file those are different numbers), the created / modified / accessed
dates, permissions as `rwxr-xr-x (755)`, the owner, the hard-link count, and for a
symbolic link its target as a **virtual** path (or `null` when it leads outside the root).

For a folder the content size is not computed on its own: there is a "Calculate" button
next to it. Walking the tree is a request in itself, and most of the time nobody needs
the number. The walk is capped by `maxSizeWalkEntries`; if it hits the ceiling, the
answer is honestly marked `totalSizePartial: true` rather than passing an incomplete
total off as a complete one.

### Changing permissions

Requires the `chmod` permission, and **that is the one permission that is off by
default**:

```js
createFileManagerRouter({ root: './storage', permissions: { chmod: true } });
```

The reason is that every other operation is the obvious work of a file manager, and
allowing it by default costs nobody anything. Setting the execute bit is not that case:
it turns an uploads directory into a place from which what was uploaded can be run. If
the permission were on by default, an installation that merely updated the package would
acquire that capability without anyone deciding to. Turning it on explicitly is the one
default that surprises nobody.

Two items appear in the context menu:

- **"Make executable" / "Clear executable bit"** — for files only. On a directory the `x`
  bit means "may be entered", not "may be run", and toggling that from a one-click menu
  item would betray the expectation it sets.
- **"Permissions…"** — a read/write/execute grid across the three classes, plus an octal
  field. Both are views of the same set of bits and stay in step: people who know what
  `644` means type it; people who do not tick boxes. For a folder there is an "apply to
  everything inside" checkbox.

`chmod +x` follows the **read bits** rather than setting all three:

| Was | Becomes | Why |
| --- | --- | --- |
| `644` | `755` | the ordinary case |
| `640` | `750` | group and others gain nothing beyond what they had |
| `600` | `700` | |

That way "make executable" never widens the circle of who can reach the file — only what
they can do with it. The recursive mode reads each entry's bits separately, so a tree of
`644` files and `755` directories keeps that distinction instead of collapsing into one
value.

### What is refused

- **The setuid, setgid and sticky bits** — always, with no option to enable them. A file
  manager reachable over HTTP has no legitimate reason to hand out setuid, and the cost of
  a mistake here is not "wrong permissions" but a local privilege-escalation primitive in
  a directory that same manager accepts uploads into.
- **A number instead of a string.** `mode` is accepted only as a string of octal digits
  (`"755"`). A person reads `mode: 755` as octal and JSON reads it as decimal `0o1363`;
  the difference gets noticed after the file has become world-writable.
- **Symbolic links during a recursive walk** are skipped rather than followed:
  `fs.chmod()` follows the link, and stepping into one would change the permissions of
  what it points at — the one thing in the tree whose target the walk did not keep inside
  the root.
- **The root directory** — `ROOT_IMMUTABLE`.

Windows has no POSIX bits (`fs.chmod` there only toggles the read-only attribute), so
`chmodSupported` in `/config` is `false`, the permission is forced off, and the widget
removes the controls entirely — rather than promising what the platform will not do.

---
## Security

**Escaping the root**

- A path is checked twice — lexically and through `realpath`. The second catches a
  symlink inside the root that leads out of it; such links are neither listed nor opened.
  One check alone is not enough in either direction.
- `..` in a path is **refused**, not resolved: a client that sent it is either broken or
  probing, and quiet normalisation hides both cases.
- Copying and moving follow the same rule. `fs.cp({dereference: true})` will not do here:
  it obediently follows a link out of the root and places the outside file inside as a
  real one, after which the manager shows and serves it. Our own walk checks every entry
  with `lstat`, follows a link only while it stays inside the root, and skips the rest,
  reporting them through `onWarning`.
- Uploaded file names are trimmed to their last segment, so `../../evil.txt` is written
  as `evil.txt`.

**Requests**

- Requests that change data are refused from a foreign origin (`CROSS_ORIGIN`). The JSON
  routes are covered by CORS anyway — `application/json` is not a simple request and gets
  a preflight. `/upload` is: an ordinary `<form enctype="multipart/form-data">` on any
  site could write files into the storage under the user's session cookie. A request with
  no `Origin` and no `Sec-Fetch-Site` at all is let through: that is not a browser form
  but curl, or a server-to-server call.
- `authorize` is called before the disk is touched, and receives the concrete paths (see
  above).

**Uploads**

- An upload goes to a temporary file and is renamed only on success — an interrupted
  upload, or one that went over the limit, leaves no truncated file under the real name.
  Temporary files never appear in `/list`.
- The destination name is claimed atomically (`open` with `wx`). Checking whether a name
  is free and claiming it are one operation; otherwise two simultaneous uploads of the
  same name would both choose it and one would overwrite the other.
- The file size, the whole request size, the file count and the number of concurrent
  uploads are all capped; below `minFreeSpace` an upload is refused, so the disk is not
  filled to zero and the host application taken down with it.

**What goes back out**

- Downloads are served with `X-Content-Type-Options: nosniff`, `Content-Security-Policy:
  default-src 'none'; sandbox` and `Content-Disposition: attachment`, except for an
  explicit `?inline=1` on types known to be safe. An uploaded `.html` or `.svg` cannot be
  turned against the host application.
- Only `FsError` messages go out — they are written for the user and name nothing but the
  virtual path. Any other filesystem error is replaced with a general phrase and written
  to `onWarning`: node's raw message embeds the absolute path it failed on.
- Free space is a property of the server's disk, not of the user's files, so `/config`
  reports it only with `exposeUsage: true`.

The handler does no authentication — that is the host application's job. Put your own
middleware in front of it and/or use `authorize`.

### What the handler does not do

- No authentication and no rate limiting — both belong in front of it.
- It does not isolate users from one another by itself: one handler, one root. For
  multi-tenancy, mount one handler per tenant or refuse foreign paths in `authorize`.
- It gives no quota on total storage: `minFreeSpace` protects the disk from filling up,
  but does not count how much a particular user took.
- `server/standalone.js` is a development server with no authentication whatsoever. It is
  not part of the npm package and listens on `127.0.0.1` only by default.

---
## Your own data source

The widget talks to a *provider*, not to `fetch` directly. To work against something
other than a local filesystem — S3, or your own RPC — pass an object with the same
methods:

```js
new FileManager('#host', {
  provider: {
    config:          ()                          => ({ readOnly: false, maxUploadSize: 0 }),
    list:            (path, signal)              => ({ path, parent, items: [] }),
    tree:            (path, depth, signal)       => ({ path, name, hasChildren, children }),
    stat:            (path, signal)              => entry,
    createDirectory: (path, name)                => entry,
    createFile:      (path, name, content)       => entry,
    rename:          (path, name)                => entry,
    move:            (paths, destination, opts)  => [entry],
    copy:            (paths, destination, opts)  => [entry],
    remove:          (paths)                     => ({ removed: [] }),
    upload:          (path, files, opts)         => ({ uploaded: [], failures: [] }),
    downloadUrl:     (paths, opts)               => 'https://…',
  },
});
```

An entry is `{ name, path, isDirectory, size, modified }`.

---

## Icons

By default the icons are **drawn**: a sheet with a folded corner, a coloured plate and
the extension on it. That covers any extension, needs no assets copied into the host
project, and makes no network requests.

The package also carries a set of ready SVGs for 42 extensions — point at wherever you
serve them from:

```js
new FileManager('#host', { iconBasePath: '/icons' });
```

Extensions with no artwork fall back to the drawn icon automatically.

---

## Themes

All the styling is CSS variables on `.fsfm`. The dark theme comes on automatically with
`prefers-color-scheme`; it can be forced with the class `fsfm-dark` or `fsfm-light`. For
the option that sets these from code, see
[Appearance](#appearance-colours-fonts-metrics).

**A toggle has to set one of the two classes, not remove one.** Removing `fsfm-dark` does
not mean "light theme" — it hands control back to the system, and on a machine in dark
mode the light theme cannot be chosen that way at all: the button looks broken in the
evenings. That is the case `fsfm-light` exists for.

```js
// Three states: until a choice is made, follow the system.
let theme = 'auto';
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
const effective = () => (theme === 'auto' ? (darkQuery.matches ? 'dark' : 'light') : theme);

function applyTheme() {
  manager.root.classList.toggle('fsfm-dark', theme === 'dark');
  manager.root.classList.toggle('fsfm-light', theme === 'light');
}

button.addEventListener('click', () => {
  theme = effective() === 'dark' ? 'light' : 'dark';
  applyTheme();
});
```

The classes live on `manager.root`, so after `destroy()` and a remount they have to be
set again.

```css
.fsfm {
  --fsfm-accent: #7c3aed;
  --fsfm-radius: 10px;
  --fsfm-tile-width: 140px;
  --fsfm-sidebar-width: 300px;
}
```

The widget is declared as a CSS container, so its responsiveness depends on **its own**
width rather than the window's: a narrow column on a wide screen collapses the labels and
the tree exactly as a phone does.

---

## Development

```bash
npm install
npm run dev          # API + Vite with HMR -> http://localhost:5173
npm test             # 467 tests: paths, fs operations, permissions, ZIP, HTTP end-to-end,
                     #   document and spreadsheet formats, search, terminal, languages
npm run build        # library -> dist/
npm run build:demo   # demo page -> demo-dist/
npm start            # build the demo and serve it without Vite
```

Demo server options: `--port`, `--root`, `--read-only`.

Toolbar icons are inlined from `bootstrap-icons` at generation time
(`npm run gen:icons`), so there is no icon font at runtime.

### Layout

```
src/                the widget
  file-manager.js     the orchestrator, the eight operations
  core/               provider, formatting, language, theme
    format.js             sizes, dates, splitting and joining paths
    i18n.js               dictionary lookup, plural rules, fallback
    theme.js              host colours, fonts and metrics
    terminal-commands.js  the terminal's command language, DOM-free
  locales/            en, uk, es, de, fr — one plain object each
  ui/                 tree, list, dialogs, menu, toasts, icons, viewer,
                      properties, permissions, search, spreadsheet/code/document editors
    highlight.js        highlighting tokenisers, no dependencies
    terminal.js         the terminal panel: prompt, history, completion
  core/mode.js        rendering permission bits (the server parses them itself)
server/             the back end
  http.js             the small router the handler runs on; no framework
  router.js           the routes (the public API)
  fs-ops.js           filesystem operations, virtual paths only
  safe-path.js        path resolution and root containment
  text.js             reading and writing text: encoding, BOM, line endings
  search.js           tree walk, masks, matching; no side effects
  search-worker.js    the thread it runs in, so it can be killed
  sheet/              spreadsheets
    model.js            the neutral workbook every format reduces to
    xml.js              minimal XML for xlsx and ods
    csv.js              delimiters, encodings, quoting
    xlsx.js             SpreadsheetML over our own ZIP
    ods.js              OpenDocument; repeats are not expanded
    cfb.js              the OLE2 container for xls and doc
    xls.js              BIFF8 records
  doc/                documents
    model.js            the neutral document; a block remembers its own markup
    docx.js             WordprocessingML over our own ZIP
    odt.js              OpenDocument Text; styling through a style table
    doc.js              Word 97: FIB, piece table, formatted-property pages
    pdf/                PDF
      objects.js          object types, stream filters, writing
      document.js         object graph, page tree, assembling a new file
      text.js             text extraction: font encodings and geometry
  archive/            packing and unpacking
    formats.js          the format table and detection
    tar.js              our own tar: reading and writing
    zip-read.js         our own zip reader (the writer is in ../zip.js)
    safe-entry.js       entry-name checks: refuse, do not repair
    tools.js            external compressors, as byte streams only
  mode.js             parsing and checking permission bits
  thumbnail.js        thumbnails; sharp is an optional dependency
  zip.js              streaming ZIP with Zip64, no dependencies
types/              hand-written .d.ts, checked by `npm run typecheck`
demo/               the demonstration page
test/               tests
legacy/             the original single-file prototype
```

---

## TypeScript

Types ship with the package — no separate `@types/…` needed.

```ts
import { FileManager, type Entry } from 'bookmark-file-manager';
import { createFileManagerHandler, type AuthorizeContext } from 'bookmark-file-manager/server';
```

`npm run typecheck` checks them under `strict`, including a file that uses the API the
way a consumer would.

The server half has no framework dependency at all: `bookmark-file-manager/server`
imports cleanly with nothing else installed, and the handler works over node's own
request and response objects.

---

## Limitations

- ZIP is written without encryption and without preserving unix permissions.
- A move across devices is a copy followed by a delete, so it is not atomic.
- A directory listing is drawn in chunks as you scroll, but is not virtualised: nodes
  created once stay in the DOM. For directories of hundreds of thousands of entries, lean
  on search and `maxListEntries`.
- PDF thumbnails are not generated (see "Preview and thumbnails"); a PDF opens in full in
  the viewer.
- Large `.bmp` files get no thumbnail: libvips cannot read them, and serving an
  uncompressed file whole for the sake of a tile is not on. A `.bmp` opens fine in the
  viewer.
- Animation in `gif` and `webp` shows as the first frame in a thumbnail; in the viewer it
  plays, since the file is served to the browser as it is.
- Permission changes are POSIX only. Owner and group cannot be changed: `chown` needs
  privileges a web process should not have.
- RAR is extract-only (see "Archives"). Encrypted entries are skipped: password entry is
  not supported.
- Multi-volume archives are not supported.
- The spreadsheet editor saves values, not formatting, charts or macros (see
  "Spreadsheets"). Formulas are not evaluated.
- For `xls` the formula text is not recovered — only its stored result.
- PDF text is extracted, not edited: a page is glyphs placed at coordinates, not
  paragraphs (see "Documents"). Page operations are available.
- PDF text extraction is an approximation: lines and spaces are reconstructed from
  geometry, so in multi-column layouts and tables the order can differ from the readable
  one. A scan has no text at all, and `textLayer` says so.
- PDF page thumbnails are not drawn: the page editor shows a page's number and
  proportions.
- Saving to `.doc` rebuilds the file in full — images and text boxes are lost and list
  markers become indentation (see "Documents"). `.docx` and `.odt` keep everything.
- Word 6.0/95 is not read: it has a different FIB with no offset table. Encrypted files —
  neither `.doc` nor PDF — do not open.
- The document editor edits text and its styling (bold, italic, underline). Colours,
  fonts, sizes and alignment are preserved in untouched paragraphs but cannot be edited.
- Tables inside a document appear as a locked block: their content is preserved but not
  editable.
- Highlighting is a tokeniser, not a parser (see "Code editor"): interpolation in
  template strings, nested languages in HTML and the ambiguity of `/` are handled
  approximately.
- The code editor does not wrap lines — long ones scroll horizontally.
- Search is not indexed: every query walks the tree. For directories of hundreds of
  thousands of files, cap `maxEntries` and the starting folder.
- Searching contents does not look inside archives, PDFs or Office documents — text files
  only.
- A mask in a content search is matched against the whole line rather than part of it;
  the widget warns about that combination.
- The terminal runs the file manager's commands, not system ones. It cannot start a
  program, build a project or run `git` — and should not: that would be remote code
  execution in an embeddable widget.
- It has no pipes, no output redirection and no variables: commands stand alone, and `|`
  and `>` are not parsed.
- `mv` with a new name into another folder is two API calls (move, then rename); if the
  second fails, that is reported plainly.
- The widget uses `color-mix()`, `:has()` and container queries — a 2023 browser or newer
  is required.
- Touch devices: the layout adapts to width, but the toolbar targets are ~30 px rather
  than the 44 px Apple and Google recommend, a long press does not open the context menu,
  tooltips are unreachable, and drag & drop is HTML5 and does not work by touch. On a
  tablet, turn `toolbarActions: true` on so the operations remain reachable.
- A file name containing `/ \ : * ? " < > |` cannot be created (Windows portability),
  though an existing one with such characters is listed and can be renamed.
- Node 18+.

## Licence

MIT © Mykhailo Kravtsov. Toolbar icons are [Bootstrap Icons](https://icons.getbootstrap.com/),
MIT.
