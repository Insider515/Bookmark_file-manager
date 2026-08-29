/**
 * The archive formats this router knows about, and how each one is built.
 *
 * Three shapes, and the difference matters at every layer:
 *
 *  - `container`  holds many entries by itself (zip, 7z, rar, tar).
 *  - `tar`        a tar stream run through a compressor (tar.gz and friends).
 *  - `filter`     a compressor with no container at all (gz, bz2, xz, zst).
 *                 One file in, one file out — there is nowhere to put a second
 *                 name, so packing a selection into a bare .gz is refused and
 *                 the tar.gz form is suggested instead.
 */

/** Compressors usable both on their own and as a tar filter. */
export const FILTERS = {
  gz: { extension: 'gz', mime: 'application/gzip' },
  bz2: { extension: 'bz2', mime: 'application/x-bzip2' },
  xz: { extension: 'xz', mime: 'application/x-xz' },
  zst: { extension: 'zst', mime: 'application/zstd' },
};

/**
 * Every format, keyed by its canonical id.
 *
 * `extensions` lists every spelling that maps here; the first is the one used
 * when naming a new archive. Longer spellings are matched first, so "a.tar.gz"
 * never resolves as a bare ".gz" holding something called "a.tar".
 */
export const FORMATS = {
  zip: {
    id: 'zip',
    kind: 'container',
    extensions: ['zip'],
    mime: 'application/zip',
    label: 'ZIP',
  },
  '7z': {
    id: '7z',
    kind: 'container',
    extensions: ['7z'],
    mime: 'application/x-7z-compressed',
    label: '7z',
  },
  rar: {
    id: 'rar',
    kind: 'container',
    extensions: ['rar'],
    mime: 'application/vnd.rar',
    label: 'RAR',
    /**
     * Extraction only, and not for want of trying: the RAR compressor is
     * proprietary, the licence for the reference sources forbids using them to
     * build a compatible archiver, and no free encoder exists. 7-Zip answers
     * `E_NOTIMPL` to `-trar`; libarchive has no rar writer at all. Anything
     * claiming to create RAR here would be lying.
     */
    readOnly: true,
  },
  tar: {
    id: 'tar',
    kind: 'container',
    extensions: ['tar'],
    mime: 'application/x-tar',
    label: 'TAR',
  },

  'tar.gz': {
    id: 'tar.gz',
    kind: 'tar',
    filter: 'gz',
    extensions: ['tar.gz', 'tgz'],
    mime: 'application/gzip',
    label: 'TAR + gzip',
  },
  'tar.bz2': {
    id: 'tar.bz2',
    kind: 'tar',
    filter: 'bz2',
    extensions: ['tar.bz2', 'tbz2', 'tbz'],
    mime: 'application/x-bzip2',
    label: 'TAR + bzip2',
  },
  'tar.xz': {
    id: 'tar.xz',
    kind: 'tar',
    filter: 'xz',
    extensions: ['tar.xz', 'txz'],
    mime: 'application/x-xz',
    label: 'TAR + xz',
  },
  'tar.zst': {
    id: 'tar.zst',
    kind: 'tar',
    filter: 'zst',
    extensions: ['tar.zst', 'tzst'],
    mime: 'application/zstd',
    label: 'TAR + zstd',
  },

  gz: { id: 'gz', kind: 'filter', filter: 'gz', extensions: ['gz'], mime: FILTERS.gz.mime, label: 'gzip' },
  bz2: { id: 'bz2', kind: 'filter', filter: 'bz2', extensions: ['bz2'], mime: FILTERS.bz2.mime, label: 'bzip2' },
  xz: { id: 'xz', kind: 'filter', filter: 'xz', extensions: ['xz'], mime: FILTERS.xz.mime, label: 'xz' },
  zst: { id: 'zst', kind: 'filter', filter: 'zst', extensions: ['zst'], mime: FILTERS.zst.mime, label: 'zstd' },
};

