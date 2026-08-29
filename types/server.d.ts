/**
 * Type definitions for `bookmark-file-manager/server`.
 *
 * The handler is described in terms of node's own request and response, not a
 * framework's: it mounts in Express, AdonisJS, Fastify, Nest or bare
 * `node:http`, and none of those types are needed to describe it.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Readable } from 'node:stream';

import type {
  ArchiveCapabilities,
  ArchiveContents,
  ArchiveFormatId,
  DocumentBlock,
  DocumentCapabilities,
  DocumentFormatId,
  DocumentSaveResult,
  Entry,
  EntryProperties,
  ExtractResult,
  ImageViewCapabilities,
  Listing,
  ModeChange,
  OpenedWorkbook,
  PdfDocumentInfo,
  SearchCapabilities,
  SearchOptions,
  SearchResult,
  PdfPagePlanItem,
  PdfPagesResult,
  PermissionKey,
  RichDocument,
  SheetCapabilities,
  SheetFormatId,
  SheetSaveResult,
  TextDocument,
  TextSaveResult,
  Workbook,
  Permissions,
  TreeNode,
} from './index.js';

export declare class FsError extends Error {
  constructor(status: number, code: string, message: string);
  readonly status: number;
  readonly code: string;
}

/** What an operation is about, handed to the `authorize` hook. */
export interface AuthorizeContext {
  /** The route within the router, e.g. "/delete". */
  route: string;
  /** Virtual paths the operation reads or writes. */
  paths: string[];
  /** Target directory for move/copy/create/upload, else null. */
  destination: string | null;
  /** New name for create/rename, else null. */
  name: string | null;
  /**
   * True on the first of the two calls made for `/upload`, when the body has
   * not been parsed and the destination is not yet known.
   */
  pending?: boolean;
}

export interface ArchiveLimits {
  /** Entries an archive may contain. Default 100000. */
  maxEntries?: number;
  /** Bytes an archive may expand to in total. Default 5 GiB. */
  maxTotalBytes?: number;
  /** Bytes any single entry may expand to. Default 2 GiB. */
  maxEntrySize?: number;
  /** Milliseconds an external tool may run. Default 10 minutes. */
  toolTimeout?: number;
}

/**
 * Packing and unpacking, and an honest account of what this machine can do.
 * Every format funnels through the project's own tar layer, so entry names are
 * validated in one place for all of them.
 */
export declare class ArchiveService {
  constructor(options?: { limits?: ArchiveLimits; onWarning?: (message: string, detail?: unknown) => void });
  init(options?: { tools?: boolean }): Promise<this>;
  capabilities(): ArchiveCapabilities;
  detect(absolute: string, name: string): Promise<{ id: ArchiveFormatId } | null>;
  list(absolute: string, name: string): Promise<ArchiveContents>;
  pack(options: {
    entries: AsyncIterable<object> | Iterable<object>;
    destination: string;
    format: object;
    singleFile?: { absolute: string; name: string };
  }): Promise<void>;
  unpack(options: { absolute: string; name: string; destination: string }): Promise<{
    format: ArchiveFormatId;
    written: number;
    bytes: number;
    skipped: Array<{ name: string; reason: string }>;
  }>;
  readonly tools: { enabled: boolean; found: Record<string, string | null> };
}

export interface SheetLimits {
  maxSheets?: number;
  maxRows?: number;
  maxColumns?: number;
  maxCells?: number;
  maxCellLength?: number;
}

/**
 * Reading and writing csv, xlsx, xls and ods, none of which needs an external
 * tool: csv is text, xlsx and ods are ZIPs of XML, and xls is BIFF8 inside an
 * OLE2 container. All four are available always.
 */
export declare class SheetService {
  constructor(options?: { limits?: SheetLimits });
  capabilities(): SheetCapabilities;
  detect(absolute: string, name: string): Promise<{ id: SheetFormatId } | null>;
  read(absolute: string, name: string): Promise<Workbook>;
  write(
    absolute: string,
    name: string,
    workbook: Workbook,
    options?: { format?: SheetFormatId }
  ): Promise<{ format: SheetFormatId; warnings: string[] }>;
  readonly limits: Required<SheetLimits>;
}

