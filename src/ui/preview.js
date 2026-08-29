import { el, clear, trapFocus } from './dom.js';
import { icon } from './icons.js';
import { formatBytes, formatDate, extensionOf } from '../core/format.js';
import { registerOverlay } from './dialog.js';

/**
 * Formats the viewer can show, and how.
 *
 * `image` goes in an <img>. `frame` goes in an <iframe> and is handed to
 * whatever the browser brings: for PDF that is its own viewer, complete with
 * paging, zoom and search, which is far more than this widget would build.
 *
 * On containment, measured rather than assumed — the two cases differ:
 *
 *  - Markup that could carry script (an .svg, say) is stopped by the response
 *    header `Content-Security-Policy: default-src 'none'; sandbox`. Framing a
 *    hostile SVG from the same origin, its script does not run and the frame's
 *    contentDocument reads as null.
 *  - PDF is the exception. Chrome hands the frame to its own PDF viewer, and
 *    that document stays same-origin: contentDocument is reachable. What sits
 *    in it is not the file, though — it is Chrome's empty `pdf_embedder`
 *    shell, with the PDF itself rendered by the extension in a nested frame of
 *    its own. Any script inside the PDF runs in the browser's PDF sandbox,
 *    which has no path to this page's DOM. Containment there is the browser's,
 *    not this header's.
 */
const VIEWERS = new Map(Object.entries({
  jpg: 'image',
  jpeg: 'image',
  png: 'image',
  webp: 'image',
  ico: 'image',
  gif: 'image',
  avif: 'image',
  svg: 'image',
  bmp: 'image',
  tif: 'image',
  tiff: 'image',
  heic: 'image',
  heif: 'image',
  pdf: 'frame',
}));

/**
 * Formats no browser draws, which the server has to convert first.
 *
 * Checked against Chrome rather than assumed: each of the others was loaded
 * from a data: URL and reported its natural size, these two did not. Safari
 * shows HEIC natively, but relying on that would make the viewer work on one
 * browser and fail on the rest.
 */
const RENDER_REQUIRED = new Set(['tif', 'tiff', 'heic', 'heif']);

/** True when the viewer can show this entry at all. */
export function canPreview(entry) {
  return !entry.isDirectory && VIEWERS.has(extensionOf(entry.name));
}

export function previewKind(entry) {
  return VIEWERS.get(extensionOf(entry.name)) ?? null;
}

/** True when showing this entry needs the server to convert it. */
export function needsRender(entry) {
  return RENDER_REQUIRED.has(extensionOf(entry.name));
}

/** Beyond this the upscale is doing more harm than good. */
const MAX_ZOOM = 16;

/** Above this an upscale is smoothed; below it, kept as pixels. */
const PIXELATED_FROM = 3;

/**
 * Blow a small image up to something worth looking at.
 *
 * A 16×16 favicon shown at its natural size is a speck in the middle of the
 * viewer — technically faithful and useless. Browsers only ever shrink an
 * image to fit, never grow it, so the growing is done here: by a whole-number
 * factor, so every source pixel maps onto an exact block and the result stays
 * sharp instead of being interpolated into mush.
 */
function enlargeIfTiny(image) {
  const { naturalWidth: width, naturalHeight: height } = image;
  if (!width || !height) return;
  const stage = image.parentElement;
  if (!stage) return;

  const box = stage.getBoundingClientRect();
  if (box.width === 0 || box.height === 0) return;

  const factor = Math.min(
    Math.floor(box.width / width),
    Math.floor(box.height / height),
    MAX_ZOOM
  );
  if (factor < 2) return; // already fills the stage, or is larger than it

  image.style.width = `${width * factor}px`;
  image.style.height = `${height * factor}px`;
  if (factor >= PIXELATED_FROM) image.classList.add('is-pixelated');
}

/**
 * Full-size preview over the widget.
 *
 * Takes the whole list so the arrows can move between files without closing
 * and reopening: paging through a folder of photos is most of what a preview
 * is for. Entries the viewer cannot show are filtered out, so the arrows never
 * land on a .zip.
 *
 * @param {object} config
 * @param {HTMLElement} config.container element to render into
 * @param {object} config.provider needs downloadUrl()
 * @param {object[]} config.entries candidates, in display order
 * @param {object} config.entry the one to open first
 * @param {(entry: object) => void} [config.onDownload]
 * @param {boolean} [config.canDownload] show the download action
 * @param {{native: string[], render: string[], widths: number[]}} [config.view]
 *   what the server said it can show; formats needing conversion that it
 *   cannot do are reported to the user rather than shown broken
 * @returns {{close: () => void}}
 */
