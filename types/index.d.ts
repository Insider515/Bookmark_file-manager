/**
 * Type definitions for the bookmark-file-manager widget.
 * The server-side router is typed separately in ./server.d.ts.
 */

/**
 * Every action the toolbar can show.
 *
 * The first eight are the primary operations; the rest mirror the context
 * menu, and exist for touch devices where there is no right-click to open it.
 */
export type ToolbarAction =
  | 'newFolder'
  | 'newFile'
  | 'move'
  | 'copy'
  | 'rename'
  | 'delete'
  | 'download'
  | 'upload'
  | 'open'
  | 'preview'
  | 'sheet'
  | 'code'
  | 'document'
  | 'compress'
  | 'extract'
  | 'archiveContents'
  | 'executable'
  | 'permissions'
  | 'copyPath'
  | 'properties'
  | 'selectAll';

/** The same ids as a runtime array, in the order the toolbar lays them out. */
export declare const TOOLBAR_ACTIONS: readonly ToolbarAction[];

/** The eight the toolbar used to carry, for a host that wants only those. */
export declare const TOOLBAR_PRIMARY_ACTIONS: readonly ToolbarAction[];

/** Every archive format the router knows. */
export type ArchiveFormatId =
  | 'zip'
  | '7z'
  | 'rar'
  | 'tar'
  | 'tar.gz'
  | 'tar.bz2'
  | 'tar.xz'
  | 'tar.zst'
  | 'gz'
  | 'bz2'
  | 'xz'
  | 'zst';

/** What one format can do *on this server*, not in principle. */
export interface ArchiveCapability {
  read: boolean;
  write: boolean;
  /** True for rar: no free encoder exists, so write is never true. */
  readOnly: boolean;
  label: string;
  /** 'container' | 'tar' | 'filter'; a filter holds exactly one file. */
  kind: 'container' | 'tar' | 'filter';
  /** Spellings that map to this format; the first is used when naming. */
  extensions: string[];
}

export type ArchiveCapabilities = Record<ArchiveFormatId, ArchiveCapability>;

export interface ArchiveEntry {
  name: string;
  size: number | null;
  isDirectory: boolean;
  type: 'file' | 'directory' | 'symlink' | 'link' | 'other';
  encrypted: boolean;
}

export interface ArchiveContents {
  format: ArchiveFormatId;
  label: string;
  items: ArchiveEntry[];
}

/** One entry the extractor refused, and why. */
export interface SkippedEntry {
  name: string;
  reason: string;
}

export interface ExtractResult {
  /** Virtual path of what was produced. */
  path: string;
  format: ArchiveFormatId;
  written: number;
  bytes: number;
  /** Never silently empty: a refused entry is reported, not dropped. */
  skipped: SkippedEntry[];
  entry: Entry;
}

/**
 * What the viewer can show on this server.
 *
 * `native` goes to the browser byte for byte. `render` has to be converted
 * first and lists only what this machine genuinely can convert — TIFF needs
 * sharp, HEIC needs sharp with an HEVC decoder or an external converter.
 */
export interface ImageViewCapabilities {
  native: string[];
  render: string[];
  widths: number[];
  /** How HEIC is handled: 'sharp', 'tool', or false. */
  heif: 'sharp' | 'tool' | false;
}

/** Spreadsheet formats, all read and written without an external tool. */
export type SheetFormatId = 'csv' | 'xlsx' | 'xls' | 'ods';

export interface SheetCapability {
  read: boolean;
  write: boolean;
  label: string;
  extensions: string[];
  /** True for csv, which has nowhere to put a second sheet. */
  singleSheet: boolean;
}

export type SheetCapabilities = Record<SheetFormatId, SheetCapability>;

export type SheetCellType = 'empty' | 'string' | 'number' | 'boolean' | 'date';

export interface SheetCell {
  type: SheetCellType;
  value: string | number | boolean | null;
  /** The expression whose cached result `value` is. Nothing evaluates it. */
  formula?: string;
  /** What the user typed; the server retypes from this rather than trusting `type`. */
  text?: string;
}

export interface Sheet {
  name: string;
  rows: SheetCell[][];
}

export interface Workbook {
  sheets: Sheet[];
  meta: {
    format?: SheetFormatId;
    /** csv only: preserved so a saved file keeps the shape it arrived in. */
    delimiter?: string;
    newline?: string;
    encoding?: string;
    bom?: boolean;
  };
}

/** A line of terminal output; `tone` only picks the colour. */
export type TerminalTone = 'out' | 'muted' | 'error' | 'success' | 'prompt';

export interface TerminalLine {
  text: string;
  tone: TerminalTone;
}

/**
 * What a command needs to do its work.
 *
 * Everything reaches the server through `provider`, which is the whole
 * security model: the terminal can do what the widget can do and nothing more.
 * There is no shell here and nothing spawns a process.
 */
export interface TerminalContext {
  provider: Provider;
  cwd: string;
  /** Characters across, for `ls` columns. */
  width: number;
  maxOutputLines: number;
  can?: (action: PermissionKey) => boolean;
  setCwd: (path: string) => void | Promise<void>;
  refresh: () => void | Promise<void>;
  open: (entry: Entry) => void | Promise<void>;
  download: (paths: string[]) => void | Promise<void>;
  clear: () => void;
}

export interface TerminalCommand {
  usage: string;
  summary: string;
  /** The permission this command writes with, if it writes. */
  needs?: PermissionKey;
  run: (args: string[], ctx: TerminalContext) => Promise<TerminalLine[]>;
}

