import { extensionOf } from '../core/format.js';

/**
 * File icons are drawn, not loaded.
 *
 * The widget must work when dropped into any host without copying an asset
 * folder around, and a per-extension artwork set covers only the extensions
 * someone thought of. A drawn sheet plus the extension text covers every
 * extension there will ever be, in one bundle, with no network requests.
 *
 * Hosts that prefer the bundled artwork can pass `iconBasePath`; see
 * resolveFileIcon() below.
 */

const CATEGORIES = {
  image: { color: '#0f9d58', ext: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'tif', 'tiff', 'heic', 'svg'] },
  video: { color: '#d93025', ext: ['mp4', 'webm', 'mov', 'avi', 'mkv', 'm4v', 'mpg', 'mpeg', 'wmv', 'flv'] },
  audio: { color: '#8430ce', ext: ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'opus', 'aac', 'wma', 'aiff'] },
  archive: { color: '#b06000', ext: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'jar', 'iso'] },
  code: { color: '#1a73e8', ext: ['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'java', 'c', 'h', 'cpp', 'cc', 'cs', 'php', 'rb', 'go', 'rs', 'swift', 'kt', 'sh', 'bash', 'zsh', 'pl', 'vb', 'sql', 'lua', 'r', 'dart', 'scala'] },
  markup: { color: '#00838f', ext: ['html', 'htm', 'xml', 'css', 'scss', 'sass', 'less', 'json', 'yaml', 'yml', 'toml', 'ini', 'md', 'markdown', 'rst', 'wml', 'wap'] },
  document: { color: '#2b579a', ext: ['doc', 'docx', 'odt', 'rtf', 'pages', 'tex'] },
  pdf: { color: '#d93025', ext: ['pdf'] },
  text: { color: '#5f6368', ext: ['txt', 'log', 'nfo', 'cfg', 'conf', 'env'] },
  sheet: { color: '#188038', ext: ['xls', 'xlsx', 'ods', 'csv', 'tsv', 'numbers'] },
  slides: { color: '#c5411a', ext: ['ppt', 'pptx', 'odp', 'key'] },
  font: { color: '#5f6368', ext: ['ttf', 'otf', 'woff', 'woff2', 'eot'] },
  binary: { color: '#3c4043', ext: ['exe', 'msi', 'dmg', 'apk', 'deb', 'rpm', 'bin', 'app', 'so', 'dll'] },
};

/** extension -> {category, color}, built once. */
const BY_EXTENSION = new Map();
for (const [category, spec] of Object.entries(CATEGORIES)) {
  for (const ext of spec.ext) {
    BY_EXTENSION.set(ext, { category, color: spec.color });
  }
}

const UNKNOWN = { category: 'unknown', color: '#9aa0a6' };

/**
 * Extensions the server will serve a thumbnail for.
 *
 * Kept in step with THUMBNAILABLE in server/thumbnail.js. Being wrong here is
 * cheap in one direction and not the other: an extension listed by mistake
 * costs one 415 and falls back to the drawn icon, while one left out shows a
 * generic icon for a file that had a perfectly good preview.
 *
 * PDF is deliberately absent — rasterising its first page needs a PDF engine
 * the server does not carry. A PDF keeps its drawn icon here and is previewed
 * full-size in the viewer.
 */
export const THUMBNAILABLE = new Set([
  'jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'tif', 'tiff', 'heic', 'heif',
  'ico', 'svg', 'bmp',
]);

export function categoryOf(name) {
  return BY_EXTENSION.get(extensionOf(name)) ?? UNKNOWN;
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Folder icon. `open` gives the tilted-flap variant used for the current dir. */
export function folderIconSvg({ open = false, size = 48 } = {}) {
  const body = open
    ? '<path d="M2 9a2 2 0 0 1 2-2h7.2l1.6 2H24a2 2 0 0 1 2 2v1H8.6a2 2 0 0 0-1.9 1.4L4 22.7V9Z" fill="#f9c250"/>' +
      '<path d="M8.6 13.5h19.9a1 1 0 0 1 .95 1.3l-2.6 8.2a2 2 0 0 1-1.9 1.4H4.1a1 1 0 0 1-.95-1.3l2.6-8.2a2 2 0 0 1 1.9-1.4Z" fill="#fbd579"/>'
    : '<path d="M2 9a2 2 0 0 1 2-2h7.2l1.6 2H26a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9Z" fill="#f9c250"/>' +
      '<path d="M2 12h26v11a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V12Z" fill="#fbd579"/>';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 30 32" aria-hidden="true" focusable="false">${body}</svg>`;
}

/**
 * File icon: a sheet with a folded corner and a coloured band carrying the
 * extension. The band label is trimmed to 4 characters so long extensions
 * ("markdown") stay legible rather than overflowing.
 */
export function fileIconSvg(name, { size = 48 } = {}) {
  const { color } = categoryOf(name);
  const extension = extensionOf(name);
  const label = extension ? extension.slice(0, 4).toUpperCase() : '';
  // Shrink the type text as it lengthens, so 4 characters still fit the band.
  const fontSize = label.length >= 4 ? 7 : label.length === 3 ? 8 : 9;

  const band = label
    ? `<rect x="0" y="20.5" width="21" height="10" rx="2" fill="${color}"/>` +
      `<text x="10.5" y="27.6" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"` +
      ` font-size="${fontSize}" font-weight="700" fill="#ffffff" letter-spacing="0.2">${escapeXml(label)}</text>`
    : '';

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 30 32" aria-hidden="true" focusable="false">` +
    '<path d="M6 1h12l8 8v21a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1Z" fill="#ffffff" stroke="#c9ced6" stroke-width="1.2"/>' +
    '<path d="M18 1l8 8h-7a1 1 0 0 1-1-1V1Z" fill="#e8ebef" stroke="#c9ced6" stroke-width="1.2" stroke-linejoin="round"/>' +
    band +
    '</svg>'
  );
}

/**
 * Choose the markup for one entry's icon.
 *
 * When `iconBasePath` is set the bundled per-extension artwork is used and the
 * drawn icon becomes the fallback for extensions the artwork does not cover —
 * an <img> that swaps itself out on error, so a missing file never leaves an
 * empty tile.
 *
 * A `customize` callback takes precedence over everything: return an image
 * URL, a raw `<svg>` string, or null to fall through to the default.
 *
 * Order of preference: the host's callback, then a real thumbnail of the file
 * itself, then the bundled artwork, then the drawn icon. Each step falls
 * through to the next on failure, so a server without thumbnails, a 415 for an
 * unsupported format and a corrupt image all end at the same drawn icon rather
 * than at an empty tile.
 *
 * @param {{name: string, path?: string, isDirectory: boolean}} entry
 * @param {{iconBasePath?: string|null, size?: number, open?: boolean,
 *          customize?: ((entry: object) => string|null)|null,
 *          thumbnailUrl?: ((entry: object, size: number) => string|null)|null,
 *          thumbnailSize?: number}} [options]
 */
export function resolveFileIcon(entry, options = {}) {
  const {
    iconBasePath = null,
    size = 48,
    open = false,
    customize = null,
    thumbnailUrl = null,
    thumbnailSize = 128,
  } = options;

  if (typeof customize === 'function') {
    let custom;
    try {
      custom = customize(entry);
    } catch (err) {
      // A host callback that throws must not blank out the whole listing.
      console.error('[bookmark-file-manager] customizeThumbnail threw', err);
      custom = null;
    }
    if (typeof custom === 'string' && custom.trim()) {
      const value = custom.trim();
      // A raw SVG is inlined; anything else is treated as an image source and
      // still gets the built-in icon as its error fallback.
      if (value.startsWith('<svg') || value.startsWith('<?xml')) return value;
      const fallback = entry.isDirectory
        ? folderIconSvg({ open, size })
        : fileIconSvg(entry.name, { size });
      return imgWithFallback(value, fallback, size, entry.name);
    }
  }

  if (entry.isDirectory) {
    if (iconBasePath) {
      const src = `${iconBasePath.replace(/\/+$/, '')}/folder.svg`;
      return imgWithFallback(src, folderIconSvg({ open, size }), size, entry.name);
    }
    return folderIconSvg({ open, size });
  }

  const drawn = fileIconSvg(entry.name, { size });
  const extension = extensionOf(entry.name);

  if (typeof thumbnailUrl === 'function' && entry.path && THUMBNAILABLE.has(extension)) {
    const src = thumbnailUrl(entry, thumbnailSize);
    if (src) return imgWithFallback(src, drawn, size, entry.name, { lazy: true });
  }

  if (iconBasePath && extension) {
    const src = `${iconBasePath.replace(/\/+$/, '')}/${encodeURIComponent(extension)}.svg`;
    return imgWithFallback(src, drawn, size, entry.name);
  }
  return drawn;
}

/**
 * An <img> that replaces itself with inline SVG when the source fails.
 * The fallback markup is carried in a data attribute rather than an inline
 * handler, so the widget stays compatible with a strict CSP.
 *
 * `lazy` matters for thumbnails specifically: the list renders in batches as
 * the user scrolls, and without it every batch would fire its requests the
 * moment its tiles are built rather than when they come into view.
 */
function imgWithFallback(src, fallbackSvg, size, alt, { lazy = false } = {}) {
  return (
    `<img class="fsfm-icon-img${lazy ? ' fsfm-thumb' : ''}" src="${escapeXml(src)}" ` +
    `width="${size}" height="${size}" alt=""` +
    (lazy ? ' loading="lazy" decoding="async"' : '') +
    ` data-fsfm-fallback="${escapeXml(fallbackSvg)}" data-fsfm-alt="${escapeXml(alt)}">`
  );
}

/**
 * Wire up icon fallbacks inside a container. Called after each render; uses
 * capture because the `error` event does not bubble.
 */
export function attachIconFallbacks(container) {
  container.addEventListener(
    'error',
    (event) => {
      const target = event.target;
      if (!(target instanceof HTMLImageElement)) return;
      if (!target.classList.contains('fsfm-icon-img')) return;
      const fallback = target.getAttribute('data-fsfm-fallback');
      if (!fallback) return;
      const holder = document.createElement('span');
      holder.className = 'fsfm-icon-drawn';
      holder.innerHTML = fallback;
      target.replaceWith(holder);
    },
    true
  );
}