export function openPreview({
  container,
  provider,
  entries,
  entry,
  onDownload,
  canDownload = true,
  view = null,
  t = (key) => key,
  localeTag = undefined,
}) {
  const items = entries.filter(canPreview);
  let index = Math.max(0, items.findIndex((item) => item.path === entry.path));
  if (items.length === 0) return { close: () => {} };

  const title = el('h2.fsfm-preview-title', { text: '' });
  const counter = el('span.fsfm-preview-counter', { text: '' });
  const meta = el('span.fsfm-preview-meta', { text: '' });
  const stage = el('div.fsfm-preview-stage');

  const closeButton = el('button.fsfm-preview-close', {
    type: 'button',
    'aria-label': t('preview.close'),
    title: t('common.closeEsc'),
    html: icon('xLg', 16),
  });
  const prevButton = el('button.fsfm-preview-nav.fsfm-preview-prev', {
    type: 'button',
    'aria-label': t('preview.prev'),
    title: t('preview.prevKey'),
    html: icon('caretRightFill', 18),
  });
  const nextButton = el('button.fsfm-preview-nav.fsfm-preview-next', {
    type: 'button',
    'aria-label': t('preview.next'),
    title: t('preview.nextKey'),
    html: icon('caretRightFill', 18),
  });
  const downloadButton = el('button.fsfm-btn.fsfm-preview-download', {
    type: 'button',
    text: t('action.download'),
  });

  const panel = el('div.fsfm-preview', {
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': t('preview.title'),
  }, [
    el('div.fsfm-preview-head', {}, [title, counter, closeButton]),
    el('div.fsfm-preview-body', {}, [prevButton, stage, nextButton]),
    el('div.fsfm-preview-foot', {}, [meta, canDownload ? downloadButton : null].filter(Boolean)),
  ]);

  const backdrop = el('div.fsfm-backdrop.fsfm-preview-backdrop', {}, [panel]);
  const releaseFocus = trapFocus(panel);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    unregister();
    document.removeEventListener('keydown', onKeyDown, true);
    releaseFocus();
    // Drop the <img>/<iframe> before detaching, so a half-loaded 40 MB image
    // stops downloading the moment the viewer is dismissed.
    clear(stage);
    backdrop.remove();
  };
  const unregister = registerOverlay(container, close);

  function render() {
    const item = items[index];
    const kind = previewKind(item);
    title.textContent = item.name;
    counter.textContent =
      items.length > 1 ? t('preview.counter', { index: index + 1, total: items.length }) : '';
    meta.textContent = [formatBytes(item.size, t), formatDate(item.modified, localeTag)]
      .filter(Boolean)
      .join(' · ');

    prevButton.hidden = items.length < 2;
    nextButton.hidden = items.length < 2;
    prevButton.disabled = index === 0;
    nextButton.disabled = index === items.length - 1;

    clear(stage);

    // A format the browser cannot draw needs the server's help. If the server
    // cannot give it either, say so plainly: a broken image icon with no
    // explanation is the worst of the available outcomes.
    const extension = item.name.includes('.')
      ? item.name.slice(item.name.lastIndexOf('.') + 1).toLowerCase()
      : '';
    const mustRender = RENDER_REQUIRED.has(extension);
    if (mustRender && view && !view.render?.includes(extension)) {
      stage.append(
        el('div.fsfm-preview-error', {
          text: t('preview.unsupported', { format: extension.toUpperCase() }),
        })
      );
      return;
    }

    const url =
      mustRender && typeof provider.renderUrl === 'function'
        ? provider.renderUrl(item.path, view?.widths?.[2] ?? 2048)
        : provider.downloadUrl(item.path, { inline: true });

    if (kind === 'image') {
      const spinner = el('div.fsfm-spinner');
      stage.append(spinner);
      const image = el('img.fsfm-preview-image', {
        src: url,
        alt: item.name,
        on: {
          load: () => {
            spinner.remove();
            // Only meaningful once decoded, so it is filled in here rather
            // than from the listing, which has no idea of pixel dimensions.
            // For a converted image these are the *rendered* dimensions; the
            // server sends the original's in a header, which the fetch below
            // picks up. Showing the shrunk size would misdescribe the file.
            const dimensions = `${image.naturalWidth}×${image.naturalHeight}`;
            meta.textContent = [
              mustRender ? t('preview.scaled', { dimensions }) : dimensions,
              formatBytes(item.size, t),
              formatDate(item.modified, localeTag),
            ]
              .filter(Boolean)
              .join(' · ');
            enlargeIfTiny(image);
          },
          error: () => {
            spinner.remove();
            clear(stage).append(
              el('div.fsfm-preview-error', { text: t('preview.failed') })
            );
          },
        },
      });
      stage.append(image);
      return;
    }

    // PDF and anything else framed. The title attribute is what a screen
    // reader announces for the frame.
    //
    // Deliberately no `sandbox` attribute. Adding one reads like belt and
    // braces and is not: an empty sandbox withholds the privileges Chrome's
    // PDF viewer needs, so the frame renders "Chrome blocked this page"
    // instead of the document. A viewer that shows nothing is not the safer
    // option — see the note on VIEWERS for where the containment does come
    // from in each case.
    stage.append(
      el('iframe.fsfm-preview-frame', {
        src: url,
        title: item.name,
      })
    );
  }

  function go(delta) {
    const next = index + delta;
    if (next < 0 || next >= items.length) return;
    index = next;
    render();
  }

  function onKeyDown(event) {
    if (!document.contains(backdrop)) return;
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      go(-1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      go(1);
    }
  }

  closeButton.addEventListener('click', close);
  prevButton.addEventListener('click', () => go(-1));
  nextButton.addEventListener('click', () => go(1));
  downloadButton.addEventListener('click', () => onDownload?.(items[index]));
  backdrop.addEventListener('mousedown', (event) => {
    if (event.target === backdrop) close();
  });
  document.addEventListener('keydown', onKeyDown, true);

  container.append(backdrop);
  render();
  closeButton.focus();

  return { close, next: () => go(1), previous: () => go(-1) };
}
