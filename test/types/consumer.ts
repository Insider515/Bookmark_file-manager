/**
 * Not run at runtime — `npm run typecheck` compiles it. It exists so the
 * published type surface is exercised the way a consumer would use it, rather
 * than only being checked for internal consistency.
 */
import { FileManager, createFileManager, type Entry, type Provider } from '../../types/index.js';
import { createFileManagerRouter, FsOps, type AuthorizeContext } from '../../types/server.js';

const manager = new FileManager('#host', {
  endpoint: '/api/files',
  view: 'grid',
  permissions: { remove: false },
  customizeThumbnail: (entry: Entry) => (entry.isDirectory ? null : '<svg/>'),
});

manager.on('uploaded', ({ entries, failures, destination }) => {
  const names: string[] = entries.map((entry) => entry.name);
  console.log(names, failures.length, destination.toUpperCase());
});
manager.on('deleted', ({ paths }) => paths.forEach((path) => console.log(path)));
void manager.ready.then((instance) => instance.destroy());
void createFileManager('#other');

// A custom provider only has to honour the documented shape.
const provider: Pick<Provider, 'list'> = {
  list: () => ({ path: '/', name: '', parent: null, items: [] }),
};
void provider;

const router = createFileManagerRouter({
  root: './storage',
  exposeUsage: false,
  allowedOrigins: ['https://dashboard.example'],
  maxConcurrentUploads: 4,
  authorize: (_req, _action, context: AuthorizeContext) =>
    context.paths.every((path) => path.startsWith('/public')),
});
void router.fsOps.usage();

const ops = new FsOps({ root: './storage', readOnly: true });
void ops.init().then((ready) => ready.list('/'));

// --- preview and thumbnails ---------------------------------------------
import { canPreview, previewKind, openPreview } from '../../types/index.js';
import { canThumbnail, THUMBNAILABLE } from '../../types/server.js';

const withPreview = new FileManager('#host', { preview: true, thumbnails: false });
withPreview.on('preview', ({ entry }) => console.log(entry.path));
const opened: boolean = withPreview.preview();
void opened;

const sample: Entry = { name: 'a.png', path: '/a.png', isDirectory: false, size: 1, modified: '' };
if (canPreview(sample) && previewKind(sample) === 'image') {
  const viewer = openPreview({
    container: document.body,
    provider: { downloadUrl: (p) => String(p) },
    entries: [sample],
    entry: sample,
    canDownload: true,
  });
  viewer.close();
}
void canThumbnail('png');
void THUMBNAILABLE.has('ico');

createFileManagerRouter({ root: './s', thumbnails: true, thumbnailSizes: [64, 128], maxConcurrentThumbnails: 2 });

// --- permissions and properties -----------------------------------------
import {
  propertiesDialog,
  permissionsDialog,
  formatModeText,
  withExecutable,
  type EntryProperties,
  type ModeChange,
} from '../../types/index.js';
import { parseOctalMode as parseServerMode, PERMISSION_MASK } from '../../types/server.js';

const gated = new FileManager('#host', { permissions: { chmod: true } });
gated.on('chmod', ({ entries }) => entries.forEach((e: EntryProperties) => console.log(e.modeOctal)));
void gated.showProperties();
void gated.editPermissions();
void gated.setExecutable(true);
void gated.can('chmod');

const change: ModeChange = { mode: '755', recursive: true };
void change;
// @ts-expect-error mode and executable are mutually exclusive
const bad: ModeChange = { mode: '755', executable: true };
void bad;

void formatModeText(0o755);
void withExecutable(0o644, true);
void parseServerMode('644');
void PERMISSION_MASK;

declare const props: EntryProperties;
void propertiesDialog({ container: document.body, provider: { properties: async () => props }, entry: props });
void permissionsDialog({ container: document.body, details: props });

createFileManagerRouter({ root: './s', permissions: { chmod: true }, maxSizeWalkEntries: 1000 });

// --- toolbar actions -----------------------------------------------------
import { TOOLBAR_ACTIONS, type ToolbarAction } from '../../types/index.js';

void new FileManager('#host');                                  // default: no action buttons
void new FileManager('#host', { toolbarActions: true });        // all eight
void new FileManager('#host', { toolbarActions: ['upload', 'delete'] });
void new FileManager('#host', { toolbarActions: false });
// @ts-expect-error not one of the eight
void new FileManager('#host', { toolbarActions: ['refresh'] });
const every: readonly ToolbarAction[] = TOOLBAR_ACTIONS;
void every;

// --- archives -------------------------------------------------------------
import {
  archiveDialog,
  archiveFormatOf,
  buildExtensionIndex,
  type ArchiveCapabilities,
  type ArchiveFormatId,
  type ExtractResult,
} from '../../types/index.js';
import { ArchiveService, isArchiveName, safeEntryPath } from '../../types/server.js';