export interface SearchLimits {
  /** Matches returned. Default 500. */
  maxResults?: number;
  /** Entries looked at, match or not. Default 200000. */
  maxEntries?: number;
  /** Directory levels below the starting point. Default 32. */
  maxDepth?: number;
  /** Milliseconds the walk gives itself. Default 10000. */
  timeout?: number;
  /** Files larger than this are not read for content. Default 2 MiB. */
  maxContentBytes?: number;
  /** Matching lines reported per file. Default 5. */
  maxMatchesPerFile?: number;
  /** Characters of a line kept in the excerpt. Default 240. */
  excerptLength?: number;
  /** Searches allowed at once; each holds a thread. Default 4. */
  maxConcurrent?: number;
}

/** Turn a shell-style mask into an anchored expression. */
export declare function globToRegExp(
  pattern: string,
  options?: { caseSensitive?: boolean }
): RegExp;

/** Where a query matches a string, or null. */
export declare function compileMatcher(options: {
  query: string;
  mode?: 'substring' | 'glob' | 'regex';
  caseSensitive?: boolean;
}): { find(text: string): { index: number; length: number } | null };

/** Validate and fill in a request. Throws with `status` and `code` on bad input. */
export declare function normaliseSearchOptions(
  raw?: SearchOptions,
  limits?: SearchLimits
): Required<Omit<SearchOptions, 'extensions' | 'limit'>> & {
  extensions: string[];
  maxResults: number;
};

/**
 * Walk a tree and report what matches.
 *
 * Exported for hosts that want a search without the worker around it; note
 * that running a client-supplied regular expression on the main thread is what
 * the worker exists to avoid.
 */
export declare function runSearch(config: {
  root: string;
  baseAbsolute: string;
  baseVirtual: string;
  options: ReturnType<typeof normaliseSearchOptions>;
  limits?: SearchLimits;
  tempPrefix?: string;
  onBatch?: (batch: SearchResult['matches']) => void;
}): Promise<Omit<SearchResult, 'path' | 'query'>>;

export interface DocumentLimits {
  maxBlocks?: number;
  maxBlockLength?: number;
  maxCharacters?: number;
  maxBytes?: number;
}

/**
 * Reading and writing docx, odt and doc, and reading PDF.
 *
 * None of the four needs an external tool: docx and odt are ZIPs of XML, doc
 * is a binary OLE2 container, and PDF is parsed directly. PDF text is read but
 * not written — a page holds positioned glyphs, not paragraphs — while its
 * pages can be deleted, reordered, rotated, split and merged.
 */
export declare class DocumentService {
  constructor(options?: { limits?: DocumentLimits });
  capabilities(): DocumentCapabilities;
  detect(absolute: string, name: string): Promise<{ id: DocumentFormatId } | null>;
  read(absolute: string, name: string): Promise<RichDocument | PdfDocumentInfo>;
  write(
    destination: string,
    name: string,
    document: { blocks: DocumentBlock[] },
    options?: { format?: DocumentFormatId; source?: string; meta?: object }
  ): Promise<{ format: DocumentFormatId; warnings: string[] }>;
  /** Assemble a PDF from pages of one or more source files. */
  pages(
    sources: string[],
    plan: PdfPagePlanItem[],
    destination: string
  ): Promise<{ pages: number }>;
  pageCount(absolute: string): Promise<number>;
  create(
    destination: string,
    name: string,
    options?: { format?: DocumentFormatId }
  ): Promise<{ format: DocumentFormatId }>;
  readonly limits: Required<DocumentLimits>;
}

export interface TextLimits {
  /** Bytes; past this the editor is not usable anyway. Default 8 MiB. */
  maxBytes?: number;
  /** Bytes sampled when deciding whether a file is text. Default 8192. */
  sniffBytes?: number;
}

/** True when the bytes contain a NUL, which no text encoding here produces. */
export declare function looksBinary(buffer: Buffer, sniffBytes?: number): boolean;
export declare function detectNewline(text: string): { newline: string; mixed: boolean };
export declare function readTextFile(
  absolute: string,
  options?: { limits?: TextLimits }
): Promise<Omit<TextDocument, 'path' | 'name'>>;
export declare function serializeText(
  text: string,
  options?: { encoding?: string; bom?: boolean; newline?: string }
): { buffer: Buffer; rewritten: string | null };

