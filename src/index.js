/**
 * bookmark-file-manager — embeddable file manager widget.
 *
 *   import { FileManager } from 'bookmark-file-manager';
 *   import 'bookmark-file-manager/style.css';
 *
 *   const manager = new FileManager('#host', { endpoint: '/api/files' });
 *
 * The stylesheet is imported here so bundler users get it automatically; the
 * `sideEffects` field in package.json keeps it from being tree-shaken away.
 */
import './styles.css';
import { FileManager } from './file-manager.js';

export { FileManager, TOOLBAR_ACTIONS, TOOLBAR_PRIMARY_ACTIONS, FileManager as default } from './file-manager.js';

// Language. `locale` takes one of the shipped ids, or a dictionary of your
// own — see `createTranslator` for its shape. English is the default and the
// fallback for anything a translation leaves out.
export { DEFAULT_LOCALE, LOCALES, de, en, es, fr, uk } from './locales/index.js';
export { PLURAL_RULES, createTranslator, resolveLocale } from './core/i18n.js';

// Colours, fonts and metrics. `theme` on the widget takes the same shape.
export {
  COLOR_PROPERTIES,
  METRIC_PROPERTIES,
  TOKEN_PROPERTIES,
  buildThemeCss,
} from './core/theme.js';
export { HttpProvider, ProviderError } from './core/http-provider.js';
export { FileList, INTERNAL_DRAG_TYPE } from './ui/file-list.js';
export { FolderTree } from './ui/tree.js';
export { ToastHost } from './ui/toast.js';
export { canPreview, needsRender, openPreview, previewKind } from './ui/preview.js';
export { permissionsDialog, propertiesDialog } from './ui/properties.js';
export { columnName, openSheetEditor } from './ui/sheet-editor.js';
export { openCodeEditor } from './ui/code-editor.js';
export { openDocumentEditor } from './ui/doc-editor.js';
export { openSearchDialog } from './ui/search.js';
export { Terminal } from './ui/terminal.js';
export { COMMANDS, COMMAND_NAMES, columnize, resolvePath, runCommand, tokenize } from './core/terminal-commands.js';
export { LANGUAGE_IDS, TEXT_EXTENSIONS, highlight, languageLabel, languageOf } from './ui/highlight.js';
export {
  archiveContentsDialog,
  archiveDialog,
  archiveFormatOf,
  buildExtensionIndex,
} from './ui/archive.js';
export {
  MODE_BITS,
  MODE_CLASSES,
  formatModeText,
  formatOctalMode,
  isExecutable,
  parseOctalMode,
  withExecutable,
} from './core/mode.js';
export { ContextMenu } from './ui/context-menu.js';
export { closeDialogs, registerOverlay, confirmDialog, folderPickerDialog, openDialog, progressDialog, promptDialog } from './ui/dialog.js';
export { categoryOf, fileIconSvg, folderIconSvg, resolveFileIcon } from './ui/file-icon.js';
export { icon, iconNames } from './ui/icons.js';
export { copyToClipboard } from './ui/dom.js';
export { baseName, extensionOf, formatBytes, formatDate, parentPath, pathSegments, pluralize } from './core/format.js';

/**
 * Convenience factory — mounts a manager and resolves once the first
 * directory listing is on screen.
 *
 * @param {HTMLElement|string} target
 * @param {object} [options] see FileManager
 * @returns {Promise<import('./file-manager.js').FileManager>}
 */
export async function createFileManager(target, options) {
  const manager = new FileManager(target, options);
  await manager.ready;
  return manager;
}