export declare const COMMANDS: Record<string, TerminalCommand>;
export declare const COMMAND_NAMES: string[];

/** Split a command line, honouring quotes and backslash escapes. */
export declare function tokenize(input: string): { tokens: string[]; unterminated: boolean };

/** Resolve a path against a working directory. `~` is the manager's root. */
export declare function resolvePath(cwd: string, input: string): string;

/** Lay names out in columns that fit a width, the way `ls` does. */
export declare function columnize(names: string[], width?: number): string[];

/** Run one line. Never throws: failures come back as error lines. */
export declare function runCommand(
  input: string,
  ctx: TerminalContext
): Promise<{ lines: TerminalLine[]; command: string | null }>;

/** The terminal panel at the bottom of the widget. */
export declare class Terminal {
  constructor(config: {
    provider: Provider;
    path?: string;
    can?: (action: PermissionKey) => boolean;
    onNavigate?: (path: string) => unknown;
    onRefresh?: () => unknown;
    onOpen?: (entry: Entry) => unknown;
    onDownload?: (paths: string[]) => unknown;
  });
  readonly element: HTMLElement;
  readonly cwd: string;
  /** Move the prompt without running `cd`. */
  setPath(path: string): void;
  focus(): void;
  clear(): void;
  print(lines: TerminalLine[] | TerminalLine): void;
  /** Print a dimmed line — used to echo what the widget did. */
  note(text: string): void;
  run(input: string): Promise<void>;
}

/** How the query is interpreted. */
export type SearchMode = 'substring' | 'glob' | 'regex';
/** What kind of entry may match. */
export type SearchType = 'all' | 'file' | 'directory';
/** Where to look: the name, the contents, or both. */
export type SearchScope = 'name' | 'content' | 'both';

export interface SearchCapabilities {
  modes: SearchMode[];
  types: SearchType[];
  /**
   * Whether this deployment allows searching inside files. Follows the
   * `download` permission: being able to see a name is not the same as being
   * able to read what is in it.
   */
  content: boolean;
  maxResults: number;
  maxDepth: number;
  /** Milliseconds a search gives itself before stopping and saying so. */
  timeout: number;
}

export interface SearchOptions {
  /** May be empty only when `extensions` is not. */
  query?: string;
  mode?: SearchMode;
  type?: SearchType;
  scope?: SearchScope;
  /** Names, with or without dots: `'js, ts'` or `['js', 'ts']`. */
  extensions?: string | string[];
  /** Off by default — the common case is not caring about case. */
  caseSensitive?: boolean;
  maxDepth?: number;
  limit?: number;
}

/** One matching line inside a file. */
export interface SearchMatchLine {
  /** 1-based. */
  line: number;
  /** Where the match starts within `text`, after any trimming. */
  column: number;
  length: number;
  /** A window of the line, elided with … when the line is long. */
  text: string;
}

export interface SearchMatch extends Entry {
  /** The folder holding it — the whole point of a recursive result. */
  parent: string;
  matchedIn: 'name' | 'content';
  /** Present only for a content match. */
  lines?: SearchMatchLine[];
}

export interface SearchResult {
  /** Where the search started. */
  path: string;
  query: string;
  matches: SearchMatch[];
  /** Entries looked at, match or not. */
  scanned: number;
  /** True when a limit was reached: there may be more than this. */
  truncated: boolean;
  /** True when the deadline stopped the walk. */
  timedOut: boolean;
  elapsed: number;
}

/** Document formats, all read and written without an external tool. */
export type DocumentFormatId = 'docx' | 'odt' | 'doc' | 'pdf';

export interface DocumentCapability {
  read: boolean;
  /** False for PDF: its text is not editable here. */
  write: boolean;
  /** True for PDF: pages can be deleted, reordered, rotated, split, merged. */
  pages: boolean;
  /**
   * Whether saving keeps the parts of the file the editor does not model.
   * False for .doc, which is rebuilt from nothing on every save.
   */
  preserves: boolean;
  kind: 'rich' | 'pdf';
  label: string;
  extensions: string[];
}

export type DocumentCapabilities = Record<DocumentFormatId, DocumentCapability>;

export type DocumentBlockType = 'paragraph' | 'heading' | 'listItem' | 'opaque';

/** A span of text sharing its marks. */
export interface DocumentRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}

export interface DocumentBlock {
  type: DocumentBlockType;
  runs: DocumentRun[];
  /** 1–6 for a heading, 1–9 for a list item. */
  level?: number;
  ordered?: boolean;
  /** The style name in the source file, where it had one. */
  style?: string | null;
  /**
   * The handle the server hands out at read time. Send it back unchanged: it
   * is how an untouched block is matched to the markup it came from, and how
   * a block the editor cannot show is restored.
   */
  id?: number;
  /** Structure the editor cannot represent; shown locked, saved as it was. */
  readOnly?: boolean;
  /** Carried through the editor without being displayed. */
  hidden?: boolean;
  name?: string;
  inTable?: boolean;
}

/** What /document returns for docx, odt and doc. */
export interface RichDocument {
  path: string;
  name: string;
  format: Exclude<DocumentFormatId, 'pdf'>;
  kind: 'rich';
  preserves: boolean;
  blocks: DocumentBlock[];
  meta: { format?: DocumentFormatId };
}

export interface PdfPage {
  /** Position in the source file, which is what a page plan refers to. */
  index: number;
  /** Points, with a quarter turn already applied. */
  width: number;
  height: number;
  rotation: 0 | 90 | 180 | 270;
  /** Extracted, not stored: empty for a scan. */
  text: string;
}