export interface FsOpsOptions {
  root: string;
  readOnly?: boolean;
  permissions?: Permissions;
  /** Bytes per uploaded file. Default 100 MiB. */
  maxUploadSize?: number;
  /** Refuse uploads below this much free disk. Default 64 MiB; 0 disables. */
  minFreeSpace?: number;
  /** Cap on entries returned by list(). Default 50000; 0 disables. */
  maxListEntries?: number;
  /** Cap on child directories per tree node. Default 2000. */
  maxTreeChildren?: number;
  /** Parallel stat/readdir calls per request. Default 32. */
  concurrency?: number;
  /**
   * Allow external compressors (bzip2, xz, zstd, bsdtar) for the formats Node
   * cannot handle alone. With this off only zip, tar, tar.gz and gz remain.
   * Default true.
   */
  archiveTools?: boolean;
  archiveLimits?: ArchiveLimits;
  sheetLimits?: SheetLimits;
  documentLimits?: DocumentLimits;
  searchLimits?: SearchLimits;
  textLimits?: TextLimits;
  onWarning?: (message: string, detail?: unknown) => void;
}

export declare class FsOps {
  constructor(options: FsOpsOptions);
  readonly root: string | null;
  readonly readOnly: boolean;
  readonly permissions: Record<PermissionKey, boolean>;
  readonly maxUploadSize: number;

  init(): Promise<this>;
  can(action: PermissionKey): boolean;
  list(virtual: string): Promise<Listing>;
  tree(virtual: string, depth?: number): Promise<TreeNode>;
  stat(virtual: string): Promise<Entry>;
  createDirectory(parentPath: string, name: string): Promise<Entry>;
  createFile(parentPath: string, name: string, content?: string): Promise<Entry>;
  rename(virtual: string, newName: string): Promise<Entry>;
  move(paths: string[], destinationDir: string, opts?: CopyMoveOptions): Promise<Entry[]>;
  copy(paths: string[], destinationDir: string, opts?: CopyMoveOptions): Promise<Entry[]>;
  remove(paths: string[]): Promise<string[]>;
  properties(
    virtual: string,
    options?: { computeSize?: boolean; sizeLimit?: number }
  ): Promise<EntryProperties>;
  chmod(
    paths: string[],
    options: { mode?: number; executable?: boolean; recursive?: boolean }
  ): Promise<EntryProperties[]>;
  /** False on platforms without POSIX mode bits; forces permissions.chmod off. */
  readonly chmodSupported: boolean;
  archiveCapabilities(): ArchiveCapabilities;
  imageCapabilities(): ImageViewCapabilities;
  sheetCapabilities(): SheetCapabilities;
  readSheet(virtual: string): Promise<OpenedWorkbook>;
  writeSheet(
    virtual: string,
    workbook: Workbook,
    options?: { format?: SheetFormatId }
  ): Promise<SheetSaveResult>;
  readonly sheets: SheetService;
  searchCapabilities(): SearchCapabilities;
  /**
   * Search the tree below a path.
   *
   * Runs in a worker thread that can be terminated, because the query may be a
   * regular expression and a backtracking engine cannot be interrupted any
   * other way. Content search requires the `download` permission.
   */
  search(virtual: string | undefined, options: SearchOptions): Promise<SearchResult>;
  readonly searchLimits: Required<SearchLimits>;
  documentCapabilities(): DocumentCapabilities;
  readDocument(virtual: string): Promise<RichDocument | PdfDocumentInfo>;
  writeDocument(
    virtual: string,
    document: { blocks: DocumentBlock[] },
    options?: { format?: DocumentFormatId }
  ): Promise<DocumentSaveResult>;
  /** Delete, reorder, rotate, split or merge the pages of a PDF. */
  writeDocumentPages(
    virtual: string,
    plan: PdfPagePlanItem[],
    options?: { sources?: string[]; target?: string }
  ): Promise<PdfPagesResult>;
  readonly documents: DocumentService;
  readText(virtual: string): Promise<TextDocument>;
  writeText(
    virtual: string,
    text: string,
    options?: { encoding?: string; bom?: boolean; newline?: string }
  ): Promise<TextSaveResult>;
  createArchive(
    paths: string[],
    options: { format: ArchiveFormatId; destination?: string; name?: string }
  ): Promise<Entry>;
  listArchive(virtual: string): Promise<ArchiveContents>;
  extractArchive(virtual: string, options?: { destination?: string }): Promise<ExtractResult>;
  readonly archives: ArchiveService;
  writeUpload(parentPath: string, name: string, stream: Readable, opts?: { overwrite?: boolean }): Promise<Entry>;
  resolveForDownload(virtual: string): Promise<ResolvedDownload>;
  walkFiles(absoluteDir: string, relativePrefix?: string): AsyncGenerator<ZipEntry>;
  usage(): Promise<{ total: number; free: number } | null>;
}

