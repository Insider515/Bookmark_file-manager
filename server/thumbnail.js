import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);

/**
 * Image rendering: thumbnails for the listing, and full-size renditions for
 * the viewer.
 *
 * Two paths, because no single decoder covers what a file manager runs into:
 *
 *  - Formats libvips decodes are re-encoded to a small WebP. That is the point
 *    of the endpoint: a tile must not cost the browser a 5 MB original.
 *  - Formats it does not decode — .ico above all — are streamed as they are.
 *    An .ico is a few kilobytes and every browser draws it natively, so there
 *    is nothing to gain by refusing it.
 *
 * PDF is in neither set. Rasterising its first page needs a PDF engine
 * (poppler, mupdf, pdfium); libvips only has one when built against poppler,
 * which the prebuilt sharp binaries are not. PDFs therefore keep their drawn
 * icon in the listing and are previewed full-size in the viewer instead, where
 * the browser's own PDF engine does the work.
 */

/** Decoded and re-encoded by sharp, when it is installed. */
export const RASTER_THUMBNAIL = new Set([
  'jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'tif', 'tiff', 'heic', 'heif',
]);

/**
 * Sent as-is. `ico` and `bmp` because libvips cannot read either and every
 * browser draws both; `svg` because it is already resolution-independent —
 * rasterising it for a 128px tile would be strictly worse than letting the
 * browser draw it.
 *
 * The cost for bmp is that the file goes over the wire whole, so a large
 * uncompressed one exceeds the pass-through cap and falls back to the drawn
 * icon. There is no way around that short of writing a BMP decoder.
 */
export const RAW_THUMBNAIL = new Set(['ico', 'svg', 'bmp']);

export const THUMBNAILABLE = new Set([...RASTER_THUMBNAIL, ...RAW_THUMBNAIL]);

/** Content types for the pass-through path. */
const RAW_TYPES = {
  ico: 'image/vnd.microsoft.icon',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
};

/**
 * A 100-megapixel image decodes to ~400 MB of raw pixels whatever its file
 * size is, which makes an innocuous-looking upload a memory exhaustion attack.
 * libvips enforces this limit before allocating.
 */
export const DEFAULT_PIXEL_LIMIT = 50 * 1024 * 1024;

let sharpModule = null;
let sharpMissing = false;

/**
 * Load sharp on first use. It is an optional peer dependency: hosts that do
 * not want a native image library still get pass-through thumbnails and every
 * other feature, so a missing module is a fact to record, not an error.
 */
export function loadSharp() {
  if (sharpModule) return sharpModule;
  if (sharpMissing) return null;
  try {
    sharpModule = require('sharp');
  } catch {
    sharpMissing = true;
    return null;
  }
  return sharpModule;
}

/** True when this extension can produce a thumbnail at all. */
export function canThumbnail(extension) {
  return THUMBNAILABLE.has(extension);
}

/**
 * Render one thumbnail.
 *
 * @param {string} absolute path to the source file
 * @param {string} extension lowercase, no dot
 * @param {{size: number, pixelLimit?: number, quality?: number}} options
 * @returns {Promise<{buffer: Buffer, contentType: string, generator: string}|null>}
 *   null when the caller should stream the original instead.
 */
export async function renderThumbnail(absolute, extension, options) {
  const { size, pixelLimit = DEFAULT_PIXEL_LIMIT, quality = 72, toolTimeout = 60000 } = options;
  if (!RASTER_THUMBNAIL.has(extension)) return null;

  const sharp = loadSharp();
  if (!sharp) return null;

  // The same HEIC detour the viewer takes. Without it a folder of phone photos
  // shows a grid of generic icons on any machine whose sharp lacks an HEVC
  // decoder — which is most of them.
  let source = absolute;
  let temporary = null;
  if ((extension === 'heic' || extension === 'heif') && heifSupport === 'tool') {
    temporary = await convertHeifExternally(absolute, toolTimeout);
    if (!temporary) return null;
    source = temporary;
  }

  try {
    return await thumbnailWith(sharp, source, { size, pixelLimit, quality });
  } finally {
    if (temporary) await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function thumbnailWith(sharp, absolute, { size, pixelLimit, quality }) {
  const buffer = await sharp(absolute, {
    limitInputPixels: pixelLimit,
    sequentialRead: true,
    // Only the first frame of an animated GIF/WebP: a tile is a still.
    animated: false,
    failOn: 'error',
  })
    // No argument means "apply the EXIF orientation", without which every
    // photo shot in portrait on a phone comes back on its side.
    .rotate()
    .resize(size, size, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality, effort: 4 })
    .toBuffer();

  return { buffer, contentType: 'image/webp', generator: 'webp' };
}

/** Content type for a file streamed as its own thumbnail. */
export function rawThumbnailType(extension) {
  return RAW_TYPES[extension] ?? null;
}

/**
 * What a browser draws by itself, verified rather than assumed: each of these
 * was loaded from a data: URL in Chrome and reported its natural size.
 * They are served byte-for-byte, with no re-encoding to lose anything.
 */
export const BROWSER_NATIVE = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg',
]);