/** What /document returns for a PDF. */
export interface PdfDocumentInfo {
  path: string;
  name: string;
  format: 'pdf';
  pages: PdfPage[];
  /** Whether text could be extracted from every page, some, or none. */
  textLayer: 'full' | 'partial' | 'none';
}

export type OpenedDocument = RichDocument | PdfDocumentInfo;

export interface DocumentSaveResult {
  path: string;
  format: DocumentFormatId;
  /** Non-fatal notes, e.g. list markers lost when saving to .doc. */
  warnings: string[];
  entry: Entry;
}

/** One page of the result, and where it comes from. */
export interface PdfPagePlanItem {
  /** Index into the sources: 0 is the file being edited. */
  source?: number;
  /** Index of the page within that file. */
  page: number;
  /** Absolute rotation in degrees; omitted keeps the page's own. */
  rotate?: number;
}

export interface PdfPagesResult {
  path: string;
  pages: number;
  entry: Entry;
}

/** What /sheet returns: a workbook plus where it came from. */
export interface OpenedWorkbook extends Workbook {
  path: string;
  name: string;
}

export interface SheetSaveResult {
  path: string;
  format: SheetFormatId;
  /** Non-fatal notes, e.g. a windows-1251 file re-encoded as UTF-8. */
  warnings: string[];
  entry: Entry;
}

/** Languages the code editor highlights. */
export type LanguageId =
  | 'txt' | 'js' | 'ts' | 'tsx' | 'json' | 'xml' | 'html'
  | 'css' | 'scss' | 'sass' | 'less' | 'styl'
  | 'md' | 'yaml' | 'sh' | 'py' | 'php';

/** What /text returns for a file the editor can open. */
export interface TextDocument {
  path: string;
  name: string;
  /** Line endings normalised to LF; the original is in `newline`. */
  text: string;
  encoding: string;
  bom: boolean;
  /** '\n' or '\r\n' — reapplied on save so an edit is not a whole-file diff. */
  newline: string;
  /** True when the file mixed them; saving settles on one. */
  mixedNewlines: boolean;
  bytes: number;
}

export interface TextSaveResult {
  path: string;
  /** Non-fatal notes, e.g. a windows-1251 file re-encoded as UTF-8. */
  warnings: string[];
  entry: Entry;
}

export type PermissionKey =
  | 'create'
  | 'upload'
  | 'move'
  | 'copy'
  | 'rename'
  | 'remove'
  | 'download'
  | 'chmod'
  | 'archive'
  | 'extract'
  | 'edit';

export type Permissions = Partial<Record<PermissionKey, boolean>>;

/** One directory child, as the server describes it. Paths are always virtual. */
export interface Entry {
  name: string;
  path: string;
  isDirectory: boolean;
  /** null for directories. */
  size: number | null;
  /** ISO 8601. */
  modified: string;
  /** POSIX permission bits, masked to 0o777. Absent on platforms without them. */
  mode?: number;
  /** The same bits as octal digits, e.g. "755". */
  modeOctal?: string;
  /** True when any execute bit is set. Always false for directories. */
  executable?: boolean;
}

/** Everything the properties dialog shows. Costs more than a listing entry. */
export interface EntryProperties extends Entry {
  isSymbolicLink: boolean;
  /** Virtual path of the link target, or null when it leaves the root. */
  linkTarget: string | null;
  /** Bytes actually occupied; differs from size for sparse files. */
  blocks: number;
  created: string;
  accessed: string;
  changed: string;
  links: number;
  mode: number;
  modeOctal: string;
  /** e.g. "rwxr-xr-x". */
  modeText: string;
  executable: boolean;
  /** Whether this session may actually change the mode. */
  modeEditable: boolean;
  uid: number;
  gid: number;
  /** Resolved only when it is the account the server runs as. */
  owner: string | null;
  /** Direct children, for directories. */
  itemCount: number | null;
  /** Total bytes below this directory; only when computeSize was requested. */
  totalSize: number | null;
  /** True when the walk hit its entry cap before finishing. */
  totalSizePartial: boolean;
}

/** Either an absolute mode or a relative execute-bit change, never both. */
export type ModeChange =
  | { mode: string; executable?: never; recursive?: boolean }
  | { executable: boolean; mode?: never; recursive?: boolean };

export interface Listing {
  path: string;
  name: string;
  parent: string | null;
  items: Entry[];
  /** Present only when the server capped the listing. */
  truncated?: boolean;
  /** How many entries the directory really holds, when truncated. */
  total?: number;
}

export interface TreeNode {
  name: string;
  path: string;
  isDirectory: true;
  hasChildren: boolean;
  children: TreeNode[] | null;
}

export interface ServerConfig {
  readOnly: boolean;
  permissions: Record<PermissionKey, boolean>;
  maxUploadSize: number;
  maxUploadFiles: number;
  maxRequestSize: number;
  /** Whether the server serves /thumbnail at all. */
  thumbnails: boolean;
  /** Sizes /thumbnail accepts; anything else is refused. */
  thumbnailSizes: number[];
  /** Per-format read/write capability of this deployment. */
  archiveFormats: ArchiveCapabilities;
  /** Which image formats the viewer may open, and how. */
  imageView: ImageViewCapabilities;
  /** Spreadsheet formats the editor can open and save. */
  sheetFormats: SheetCapabilities;
  /** Document formats the editor can open, save and page through. */
  documentFormats: DocumentCapabilities;
  /** What a recursive search may do on this server. */
  search: SearchCapabilities;
  /**
   * Whether the platform has POSIX mode bits at all. Distinct from
   * permissions.chmod, which says whether changing them is allowed.
   */
  chmodSupported: boolean;
  /** null unless the server was started with `exposeUsage`. */
  usage: { total: number; free: number } | null;
}