export interface CopyMoveOptions {
  overwrite?: boolean;
  /** Called for anything the copy refused to carry over. */
  onSkip?: (info: { reason: SkipReason; name: string }) => void;
}

export type SkipReason =
  | 'OUTSIDE_ROOT'
  | 'BROKEN_LINK'
  | 'LINK_CYCLE'
  | 'DESTINATION'
  | 'NOT_REGULAR';

export interface ResolvedDownload {
  absolute: string;
  virtual: string;
  name: string;
  isDirectory: boolean;
  size: number;
  modified: Date;
  etag: string;
}

export interface ZipEntry {
  absolute: string;
  relative: string;
  size?: number;
  modified?: Date;
}

export interface ThumbnailOptions {
  /** Serve /thumbnail at all. Default true. */
  thumbnails?: boolean;
  /** Sizes the route accepts. Default [64, 128, 256]. */
  thumbnailSizes?: number[];
  /** Largest file streamed as its own thumbnail (.ico, or no sharp). Default 512 KiB. */
  maxRawThumbnailSize?: number;
  /** Decoded-pixel ceiling, against decompression bombs. Default 50 Mpx. */
  thumbnailPixelLimit?: number;
  /** Renders in flight at once; the rest queue. Default 4. */
  maxConcurrentThumbnails?: number;
  /** How many may wait for a slot before a request is turned away. Default 64. */
  maxQueuedThumbnails?: number;
}

export interface RouterOptions extends FsOpsOptions, ThumbnailOptions {
  /**
   * Prefix to strip from the URL when the host mounts at one without
   * rewriting `req.url` — AdonisJS, Fastify and bare `node:http` do not.
   * Express rewrites it, so leave this out there.
   */
  basePath?: string;
  /** Files per upload request. Default 50. */
  maxUploadFiles?: number;
  /** Bytes per upload request, all files together. Default 1 GiB. */
  maxRequestSize?: number;
  /** Upload requests in flight at once. Default 8; further ones get 503. */
  maxConcurrentUploads?: number;
  /** Body limit for /sheet/save; a workbook exceeds the default 1 MB. Default '16mb'. */
  maxSheetBody?: string | number;
  /** Entries per move/copy/delete/download/chmod. Default 1000. */
  maxBatchPaths?: number;
  /** Entries the directory-size walk visits before reporting a partial total. Default 200000. */
  maxSizeWalkEntries?: number;
  /** Include filesystem total/free in /config. Default false. */
  exposeUsage?: boolean;
  /**
   * Origins allowed to make mutating requests. Defaults to same-origin only.
   * `false` disables the check — only when the host has its own CSRF defence.
   */
  allowedOrigins?: string[] | ((origin: string, req: FileManagerRequest) => boolean) | false;
  /**
   * Called before every operation; return false to reject with 403.
   * For `/upload` it runs twice: once before the body is parsed
   * (`context.pending`), then again with the resolved destination.
   */
  authorize?: (
    req: FileManagerRequest,
    action: string,
    context: AuthorizeContext
  ) => boolean | Promise<boolean>;
  onWarning?: (message: string, detail?: unknown) => void;
}

/**
 * The request as the routes see it: node's own, plus the few conveniences the
 * handler adds when the surrounding framework has not already.
 */
export interface FileManagerRequest extends IncomingMessage {
  /** Path within the mount, with `basePath` already removed. */
  path: string;
  /** Repeated keys arrive as an array, a single key as a string. */
  query: Record<string, string | string[]>;
  /** Parsed JSON body, or `{}` for a request that carried none. */
  body: any;
}

/**
 * A mounted file manager.
 *
 * The `(req, res, next)` shape is what Express accepts as middleware and what
 * any Node framework can hand its raw objects to. It resolves to `false` when
 * the path is not one of its own, so a host can fall through to its own
 * routes.
 */
export interface FileManagerHandler {
  (req: IncomingMessage, res: ServerResponse, next?: (err?: unknown) => void): Promise<boolean>;
  /** The FsOps instance backing this handler. */
  fsOps: FsOps;
  /** Every route it answers, for a host that wants to register them itself. */
  paths(): Array<{ method: string; path: string }>;
}

/** @deprecated Kept for the name Express users know; identical to FileManagerHandler. */
export type FileManagerRouter = FileManagerHandler;

export declare function createFileManagerHandler(options: RouterOptions): FileManagerHandler;