const packer = new FileManager('#host', { permissions: { archive: true, extract: true } });
packer.on('archived', ({ archive, format }) => console.log(archive.name, format));
packer.on('extracted', ({ result }: { result: ExtractResult }) =>
  result.skipped.forEach((s) => console.warn(s.name, s.reason))
);
void packer.compress();
void packer.extract();
void packer.showArchiveContents();

declare const caps: ArchiveCapabilities;
const zipWrites: boolean = caps.zip.write;
const rarWrites: boolean = caps.rar.write; // always false at runtime, still boolean
void zipWrites; void rarWrites;
const chosen: ArchiveFormatId = 'tar.zst';
void chosen;
// @ts-expect-error not a format this router knows
const nope: ArchiveFormatId = 'lzh';
void nope;

const index = buildExtensionIndex(caps);
void archiveFormatOf('a.tar.gz', index);
void archiveDialog({ container: document.body, formats: caps, selection: [], suggestedBase: 'x' });

void isArchiveName('a.7z');
const checked = safeEntryPath('../evil');
if (!checked.ok) console.log(checked.reason);

const svc = new ArchiveService({ limits: { maxTotalBytes: 1024 } });
void svc.init({ tools: false }).then((s) => s.capabilities());

createFileManagerRouter({ root: './s', archiveTools: false, archiveLimits: { maxEntries: 10 } });

// --- image viewing --------------------------------------------------------
import { needsRender, type ImageViewCapabilities } from '../../types/index.js';
import { probeHeifSupport, VIEWABLE, RENDER_WIDTHS } from '../../types/server.js';

declare const view: ImageViewCapabilities;
const nativeList: string[] = view.native;
const heif: 'sharp' | 'tool' | false = view.heif;
void nativeList; void heif;
void needsRender(sample);
void VIEWABLE.has('tiff');
void RENDER_WIDTHS[0];
void probeHeifSupport().then((mode) => mode !== false);
createFileManagerRouter({ root: './s', maxQueuedThumbnails: 8 });

// --- spreadsheets ---------------------------------------------------------
import {
  columnName,
  openSheetEditor,
  type SheetCapabilities,
  type SheetFormatId,
  type Workbook,
} from '../../types/index.js';
import { SheetService, isSheetName } from '../../types/server.js';

const editor = new FileManager('#host', { sheets: true });
editor.on('sheetsaved', ({ result }) => result.warnings.forEach((w) => console.warn(w)));
void editor.openSheet();

declare const sheetCaps: SheetCapabilities;
const csvSingle: boolean = sheetCaps.csv.singleSheet;
void csvSingle;
const fmt: SheetFormatId = 'ods';
void fmt;
// @ts-expect-error not a spreadsheet format this router knows
const notFmt: SheetFormatId = 'numbers';
void notFmt;

declare const book: Workbook;
void openSheetEditor({
  container: document.body,
  entry: sample,
  workbook: book,
  formats: sheetCaps,
  onSave: async () => ({ path: '/x.xlsx', format: 'xlsx', warnings: [], entry: sample }),
});
void columnName(27);
void isSheetName('a.xlsx');
void new SheetService({ limits: { maxRows: 10 } }).capabilities();
createFileManagerRouter({ root: './s', sheetLimits: { maxCells: 100 }, maxSheetBody: '8mb' });

// --- copy path ------------------------------------------------------------
import { copyToClipboard } from '../../types/index.js';
const copier = new FileManager('#host');
copier.on('pathcopied', ({ paths, text }) => console.log(paths.length, text));
void copier.copyPath();
void copier.copyPath('/Documents');
void copier.copyPath([sample]);
void copyToClipboard('/x/y').then((ok: boolean) => ok);

// --- code editor ----------------------------------------------------------
import {
  highlight,
  languageOf,
  openCodeEditor,
  type LanguageId,
  type TextDocument,
} from '../../types/index.js';
import { looksBinary, readTextFile } from '../../types/server.js';

const coder = new FileManager('#host', { code: true });
coder.on('codesaved', ({ result }) => result.warnings.forEach((w) => console.warn(w)));
void coder.openCode();

const lang: LanguageId | null = languageOf('a.d.ts');
void lang;
// @ts-expect-error not a language this editor knows
const badLang: LanguageId = 'rust';
void badLang;
void highlight('const a = 1', 'ts');

declare const doc: TextDocument;
void openCodeEditor({
  container: document.body,
  entry: sample,
  document: doc,
  onSave: async () => ({ path: '/a.ts', warnings: [], entry: sample }),
});
void looksBinary(Buffer.from([0]));
void readTextFile('/x', { limits: { maxBytes: 100 } });
createFileManagerRouter({ root: './s', textLimits: { maxBytes: 1024 } });