export interface UploadResult {
  uploaded: Entry[];
  failures: Array<{ name: string; message: string }>;
}

export interface UploadOptions {
  onProgress?: (fraction: number, loaded: number, total: number) => void;
  overwrite?: boolean;
  signal?: AbortSignal;
}

/**
 * Anything the widget can talk to. Implement it to back the manager with S3,
 * an RPC service, or an in-memory tree instead of the bundled REST router.
 */
export interface Provider {
  config(signal?: AbortSignal): Promise<ServerConfig> | ServerConfig;
  list(path: string, signal?: AbortSignal): Promise<Listing> | Listing;
  tree(path: string, depth?: number, signal?: AbortSignal): Promise<TreeNode> | TreeNode;
  stat(path: string, signal?: AbortSignal): Promise<Entry> | Entry;
  createDirectory(path: string, name: string): Promise<Entry> | Entry;
  createFile(path: string, name: string, content?: string): Promise<Entry> | Entry;
  rename(path: string, name: string): Promise<Entry> | Entry;
  move(paths: string[], destination: string, options?: { overwrite?: boolean }): Promise<Entry[]> | Entry[];
  copy(paths: string[], destination: string, options?: { overwrite?: boolean }): Promise<Entry[]> | Entry[];
  remove(paths: string[]): Promise<{ removed: string[] }> | { removed: string[] };
  downloadUrl(paths: string | string[], options?: { inline?: boolean }): string;
  upload(path: string, files: File[] | FileList, options?: UploadOptions): Promise<UploadResult>;
  /** Omit to disable thumbnails for a custom provider. */
  thumbnailUrl?(path: string, size: number): string | null;
  /** Omit to disable the properties dialog for a custom provider. */
  properties?(
    path: string,
    options?: { computeSize?: boolean; signal?: AbortSignal }
  ): Promise<EntryProperties> | EntryProperties;
  /** Omit to disable permission editing for a custom provider. */
  chmod?(paths: string[], change: ModeChange): Promise<EntryProperties[]> | EntryProperties[];
  /** Omit to disable the archive features for a custom provider. */
  listArchive?(path: string, signal?: AbortSignal): Promise<ArchiveContents> | ArchiveContents;
  createArchive?(
    paths: string[],
    options: { format: ArchiveFormatId; destination?: string; name?: string }
  ): Promise<Entry> | Entry;
  extract?(path: string, options?: { destination?: string }): Promise<ExtractResult> | ExtractResult;
  /** Omit to disable server-side conversion for a custom provider. */
  renderUrl?(path: string, width: number): string;
  /** Omit to disable the code editor for a custom provider. */
  readText?(path: string, signal?: AbortSignal): Promise<TextDocument> | TextDocument;
  saveText?(
    path: string,
    text: string,
    options?: { encoding?: string; bom?: boolean; newline?: string }
  ): Promise<TextSaveResult> | TextSaveResult;
  /** Omit to disable the spreadsheet editor for a custom provider. */
  search?(
    path: string,
    options?: SearchOptions,
    signal?: AbortSignal
  ): Promise<SearchResult> | SearchResult;
  readDocument?(path: string, signal?: AbortSignal): Promise<OpenedDocument> | OpenedDocument;
  saveDocument?(
    path: string,
    document: { blocks: DocumentBlock[] },
    options?: { format?: DocumentFormatId }
  ): Promise<DocumentSaveResult> | DocumentSaveResult;
  saveDocumentPages?(
    path: string,
    plan: PdfPagePlanItem[],
    options?: { sources?: string[]; target?: string }
  ): Promise<PdfPagesResult> | PdfPagesResult;
  readSheet?(path: string, signal?: AbortSignal): Promise<OpenedWorkbook> | OpenedWorkbook;
  saveSheet?(
    path: string,
    workbook: Workbook,
    options?: { format?: SheetFormatId }
  ): Promise<SheetSaveResult> | SheetSaveResult;
}

export declare class ProviderError extends Error {
  readonly name: 'ProviderError';
  readonly code: string;
  readonly status: number;
  constructor(message: string, code?: string, status?: number);
}

export interface HttpProviderOptions {
  endpoint: string;
  headers?: HeadersInit | (() => HeadersInit);
  credentials?: RequestCredentials;
}