export const FORMAT_IDS = Object.keys(FORMATS);

/**
 * extension -> format id, longest first.
 *
 * The ordering is the whole point: ".tar.gz" and ".gz" both end in "gz", and
 * matching the short one first would treat every tarball as a lone compressed
 * file called "something.tar".
 */
const BY_EXTENSION = (() => {
  const pairs = [];
  for (const format of Object.values(FORMATS)) {
    for (const extension of format.extensions) pairs.push([extension, format.id]);
  }
  pairs.sort((a, b) => b[0].length - a[0].length);
  return pairs;
})();

/** The format a filename claims to be, or null. */
export function formatFromName(name) {
  const lower = String(name).toLowerCase();
  for (const [extension, id] of BY_EXTENSION) {
    if (lower.endsWith(`.${extension}`)) return FORMATS[id];
  }
  return null;
}

/** True when the name looks like something this router can unpack. */
export function isArchiveName(name) {
  return formatFromName(name) !== null;
}

/**
 * The name an archive should unpack into, for the single-file formats.
 * "notes.txt.gz" -> "notes.txt"; a name with nothing left over gets a suffix
 * rather than becoming empty.
 */
export function strippedName(name, format) {
  const lower = String(name).toLowerCase();
  for (const extension of format.extensions) {
    if (lower.endsWith(`.${extension}`)) {
      const base = String(name).slice(0, -(extension.length + 1));
      return base || `${name}.out`;
    }
  }
  return `${name}.out`;
}

/**
 * Magic bytes, checked against what the name claims.
 *
 * A mismatch is not fought over — the content wins, because the extension is
 * whatever a client typed and the bytes are what a decoder will actually meet.
 */
const SIGNATURES = [
  { id: 'zip', bytes: [0x50, 0x4b, 0x03, 0x04] },
  { id: 'zip', bytes: [0x50, 0x4b, 0x05, 0x06] }, // empty archive
  { id: 'zip', bytes: [0x50, 0x4b, 0x07, 0x08] }, // spanned
  { id: '7z', bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] },
  { id: 'rar', bytes: [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00] }, // RAR 4
  { id: 'rar', bytes: [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00] }, // RAR 5
  { id: 'gz', bytes: [0x1f, 0x8b] },
  { id: 'bz2', bytes: [0x42, 0x5a, 0x68] },
  { id: 'xz', bytes: [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00] },
  { id: 'zst', bytes: [0x28, 0xb5, 0x2f, 0xfd] },
];

/** What the first bytes say the file is, ignoring its name. Null if unknown. */
export function formatFromMagic(buffer) {
  for (const signature of SIGNATURES) {
    if (buffer.length < signature.bytes.length) continue;
    let matched = true;
    for (let i = 0; i < signature.bytes.length; i += 1) {
      if (buffer[i] !== signature.bytes[i]) {
        matched = false;
        break;
      }
    }
    if (matched) return FORMATS[signature.id];
  }
  // tar has no magic at offset 0; "ustar" sits at 257 and only in POSIX tars.
  if (buffer.length >= 262 && buffer.subarray(257, 262).toString('latin1') === 'ustar') {
    return FORMATS.tar;
  }
  return null;
}

/**
 * Reconcile the name against the bytes.
 *
 * A gzip stream may be a tarball or a lone compressed file, and only the name
 * distinguishes them — so when the magic says "gz" and the name says "tar.gz",
 * the name is the more specific of two compatible answers and wins.
 */
export function resolveFormat(name, magicBuffer) {
  const byName = formatFromName(name);
  const byMagic = magicBuffer ? formatFromMagic(magicBuffer) : null;
  if (!byMagic) return byName;
  if (!byName) return byMagic;
  if (byName.id === byMagic.id) return byName;
  // tar.gz vs gz, tar.xz vs xz, ... — same bytes, the name says which.
  if (byName.kind === 'tar' && byName.filter === byMagic.id) return byName;
  return byMagic;
}