// --- documents ------------------------------------------------------------

import {
  openDocumentEditor,
  type DocumentBlock,
  type DocumentFormatId,
  type OpenedDocument,
  type PdfPagePlanItem,
  type RichDocument,
} from '../../types/index.js';
import { DocumentService } from '../../types/server.js';

const writer = new FileManager('#host', { documents: true });
writer.on('documentsaved', ({ result }) => console.log(result.path));
writer.on('documentopen', (event) => {
  // The two shapes are told apart by `format`, which is what the editor does.
  const which = event.document;
  if (which.format === 'pdf') console.log(which.pages.length, which.textLayer);
  else console.log(which.blocks.length, which.preserves);
});
void writer.openDocument();

const format: DocumentFormatId = 'docx';
void format;
// @ts-expect-error rtf is not one of the four formats
const badFormat: DocumentFormatId = 'rtf';
void badFormat;

const block: DocumentBlock = { type: 'heading', level: 2, runs: [{ text: 'Заголовок', bold: true }] };
// @ts-expect-error a block always carries runs
const badBlock: DocumentBlock = { type: 'paragraph' };
void badBlock;

const plan: PdfPagePlanItem[] = [{ page: 0, rotate: 90 }, { source: 1, page: 2 }];
void plan;

declare const openedDoc: OpenedDocument;
void openDocumentEditor({
  container: document.body,
  entry: sample,
  document: openedDoc,
  onSave: async () => ({ path: '/a.docx', format: 'docx', warnings: [], entry: sample }),
  onPages: async () => ({ path: '/a.pdf', pages: 2, entry: sample }),
});

declare const rich: RichDocument;
void rich.blocks[0].id;

const documents = new DocumentService({ limits: { maxBlocks: 100 } });
void documents.capabilities().pdf.pages;
void documents.write('/tmp/a.docx', 'a.docx', { blocks: [block] }, { source: '/tmp/b.docx' });
void documents.pages(['/tmp/a.pdf'], plan, '/tmp/out.pdf');
createFileManagerRouter({ root: './s', documentLimits: { maxBlocks: 1000 } });

// --- search ---------------------------------------------------------------

import {
  openSearchDialog,
  type SearchMatch,
  type SearchMode,
  type SearchOptions,
  type SearchResult,
} from '../../types/index.js';
import { globToRegExp, normaliseSearchOptions } from '../../types/server.js';

const finder = new FileManager('#host', { search: true });
finder.on('search', ({ result }) => console.log(result.matches.length, result.truncated));
finder.on('reveal', ({ entry }) => console.log(entry.path));
void finder.openSearch('звіт', { path: '/архів' });
void finder.reveal(sample);

const mode: SearchMode = 'glob';
void mode;
// @ts-expect-error fuzzy is not one of the three modes
const badMode: SearchMode = 'fuzzy';
void badMode;

const searchOptions: SearchOptions = {
  query: '*.{js,ts}',
  mode: 'glob',
  type: 'file',
  scope: 'both',
  extensions: ['js', 'ts'],
  caseSensitive: true,
};
void searchOptions;

declare const found: SearchResult;
const first: SearchMatch | undefined = found.matches[0];
// A content hit carries lines; a name hit does not, so the field is optional.
void first?.lines?.[0].line;
void first?.parent;

void openSearchDialog({
  container: document.body,
  path: '/',
  onSearch: async () => found,
});

void globToRegExp('*.js', { caseSensitive: false });
void normaliseSearchOptions({ query: 'a', mode: 'regex' });
createFileManagerRouter({ root: './s', searchLimits: { maxResults: 50, timeout: 2000 } });

// --- terminal -------------------------------------------------------------

import {
  Terminal,
  columnize,
  resolvePath,
  runCommand,
  tokenize,
  type TerminalLine,
  type TerminalTone,
} from '../../types/index.js';

const shell = new FileManager('#host', { terminal: true });
shell.on('terminaltoggle', ({ visible }) => console.log(visible));
void shell.toggleTerminal(false);
void shell.toggleTerminal();
shell.termNote('щось сталося');
void shell.terminalVisible;
// Null when the option is off, so it has to be checked before use.
void shell.terminal?.cwd;

const tone: TerminalTone = 'error';
void tone;
// @ts-expect-error there is no such tone
const badTone: TerminalTone = 'загадковий';
void badTone;

const outLine: TerminalLine = { text: 'готово', tone: 'success' };
declare const fullProvider: Provider;
const term = new Terminal({ provider: fullProvider, path: '/', can: (action) => action !== 'remove' });
term.print(outLine);
term.note('дійшло');
void term.run('ls -l');