/**
 * What a browser will not draw, so the server has to convert it first.
 *
 * TIFF no browser has ever displayed. HEIC only Safari does, and relying on
 * that would make the viewer work on one browser and silently fail on the
 * rest — converting for everyone is the predictable choice.
 */
export const NEEDS_RENDER = new Set(['tif', 'tiff', 'heic', 'heif']);

/** Everything the viewer can show, one way or the other. */
export const VIEWABLE = new Set([...BROWSER_NATIVE, ...NEEDS_RENDER]);

/** Widths /render accepts. An open-ended parameter is a CPU sink. */
export const RENDER_WIDTHS = [1024, 1600, 2048, 2560];

/**
 * A 300x200 HEIC, used to find out whether HEVC can be decoded here at all.
 *
 * Deliberately an ordinary size rather than the smallest thing that would
 * encode: libheif applies a security limit that rejects a 2x2 image outright
 * ("image size 160x64 exceeds the maximum 4356"), so a minimal fixture makes
 * working converters look broken.
 *
 * It cannot be assumed. libvips advertises `heif` input whenever libheif is
 * present, but the prebuilt sharp binaries ship libheif without an HEVC
 * decoder — HEVC is patent-encumbered in a way AV1 is not — so AVIF loads and
 * HEIC fails with an obscure "bad seek" from deep inside the loader. The only
 * honest way to know is to try one.
 */
const HEIF_PROBE = Buffer.from(
  'AAAAJGZ0eXBoZWljAAAAAG1pZjFNaVBybWlhZk1pSEJoZWljAAABwm1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAHBpY3QA' +
  'AAAAAAAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAAADnBpdG0AAAAAAAEAAAA4aWlu' +
  'ZgAAAAAAAgAAABVpbmZlAgAAAAABAABodmMxAAAAABVpbmZlAgAAAQACAABFeGlmAAAAABppcmVmAAAAAAAAAA5jZHNj' +
  'AAIAAQABAAAA5WlwcnAAAADEaXBjbwAAABNjb2xybmNseAACAAIABoAAAAAMY2xsaQDLAEAAAAAUaXNwZQAAAAAAAAEs' +
  'AAAAyAAAAAlpcm90AAAAABBwaXhpAAAAAAMICAgAAABwaHZjQwEDcAAAALAAAAAAADzwAPz9+PgAAAsDoAABABdAAQwB' +
  '//8DcAAAAwCwAAADAAADADxwJKEAAQAiQgEBA3AAAAMAsAAAAwAAAwA8oAmIDR3LiHuRZVNwICBgCKIAAQAJRAHAYXLI' +
  'QFMkAAAAGWlwbWEAAAAAAAAAAQABBoECAwWGhAAAACxpbG9jAAAAAEQAAAIAAQAAAAEAAAJCAAAAaQACAAAAAQAAAfYA' +
  'AABMAAAAAW1kYXQAAAAAAAAAxQAAAAZFeGlmAABNTQAqAAAACAADARoABQAAAAEAAAAyARsABQAAAAEAAAA6ASgAAwAA' +
  'AAEAAgAAAAAAAAAAABkAAAABAAAAGQAAAAEAAABlKAGvnLlikpRARoF8//ljH//Z3+y+eTj7Fv2elHskxrwGpJA+bcX8' +
  '44qL8r803ilgIrFiI+1inf2oBRQKr16i2EUAACHgAuHwigAAAwAlYAPSwAAAAwAM2AAAAwAAAwAAAwAAZUA=',
  'base64'
);

let heifSupport = null;
let heifConverter = null;

/**
 * External HEIC converters, in order of preference. All are given argv arrays
 * and paths this code chose; none goes through a shell.
 */
const HEIF_CONVERTERS = [
  { binary: 'heif-convert', args: (input, output) => [input, output] },
  { binary: 'magick', args: (input, output) => [input, output] },
  { binary: 'convert', args: (input, output) => [input, output] },
  // macOS only, but present on every Mac.
  { binary: 'sips', args: (input, output) => ['-s', 'format', 'png', input, '--out', output] },
];

/**
 * Whether HEIC/HEIF pixels can actually be produced here, and by what.
 *
 * The probe decodes rather than inspects, and that distinction is the whole
 * point: `metadata()` on a HEIC succeeds even when the pixels cannot be read,
 * because libheif parses the container happily and only fails when asked for
 * image data it has no HEVC decoder for. A probe that only read the headers
 * would report support that the viewer would then fail to deliver.
 */