/** The same function under the name Express users already call. */
export declare function createFileManagerRouter(options: RouterOptions): FileManagerHandler;

/** Parse a size option such as `'16mb'` into bytes. */
export declare function parseSize(value: string | number, fallback?: number): number;

/** Repeated keys become an array, a single key stays a string. */
export declare function parseQuery(params: URLSearchParams): Record<string, string | string[]>;

export declare function createZipStream(
  files: Iterable<ZipEntry> | AsyncIterable<ZipEntry>,
  options?: { level?: number; onError?: (err: Error, file: ZipEntry) => void }
): Readable;

export declare function zipFileName(base: string): string;

/** Extensions sharp decodes and re-encodes to WebP. */
export declare const RASTER_THUMBNAIL: ReadonlySet<string>;
/** Extensions streamed as-is: sharp cannot read them, or they are vector. */
export declare const RAW_THUMBNAIL: ReadonlySet<string>;
/** Every extension a thumbnail exists for. Excludes pdf by design. */
export declare const THUMBNAILABLE: ReadonlySet<string>;
export declare const DEFAULT_PIXEL_LIMIT: number;

/** True when the file's name matches a known archive format. */
export declare function isArchiveName(name: string): boolean;
/** True when the name matches a spreadsheet format. */
export declare function isSheetName(name: string): boolean;
export declare function sheetFormatOf(name: string): { id: SheetFormatId } | null;
/** Refuses rather than repairs: absolute paths, "..", NUL bytes, drive letters. */
export declare function safeEntryPath(
  raw: string
): { ok: true; segments: string[]; path: string } | { ok: false; reason: string };

/** Formats a browser draws itself; served untouched. */
export declare const BROWSER_NATIVE: ReadonlySet<string>;
/** Formats no browser draws; converted by /render. */
export declare const NEEDS_RENDER: ReadonlySet<string>;
/** Everything the viewer can show, one way or the other. */
export declare const VIEWABLE: ReadonlySet<string>;
export declare const RENDER_WIDTHS: readonly number[];

/**
 * Whether HEIC pixels can actually be produced here, and by what. Decodes a
 * sample rather than reading headers: libheif parses a HEIC container happily
 * with no HEVC decoder behind it.
 */
export declare function probeHeifSupport(): Promise<'sharp' | 'tool' | false>;
export declare function heifSupported(): 'sharp' | 'tool' | false | null;
export declare function viewCapabilities(): ImageViewCapabilities;
export declare function renderForView(
  absolute: string,
  extension: string,
  options: { width: number; pixelLimit?: number; quality?: number; toolTimeout?: number }
): Promise<{ buffer: Buffer; contentType: string; width: number | null; height: number | null } | null>;

export declare function canThumbnail(extension: string): boolean;
/** The sharp module, or null when it is not installed. */
export declare function loadSharp(): unknown | null;
export declare function rawThumbnailType(extension: string): string | null;
export declare function renderThumbnail(
  absolute: string,
  extension: string,
  options: { size: number; pixelLimit?: number; quality?: number }
): Promise<{ buffer: Buffer; contentType: string; generator: string } | null>;

export declare const PERMISSION_KEYS: readonly PermissionKey[];

/** Owner/group/other rwx. Anything above it is refused. */
export declare const PERMISSION_MASK: number;
/** setuid, setgid and sticky — always refused. */
export declare const SPECIAL_MASK: number;
/** Throws FsError for a number, malformed digits, or any special bit. */
export declare function parseOctalMode(value: string): number;
export declare function formatOctalMode(mode: number): string;
export declare function formatModeText(mode: number): string;
export declare function isExecutable(mode: number): boolean;
/** What `chmod +x` / `-x` produces; execute follows read, never widening access. */
export declare function withExecutable(mode: number, executable: boolean): number;
export declare const TEMP_UPLOAD_PREFIX: string;

export declare function assertValidName(name: string): string;
export declare function normalizeVirtual(virtual: string | null | undefined): string;
export declare function joinVirtual(dir: string, name: string): string;
export declare function parentVirtual(virtual: string): string;
export declare function baseName(virtual: string): string;
export declare function isSameOrInside(parent: string, child: string): boolean;
export declare function isInsideRoot(root: string, absolute: string): boolean;
export declare function resolveSafe(
  root: string,
  virtual: string,
  opts?: { allowMissing?: boolean }
): Promise<{ absolute: string; virtual: string; exists: boolean }>;

export default createFileManagerRouter;