export declare class HttpProvider implements Provider {
  constructor(options: HttpProviderOptions);
  endpoint: string;
  url(route: string, query?: Record<string, unknown>): string;
  config(signal?: AbortSignal): Promise<ServerConfig>;
  list(path: string, signal?: AbortSignal): Promise<Listing>;
  tree(path: string, depth?: number, signal?: AbortSignal): Promise<TreeNode>;
  stat(path: string, signal?: AbortSignal): Promise<Entry>;
  createDirectory(path: string, name: string): Promise<Entry>;
  createFile(path: string, name: string, content?: string): Promise<Entry>;
  rename(path: string, name: string): Promise<Entry>;
  move(paths: string[], destination: string, options?: { overwrite?: boolean }): Promise<Entry[]>;
  copy(paths: string[], destination: string, options?: { overwrite?: boolean }): Promise<Entry[]>;
  remove(paths: string[]): Promise<{ removed: string[] }>;
  downloadUrl(paths: string | string[], options?: { inline?: boolean }): string;
  upload(path: string, files: File[] | FileList, options?: UploadOptions): Promise<UploadResult>;
  thumbnailUrl(path: string, size: number): string;
  properties(
    path: string,
    options?: { computeSize?: boolean; signal?: AbortSignal }
  ): Promise<EntryProperties>;
  chmod(paths: string[], change: ModeChange): Promise<EntryProperties[]>;
  listArchive(path: string, signal?: AbortSignal): Promise<ArchiveContents>;
  createArchive(
    paths: string[],
    options: { format: ArchiveFormatId; destination?: string; name?: string }
  ): Promise<Entry>;
  extract(path: string, options?: { destination?: string }): Promise<ExtractResult>;
  renderUrl(path: string, width: number): string;
  readText(path: string, signal?: AbortSignal): Promise<TextDocument>;
  saveText(
    path: string,
    text: string,
    options?: { encoding?: string; bom?: boolean; newline?: string }
  ): Promise<TextSaveResult>;
  search(path: string, options?: SearchOptions, signal?: AbortSignal): Promise<SearchResult>;
  readDocument(path: string, signal?: AbortSignal): Promise<OpenedDocument>;
  saveDocument(
    path: string,
    document: { blocks: DocumentBlock[] },
    options?: { format?: DocumentFormatId }
  ): Promise<DocumentSaveResult>;
  saveDocumentPages(
    path: string,
    plan: PdfPagePlanItem[],
    options?: { sources?: string[]; target?: string }
  ): Promise<PdfPagesResult>;
  readSheet(path: string, signal?: AbortSignal): Promise<OpenedWorkbook>;
  saveSheet(
    path: string,
    workbook: Workbook,
    options?: { format?: SheetFormatId }
  ): Promise<SheetSaveResult>;
}

/** The languages that ship with the widget. */
export type LocaleId = 'en' | 'uk' | 'es' | 'de' | 'fr';

/** Which plural form a count takes in a given language. */
export type PluralForm = 'one' | 'few' | 'many' | 'other';

/**
 * One string, or a set of forms chosen by the count in `{n}`.
 *
 * English, Spanish, German and French need `one` and `other`; Ukrainian needs
 * `one`, `few` and `many`.
 */
export type LocaleString = string | Partial<Record<PluralForm, string>>;

/**
 * A language.
 *
 * A host may pass a partial one: anything it leaves out falls back to English,
 * so translating ten strings and leaving the rest still gives a working widget.
 */
export interface LocaleDictionary {
  id?: string;
  /** Shown when a host lists the languages it offers. */
  name?: string;
  /** BCP-47 tag, used for dates and the `lang` attribute. */
  tag?: string;
  plural?: (count: number) => PluralForm;
  strings: Record<string, LocaleString>;
}

/** Ready-made plural rules, keyed by the family of language they suit. */
export declare const PLURAL_RULES: {
  /** English, Spanish, German, French: one, other. */
  default: (count: number) => PluralForm;
  /** Ukrainian and its relatives: one, few, many. */
  slavic: (count: number) => PluralForm;
};

/** Every shipped language, by id. */
export declare const LOCALES: Record<LocaleId, LocaleDictionary>;
export declare const DEFAULT_LOCALE: LocaleDictionary;
export declare const en: LocaleDictionary;
export declare const uk: LocaleDictionary;
export declare const es: LocaleDictionary;
export declare const de: LocaleDictionary;
export declare const fr: LocaleDictionary;

/**
 * Build a lookup over one dictionary, with `fallback` underneath it.
 *
 * The returned function takes a key and the values its placeholders need, and
 * returns the key itself when nothing has a string for it.
 */
export declare function createTranslator(
  dictionary: LocaleDictionary,
  fallback: LocaleDictionary
): (key: string, params?: Record<string, unknown>) => string;

/**
 * Turn whatever a host passed as `locale` into a dictionary.
 *
 * Accepts a shipped id, a regional tag whose base matches one (`'de-AT'`), or
 * a dictionary of the host's own. Anything unrecognised gives `fallback`.
 */
export declare function resolveLocale(
  locale: LocaleId | string | LocaleDictionary | null | undefined,
  available: Record<string, LocaleDictionary>,
  fallback: LocaleDictionary
): LocaleDictionary;

/** A CSS value: a colour, a length, a font stack. */
export type ThemeValue = string;

/** Any custom property, for a variable this list has not caught up with. */
export type ThemeEscapeHatch = { [property: `--${string}`]: ThemeValue };

/** Syntax highlighting in the code editor. */
export interface ThemeTokens extends ThemeEscapeHatch {
  comment?: ThemeValue;
  string?: ThemeValue;
  number?: ThemeValue;
  keyword?: ThemeValue;
  type?: ThemeValue;
  builtin?: ThemeValue;
  tag?: ThemeValue;
  attr?: ThemeValue;
  property?: ThemeValue;
  variable?: ThemeValue;
  operator?: ThemeValue;
  punctuation?: ThemeValue;
  heading?: ThemeValue;
  link?: ThemeValue;
  meta?: ThemeValue;
}

/** One palette. Give it under `colors`, `light` or `dark`. */
export interface ThemeColors extends ThemeEscapeHatch {
  bg?: ThemeValue;
  bgSubtle?: ThemeValue;
  bgSunken?: ThemeValue;
  border?: ThemeValue;
  borderStrong?: ThemeValue;
  text?: ThemeValue;
  textMuted?: ThemeValue;
  textInverse?: ThemeValue;
  accent?: ThemeValue;
  accentHover?: ThemeValue;
  accentSoft?: ThemeValue;
  /** Text drawn on top of the accent colour. */
  accentContrast?: ThemeValue;
  danger?: ThemeValue;
  dangerHover?: ThemeValue;
  success?: ThemeValue;
  warning?: ThemeValue;
  terminalBg?: ThemeValue;
  shadow?: ThemeValue;
  shadowLarge?: ThemeValue;
  tokens?: ThemeTokens;
}