void tokenize('rm "Мій звіт.txt"').tokens;
void resolvePath('/а/б', '../в');
void columnize(['a', 'b'], 80);
void runCommand('ls', {
  provider: fullProvider,
  cwd: '/',
  width: 80,
  maxOutputLines: 500,
  setCwd: () => {},
  refresh: () => {},
  open: () => {},
  download: () => {},
  clear: () => {},
});

// --- address bar ----------------------------------------------------------

const addressed = new FileManager('#host');
addressed.on('pathedit', ({ path, entry }) => console.log(path, entry.name));
// Null when there is no crumb bar, so it has to be checked before use.
const pathInput: HTMLInputElement | null = addressed.editPath();
void pathInput?.value;

// --- toolbar ---------------------------------------------------------------

import { TOOLBAR_PRIMARY_ACTIONS } from '../../types/index.js';

const everything = new FileManager('#host', { toolbarActions: true });
void everything;
new FileManager('#host', { toolbarActions: TOOLBAR_PRIMARY_ACTIONS as ToolbarAction[] });
new FileManager('#host', { toolbarActions: ['extract', 'properties', 'selectAll'] });
// @ts-expect-error there is no such toolbar action
new FileManager('#host', { toolbarActions: ['teleport'] });
void TOOLBAR_ACTIONS.length;

// ---------------------------------------------------------------- language
import {
  createTranslator,
  resolveLocale,
  DEFAULT_LOCALE,
  LOCALES,
  PLURAL_RULES,
  uk,
  type LocaleDictionary,
  type LocaleId,
} from 'bookmark-file-manager';

// A shipped id.
new FileManager('#host', { locale: 'de' });
// A regional tag.
new FileManager('#host', { locale: 'de-AT' });
// A dictionary object.
new FileManager('#host', { locale: uk });

// A host's own language, partial on purpose.
const swedish: LocaleDictionary = {
  id: 'sv',
  name: 'Svenska',
  tag: 'sv',
  plural: PLURAL_RULES.default,
  strings: {
    'common.save': 'Spara',
    'count.files': { one: '{n} fil', other: '{n} filer' },
  },
};
new FileManager('#host', { locale: swedish });

const french: LocaleDictionary = resolveLocale('fr', LOCALES, DEFAULT_LOCALE);
const translate = createTranslator(french, DEFAULT_LOCALE);
const label: string = translate('action.newFolder');
const counted: string = translate('count.files', { n: 3 });
const ids: LocaleId[] = ['en', 'uk', 'es', 'de', 'fr'];

void label;
void counted;
void ids;

// ------------------------------------------------- mounting without Express
import http from 'node:http';
import {
  createFileManagerHandler,
  parseSize,
  type FileManagerHandler,
} from 'bookmark-file-manager/server';

const files: FileManagerHandler = createFileManagerHandler({
  root: './public',
  basePath: '/api/files',
});

// bare node:http
http.createServer(files);

// a framework that hands over the raw objects
declare const rawReq: http.IncomingMessage;
declare const rawRes: http.ServerResponse;
const answered: Promise<boolean> = files(rawReq, rawRes);

// still reachable, still typed
const backing = files.fsOps;
const routes: Array<{ method: string; path: string }> = files.paths();
// `createFileManagerRouter` is imported at the top of this file already.
const stillWorks: FileManagerHandler = createFileManagerRouter({ root: './public' });
const bytes: number = parseSize('16mb');

void answered;
void backing;
void routes;
void stillWorks;
void bytes;

// -------------------------------------------------- colours, fonts, metrics
import { buildThemeCss, type Theme, type ThemeColors } from 'bookmark-file-manager';

// Nothing passed: the built-in palette.
new FileManager('#host', {});

const brand: ThemeColors = {
  accent: '#7c3aed',
  accentHover: '#6d28d9',
  accentSoft: '#ede9fe',
  tokens: { string: '#9ece6a', keyword: '#bb9af7' },
};

const theme: Theme = {
  font: "'Inter', system-ui, sans-serif",
  fontSize: '15px',
  codeFont: "'JetBrains Mono', monospace",
  radius: '2px',
  sidebarWidth: '280px',
  rowHeight: '44px',
  colors: brand,
  light: { bg: '#fffdf7', text: '#2b2415' },
  dark: { bg: '#0b1020', accent: '#a78bfa' },
  // Anything the named keys do not cover.
  '--fsfm-tile-width': '150px',
};

new FileManager('#host', { theme });
const sheet: string = buildThemeCss('[data-fsfm-theme="1"]', theme);
void sheet;