export async function probeHeifSupport() {
  if (heifSupport !== null) return heifSupport;

  const sharp = loadSharp();
  if (sharp) {
    try {
      // toBuffer() is what forces an actual decode.
      await sharp(HEIF_PROBE).resize(1, 1, { fit: 'inside' }).png().toBuffer();
      heifSupport = 'sharp';
      return heifSupport;
    } catch {
      // Falls through: the build has libheif but no HEVC decoder in it.
    }
  }

  // Each candidate is asked to convert the fixture, not merely to exist. The
  // distinction is the same one that makes the sharp probe decode rather than
  // read headers: a binary being installed says nothing about whether it has
  // an HEVC decoder behind it.
  const probeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fsfm-heif-probe-'));
  const input = path.join(probeDir, 'probe.heic');
  try {
    await fs.writeFile(input, HEIF_PROBE);
    for (const candidate of HEIF_CONVERTERS) {
      const output = path.join(probeDir, `out-${candidate.binary}.png`);
      try {
        await execFileAsync(candidate.binary, candidate.args(input, output), {
          timeout: 8000,
          maxBuffer: 1 << 20,
        });
        const stats = await fs.stat(output);
        if (stats.size > 0) {
          heifConverter = candidate;
          heifSupport = 'tool';
          return heifSupport;
        }
      } catch {
        // Missing, or present without a decoder. Either way: try the next.
      }
    }
  } finally {
    await fs.rm(probeDir, { recursive: true, force: true }).catch(() => {});
  }

  heifSupport = false;
  return heifSupport;
}

/** How HEIC is handled here: 'sharp', 'tool', or false. Null before probing. */
export function heifSupported() {
  return heifSupport;
}

/**
 * Decode a HEIC to a PNG this process can then work with.
 *
 * Only reached when sharp itself cannot, and only ever given paths chosen
 * here — the source is one the router already resolved inside the root, and
 * the destination is a fresh temporary name.
 */
async function convertHeifExternally(absolute, timeout) {
  if (!heifConverter) return null;
  const output = path.join(
    os.tmpdir(),
    `fsfm-heif-${process.pid}-${crypto.randomBytes(6).toString('hex')}.png`
  );
  try {
    await execFileAsync(heifConverter.binary, heifConverter.args(absolute, output), {
      timeout,
      maxBuffer: 1 << 20,
    });
    return output;
  } catch {
    await fs.rm(output, { force: true }).catch(() => {});
    return null;
  }
}

/**
 * Render one image for the viewer: same pixels, a format the browser accepts,
 * bounded so a 100-megapixel scan does not arrive at full size.
 *
 * @returns {Promise<{buffer: Buffer, contentType: string, width: number, height: number}|null>}
 *   null when this file is not something sharp can read.
 */
export async function renderForView(absolute, extension, options) {
  const { width, pixelLimit = DEFAULT_PIXEL_LIMIT, quality = 82, toolTimeout = 60000 } = options;
  if (!RASTER_THUMBNAIL.has(extension)) return null;

  const sharp = loadSharp();
  if (!sharp) return null;

  // HEIC that this build cannot decode goes through an external converter
  // first, and the rest of the pipeline then treats it as an ordinary PNG.
  let source = absolute;
  let temporary = null;
  if ((extension === 'heic' || extension === 'heif') && heifSupport === 'tool') {
    temporary = await convertHeifExternally(absolute, toolTimeout);
    if (!temporary) return null;
    source = temporary;
  }

  try {
    return await renderWith(sharp, source, { width, pixelLimit, quality });
  } finally {
    if (temporary) await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function renderWith(sharp, absolute, { width, pixelLimit, quality }) {
  const pipeline = sharp(absolute, {
    limitInputPixels: pixelLimit,
    sequentialRead: true,
    animated: false,
    failOn: 'error',
  }).rotate();

  const metadata = await pipeline.metadata();
  const buffer = await pipeline
    .resize(width, width, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality, effort: 4 })
    .toBuffer();

  return {
    buffer,
    contentType: 'image/webp',
    // The original dimensions, not the rendered ones: the viewer reports what
    // the file actually is, not what it was shrunk to.
    width: metadata.width ?? null,
    height: metadata.height ?? null,
  };
}

/**
 * What the viewer can show here, split by how.
 *
 * `native` goes to the browser untouched — no re-encoding, so nothing is lost.
 * `render` has to be converted first, and only lists what this machine can
 * genuinely convert: TIFF needs sharp, HEIC needs sharp with an HEVC decoder
 * or an external converter, and where neither is present the format is simply
 * absent rather than offered and broken.
 */
export function viewCapabilities() {
  const sharp = loadSharp();
  const render = [];
  if (sharp) {
    render.push('tif', 'tiff');
    if (heifSupport === 'sharp' || heifSupport === 'tool') render.push('heic', 'heif');
  }
  return {
    native: [...BROWSER_NATIVE],
    render,
    widths: RENDER_WIDTHS,
    heif: heifSupport ?? false,
  };
}