/**
 * Colours, fonts and metrics.
 *
 * Omit it and the widget keeps its built-in palette — what the demo shows.
 *
 * Fonts and metrics have one value each; colours may be given once for both
 * schemes (`colors`) or per scheme (`light`, `dark`). A key that is not
 * recognised throws rather than being ignored, so a typo surfaces at once.
 */
export interface Theme extends ThemeEscapeHatch {
  font?: ThemeValue;
  fontSize?: ThemeValue;
  codeFont?: ThemeValue;
  codeSize?: ThemeValue;
  codeLineHeight?: ThemeValue;
  radius?: ThemeValue;
  radiusLarge?: ThemeValue;
  sidebarWidth?: ThemeValue;
  tileWidth?: ThemeValue;
  rowHeight?: ThemeValue;

  /** Applies to both schemes. */
  colors?: ThemeColors;
  /** Narrows `colors` for the light scheme. */
  light?: ThemeColors;
  /** Narrows `colors` for the dark scheme. */
  dark?: ThemeColors;
  /** Shorthand for `colors.tokens`. */
  tokens?: ThemeTokens;
}

/** Build the scoped stylesheet for one widget. Exported for testing. */
export declare function buildThemeCss(scope: string, theme: Theme | null | undefined): string;

/** camelCase key -> custom property, for each group a theme accepts. */
export declare const METRIC_PROPERTIES: Record<string, string>;
export declare const COLOR_PROPERTIES: Record<string, string>;
export declare const TOKEN_PROPERTIES: Record<string, string>;

export interface FileManagerOptions {
  /** Base URL the router is mounted at. Ignored when `provider` is given. */
  endpoint?: string;
  provider?: Provider | null;
  /** Name of the root in the tree and breadcrumbs. Follows `locale` when omitted. */
  rootLabel?: string | null;
  initialPath?: string;
  view?: 'grid' | 'list';
  /**
   * What language the widget speaks.
   *
   * A shipped id, a regional tag whose base matches one (`'de-AT'` gives
   * German), or your own dictionary. English when omitted, and English again
   * for anything unrecognised.
   */
  locale?: LocaleId | string | LocaleDictionary | null;
  /**
   * Colours, fonts and metrics. Omitted, the built-in palette is used —
   * the one the demo shows.
   */
  theme?: Theme | null;
  /** Serve per-extension artwork from this path instead of the drawn icons. */
  iconBasePath?: string | null;
  /** UI-side switches. The server's own set wins; the effective set is the intersection. */
  permissions?: Permissions | null;
  customizeThumbnail?: ((entry: Entry) => string | null) | null;
  /**
   * Show images and PDFs in a viewer over the widget instead of a new tab.
   * Types the viewer cannot render still open in a tab.
   */
  preview?: boolean;
  /** Draw image tiles from the file itself rather than from a generic icon. */
  thumbnails?: boolean;
  /** Open csv, xlsx, xls and ods in the grid editor instead of downloading. */
  sheets?: boolean;
  /** Open text and source files in the code editor instead of downloading. */
  code?: boolean;
  /**
   * Open docx, odt and doc in the document editor instead of downloading, and
   * offer the page editor for PDFs from the context menu. A PDF still opens in
   * the viewer on double click, which is the more useful default for it.
   */
  documents?: boolean;
  /**
   * Offer recursive search: a button beside the filter box, Enter in that box,
   * and Ctrl+Shift+F. Distinct from the filter itself, which narrows the folder
   * already on screen and is controlled by `showSearch`.
   */
  search?: boolean;
  /**
   * Show the terminal panel at the bottom. On by default; the button in the
   * toolbar and Ctrl+` hide and show it afterwards.
   *
   * It runs file-manager commands — ls, cd, cat, find, grep, mkdir, rm and so
   * on — through the same API the buttons use. It is not a system shell and
   * cannot start a process.
   */
  terminal?: boolean;
  showTree?: boolean;
  showToolbar?: boolean;
  /**
   * Which actions appear on the toolbar. `false` (the default) shows none,
   * `true` shows all of them, an array shows those in the fixed order.
   * They stay reachable from the context menu and the API either way.
   *
   * Buttons are icons with the name in the tooltip, and the ones that depend
   * on what is selected — «Розпакувати», «Відкрити таблицю», «Перегляд» —
   * appear only when they apply.
   */
  toolbarActions?: boolean | ToolbarAction[];
  showStatusBar?: boolean;
  showSearch?: boolean;
  confirmDelete?: boolean;
  headers?: HeadersInit | (() => HeadersInit) | null;
  credentials?: RequestCredentials;
}

export interface FileManagerEvents {
  ready: { path: string; readOnly: boolean };
  navigate: { path: string; listing: Listing };
  open: { entry: Entry };
  created: { entry: Entry };
  renamed: { from: Entry; to: Entry };
  moved: { entries: Entry[]; destination: string };
  copied: { entries: Entry[]; destination: string };
  deleted: { paths: string[] };
  uploaded: { entries: Entry[]; failures: Array<{ name: string; message: string }>; destination: string };
  download: { entries: Entry[]; asArchive: boolean };
  selectionchange: { selection: Entry[] };
  viewchange: { view: 'grid' | 'list' };
  preview: { entry: Entry };
  chmod: { entries: EntryProperties[]; entry?: Entry; mode?: string; executable?: boolean };
  archived: { entries: Entry[]; archive: Entry; format: ArchiveFormatId };
  pathcopied: { paths: string[]; text: string };
  codeopen: { entry: Entry; document: TextDocument };
  codesaved: { entry: Entry; result: TextSaveResult };
  sheetopen: { entry: Entry; workbook: OpenedWorkbook };
  sheetsaved: { entry: Entry; result: SheetSaveResult };
  documentopen: { entry: Entry; document: OpenedDocument };
  documentsaved: { entry: Entry; result: DocumentSaveResult | PdfPagesResult };
  search: { path: string; options: SearchOptions; result: SearchResult };
  reveal: { entry: Entry | SearchMatch };
  terminaltoggle: { visible: boolean };
  pathedit: { path: string; entry: Entry };
  extracted: { entry: Entry; result: ExtractResult };
  error: { error: unknown; message?: string };
}

export declare class FileManager {
  constructor(target: HTMLElement | string, options?: FileManagerOptions);

  /** Resolves once the first directory listing is on screen. */
  readonly ready: Promise<FileManager>;
  readonly currentPath: string;
  readonly readOnly: boolean;
  readonly permissions: Record<PermissionKey, boolean>;
  readonly options: Required<FileManagerOptions>;
  readonly root: HTMLElement;

  on<K extends keyof FileManagerEvents>(
    event: K,
    handler: (payload: FileManagerEvents[K]) => void
  ): () => void;
  off<K extends keyof FileManagerEvents>(
    event: K,
    handler: (payload: FileManagerEvents[K]) => void
  ): void;

  can(action: PermissionKey): boolean;
  navigate(path: string, options?: { silent?: boolean; select?: string[]; keepSelection?: boolean }): Promise<void>;
  navigateUp(): Promise<void>;
  refresh(options?: { keepSelection?: boolean; select?: string[]; treePaths?: string[] }): Promise<void>;
  open(entry: Entry): void;
  /**
   * Open the viewer on one entry, defaulting to the current selection.
   * Returns false when nothing here can be previewed.
   */
  preview(entry?: Entry): boolean;
  /** Read-only properties sheet; offers the permissions editor when allowed. */
  showProperties(entry?: Entry): Promise<EntryProperties | null>;
  /** Permissions editor for one entry. */
  editPermissions(entry?: Entry, details?: EntryProperties): Promise<EntryProperties | null>;
  /** Add or remove the execute bit across the selection. */
  setExecutable(executable: boolean, selection?: Entry[]): Promise<EntryProperties[] | null>;
  /** Pack the selection; opens the format picker. */
  compress(selection?: Entry[]): Promise<Entry | null>;
  /** Unpack one archive beside itself. */
  extract(entry?: Entry): Promise<ExtractResult | null>;
  /** List an archive's contents without writing anything. */
  showArchiveContents(entry?: Entry): Promise<ArchiveContents | null>;
  /** Open a spreadsheet in the grid editor. */
  openSheet(entry?: Entry): Promise<OpenedWorkbook | null>;
  /** Open a text or source file in the code editor. */
  openCode(entry?: Entry): Promise<TextDocument | null>;
  /**
   * Open a document. docx, odt and doc open as rich text; a PDF opens as its
   * pages. Which of the two is decided by the server's answer, so a file with
   * a misleading extension still lands in the right editor.
   */
  openDocument(entry?: Entry): Promise<OpenedDocument | null>;
  /**
   * Open the recursive search dialog. Returns null when `search` is off.
   * @param query prefill
   */
  openSearch(
    query?: string,
    options?: { path?: string }
  ): { close: () => void; run: () => Promise<void> } | null;
  /** Go to the folder holding an entry and select it there. */
  reveal(entry: Entry | SearchMatch): Promise<Entry | SearchMatch>;
  /**
   * Replace the breadcrumbs with a box the path can be typed into, the way a
   * double click on the empty part of the crumb bar does.
   *
   * Relative paths, `..` and `~` are resolved against the current folder.
   * `Enter` goes there, `Escape` or a click elsewhere puts the crumbs back.
   * Returns null when there is no crumb bar to replace.
   */
  editPath(): HTMLInputElement | null;
  /** The terminal panel, or null when `terminal` is off. */
  readonly terminal: Terminal | null;
  readonly terminalVisible: boolean;
  /** Show or hide the panel; omitting the argument flips it. */
  toggleTerminal(visible?: boolean): boolean;
  /** Print a dimmed line in the terminal, if there is one. */
  termNote(text: string): void;
  /**
   * Put virtual paths on the clipboard, one per line. Defaults to the current
   * selection; pass a string to copy a folder path instead.
   */
  copyPath(target?: string | string[] | Entry | Entry[]): Promise<string | null>;
  setView(view: 'grid' | 'list'): void;
  getSelection(): Entry[];

  createFolder(): Promise<Entry | null>;
  createFile(): Promise<Entry | null>;
  moveSelection(): Promise<Entry[] | null>;
  copySelection(): Promise<Entry[] | null>;
  renameSelection(): Promise<Entry | null>;
  deleteSelection(): Promise<{ removed: string[] } | null>;
  downloadSelection(): void;
  upload(): void;

  /** Removes the widget, its listeners and any dialog still open. */
  destroy(): void;
}

export declare function createFileManager(
  target: HTMLElement | string,
  options?: FileManagerOptions
): Promise<FileManager>;

/**
 * Put text on the clipboard, falling back to execCommand where the async
 * Clipboard API is unavailable (any non-secure context, such as plain http).
 */
export declare function copyToClipboard(text: string): Promise<boolean>;

/** Cancels every dialog and overlay in a container. Called by FileManager.destroy(). */
export declare function closeDialogs(container: HTMLElement): void;

/** Register a non-dialog overlay so closeDialogs() reaches it too. */
export declare function registerOverlay(container: HTMLElement, close: () => void): () => void;

/** True when the viewer can show this entry. */
export declare function canPreview(entry: Entry): boolean;

/** How the viewer would render this entry, or null when it cannot. */
export declare function previewKind(entry: Entry): 'image' | 'frame' | null;

/** True when showing this entry needs the server to convert it first. */
export declare function needsRender(entry: Entry): boolean;

export declare function buildExtensionIndex(
  formats: Partial<ArchiveCapabilities>
): Array<[string, string]>;

export declare function archiveFormatOf(
  name: string,
  index: Array<[string, string]>
): string | null;

export declare function archiveDialog(config: {
  container: HTMLElement;
  formats: Partial<ArchiveCapabilities>;
  selection: Entry[];
  suggestedBase: string;
}): Promise<{ format: ArchiveFormatId; name: string } | null>;

export declare function archiveContentsDialog(config: {
  container: HTMLElement;
  entry: Entry;
  contents: ArchiveContents;
}): Promise<unknown>;

/** The language a filename opens as, or null when it is not text this knows. */
export declare function languageOf(name: string): LanguageId | null;
export declare function languageLabel(id: LanguageId): string;
export declare const LANGUAGE_IDS: readonly LanguageId[];
export declare const TEXT_EXTENSIONS: readonly string[];

/**
 * Tokenise and escape. Returns HTML in which the source is always escaped —
 * `<script>` in a file can never become markup in the page.
 */
export declare function highlight(text: string, language: LanguageId): string;

export declare function openCodeEditor(config: {
  container: HTMLElement;
  entry: Entry;
  document: TextDocument;
  canSave?: boolean;
  onSave: (text: string) => Promise<TextSaveResult>;
}): { close: () => void; readonly dirty: boolean; readonly value: string };

/** "A", "Z", "AA" — the column header for a zero-based index. */
export declare function columnName(index: number): string;

export declare function openSheetEditor(config: {
  container: HTMLElement;
  entry: Entry;
  workbook: Workbook;
  formats: Partial<SheetCapabilities>;
  canSave?: boolean;
  onSave: (workbook: Workbook) => Promise<SheetSaveResult>;
}): { close: () => void; readonly dirty: boolean };

export declare function openSearchDialog(config: {
  container: HTMLElement;
  /** Where the search starts; shown in the header. */
  path?: string;
  capabilities?: Partial<SearchCapabilities>;
  /** Prefill; a non-empty value runs the search on open. */
  query?: string;
  icons?: { iconBasePath?: string | null; customize?: ((entry: Entry) => string | null) | null };
  onSearch: (options: SearchOptions, signal: AbortSignal) => Promise<SearchResult>;
  onReveal?: (entry: SearchMatch) => void;
  onOpen?: (entry: SearchMatch) => void;
}): { close: () => void; run: () => Promise<void>; readonly element: HTMLElement };

export declare function openDocumentEditor(config: {
  container: HTMLElement;
  entry: Entry;
  document: OpenedDocument;
  formats?: Partial<DocumentCapabilities>;
  canSave?: boolean;
  onSave?: (document: { blocks: DocumentBlock[] }) => Promise<DocumentSaveResult>;
  onPages?: (
    plan: PdfPagePlanItem[],
    options: { sources: string[]; target?: string }
  ) => Promise<PdfPagesResult>;
  /** Reads another document, for a merge. */
  onRead?: (path: string) => Promise<OpenedDocument>;
  /** Asks the user for a path; resolves null when they cancel. */
  onAskPath?: (message: string, value?: string) => Promise<string | null>;
}): { close: () => void; readonly dirty: boolean };

export declare function propertiesDialog(config: {
  container: HTMLElement;
  provider: Pick<Provider, 'properties'>;
  entry: Entry;
  onEditMode?: (details: EntryProperties) => void;
}): Promise<unknown>;

export declare function permissionsDialog(config: {
  container: HTMLElement;
  details: EntryProperties;
}): Promise<{ mode: string; recursive: boolean } | null>;

export declare const MODE_CLASSES: ReadonlyArray<{
  key: string;
  /** Translation key — resolve it with a translator, it is not display text. */
  labelKey: string;
  shift: number;
}>;
export declare const MODE_BITS: ReadonlyArray<{
  key: string;
  /** Translation key — resolve it with a translator, it is not display text. */
  labelKey: string;
  value: number;
  letter: string;
}>;
export declare function formatOctalMode(mode: number): string;
export declare function formatModeText(mode: number): string;
export declare function parseOctalMode(value: string): number | null;
export declare function isExecutable(mode: number): boolean;
export declare function withExecutable(mode: number, executable: boolean): number;

export declare function openPreview(config: {
  container: HTMLElement;
  provider: Pick<Provider, 'downloadUrl'>;
  entries: Entry[];
  entry: Entry;
  onDownload?: (entry: Entry) => void;
  canDownload?: boolean;
  /** From /config; lets the viewer explain a format it cannot get pixels for. */
  view?: ImageViewCapabilities | null;
}): { close: () => void; next?: () => void; previous?: () => void };

export default FileManager;
