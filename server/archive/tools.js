import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

const execFileAsync = promisify(execFile);

/**
 * External compressors, used as narrowly as possible.
 *
 * Node's zlib covers gzip and (from 22.15) zstd; bzip2, xz, 7z and rar it does
 * not. Writing an LZMA2 decoder by hand would be thousands of lines of the
 * kind of code where an infinite loop on a crafted input hides, so the work
 * goes to the programs that already exist for it.
 *
 * The important part is *how*. A subprocess here is only ever a byte-stream
 * converter:
 *
 *  - filters (bz2, xz, zst) run as `-dc`, stdin to stdout. They never see a
 *    filename at all.
 *  - containers (7z, rar) are turned into a tar stream by bsdtar and read back
 *    through this project's own tar reader.
 *
 * So every decision about what lands on disk, and under what name, stays in
 * code that can be read here — the archive's own paths are never handed to a
 * subprocess to act on. Nothing runs through a shell either: argv arrays only,
 * so a filename can never be parsed as an option or a command.
 */

/** Candidate binaries per role, in order of preference. */
const CANDIDATES = {
  bzip2: ['bzip2', 'pbzip2', 'lbzip2'],
  xz: ['xz'],
  zstd: ['zstd'],
  sevenZip: ['7zz', '7z', '7za'],
  bsdtar: ['bsdtar'],
  unrar: ['unrar', 'unar'],
};

/** How each filter is driven, once its binary is found. */
const FILTER_ARGS = {
  gz: { compress: ['-c'], decompress: ['-dc'] },
  bz2: { compress: ['-zc'], decompress: ['-dc'] },
  xz: { compress: ['-zc', '-T0'], decompress: ['-dc'] },
  zst: { compress: ['-q', '-c'], decompress: ['-q', '-d', '-c'] },
};

/** Give up on a probe quickly; a missing binary should not delay startup. */
const PROBE_TIMEOUT = 4000;

/** True when Node's own zlib can do zstd (22.15+ / 23.8+). */
export const NODE_HAS_ZSTD =
  typeof zlib.createZstdCompress === 'function' && typeof zlib.createZstdDecompress === 'function';

async function probe(binary) {
  try {
    // Every one of these answers --version or --help on stdout or stderr; the
    // only thing being tested is whether it runs at all.
    await execFileAsync(binary, ['--help'], { timeout: PROBE_TIMEOUT, maxBuffer: 1 << 20 });
    return true;
  } catch (err) {
    // A non-zero exit still proves the binary exists and ran.
    return err.code !== 'ENOENT' && err.code !== 'EACCES';
  }
}

/**
 * Look for the external programs once, at startup.
 *
 * The result is a plain description of what this particular machine can do,
 * which the router turns into the per-format capability map it advertises.
 * Nothing is assumed to be installed.
 */
export async function detectTools({ enabled = true } = {}) {
  const found = {};
  if (!enabled) return { enabled: false, found };

  const roles = Object.entries(CANDIDATES);
  const results = await Promise.all(
    roles.map(async ([role, binaries]) => {
      for (const binary of binaries) {
        if (await probe(binary)) return [role, binary];
      }
      return [role, null];
    })
  );
  for (const [role, binary] of results) found[role] = binary;
  return { enabled: true, found };
}

/**
 * Run a binary as a stdin -> stdout stream filter.
 *
 * The child's stderr is collected so a failure can say why, and the returned
 * stream errors rather than silently truncating when the child exits badly —
 * a compressor that dies halfway would otherwise produce a plausible-looking
 * short file.
 */
export function filterThrough(binary, args, input, { timeout = 0, onWarning } = {}) {
  const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] });

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (text) => {
    if (stderr.length < 8192) stderr += text;
  });

  let timer = null;
  if (timeout > 0) {
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      child.stdout.destroy(
        Object.assign(new Error(`${binary}: timed out`), { code: 'ARCHIVE_TIMEOUT' })
      );
    }, timeout);
  }

  child.on('error', (err) => {
    if (timer) clearTimeout(timer);
    child.stdout.destroy(
      Object.assign(new Error(`Could not start ${binary}: ${err.message}`), {
        code: 'ARCHIVE_TOOL_FAILED',
      })
    );
  });

  child.on('close', (code, signal) => {
    if (timer) clearTimeout(timer);
    if (code === 0) return;
    onWarning?.(`${binary} exited with code ${code ?? signal}`, stderr.trim());
    child.stdout.destroy(
      Object.assign(
        new Error(`${binary} failed${stderr ? `: ${stderr.trim().split('\n')[0]}` : ''}`),
        { code: 'ARCHIVE_TOOL_FAILED' }
      )
    );
  });

  input.on('error', (err) => {
    child.stdin.destroy(err);
  });
  // EPIPE is normal here: a decompressor that has read all it needs closes
  // stdin while the source is still writing.
  child.stdin.on('error', () => {});
  input.pipe(child.stdin);

  // A consumer that stops reading — a tar reader that hit the end-of-archive
  // marker, say — leaves the child blocked writing into a pipe nobody drains.
  // It would then never exit, and its pipe would hold the event loop open long
  // after the work was done.
  child.stdout.on('close', () => {
    if (timer) clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });

  return child.stdout;
}

/** The argv for compressing or decompressing with one of the filter tools. */
export function filterCommand(found, filter, direction) {
  const spec = FILTER_ARGS[filter];
  if (!spec) return null;
  const role = filter === 'bz2' ? 'bzip2' : filter === 'xz' ? 'xz' : filter === 'zst' ? 'zstd' : null;
  if (!role) return null;
  const binary = found[role];
  if (!binary) return null;
  return { binary, args: spec[direction] };
}

/**
 * Turn any archive bsdtar can read into a tar stream on stdout.
 *
 * This is what makes 7z and rar readable without teaching this project their
 * container formats: libarchive parses them, and what comes back out is a tar
 * stream that the reader here already knows how to validate entry by entry.
 */
export function archiveToTarStream(found, absolutePath, { timeout, onWarning } = {}) {
  if (!found.bsdtar) return null;
  const child = spawn(found.bsdtar, ['-cf', '-', `@${absolutePath}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (text) => {
    if (stderr.length < 8192) stderr += text;
  });

  let timer = null;
  if (timeout > 0) {
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      child.stdout.destroy(
        Object.assign(new Error('bsdtar: timed out'), { code: 'ARCHIVE_TIMEOUT' })
      );
    }, timeout);
  }

  child.on('error', (err) => {
    if (timer) clearTimeout(timer);
    child.stdout.destroy(
      Object.assign(new Error(`Could not start bsdtar: ${err.message}`), {
        code: 'ARCHIVE_TOOL_FAILED',
      })
    );
  });
  child.on('close', (code) => {
    if (timer) clearTimeout(timer);
    if (code !== 0) {
      onWarning?.(`bsdtar exited with code ${code}`, stderr.trim());
      child.stdout.destroy(
        Object.assign(new Error('Could not read the archive'), { code: 'ARCHIVE_TOOL_FAILED' })
      );
      return;
    }
    // Exit code 0 with complaints on stderr is a real case: libarchive skips
    // entries it dislikes and still succeeds, which without this would surface
    // as a silent "extracted 0 files" and no reason given.
    if (stderr.trim()) onWarning?.('bsdtar reported problems', stderr.trim());
  });

  // Same reaping as filterThrough: readTar stops at the end-of-archive marker
  // without draining what libarchive still has to write.
  child.stdout.on('close', () => {
    if (timer) clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });

  // Exposed so the caller can tell an empty archive from an unread one.
  child.stdout.toolDiagnostics = () => stderr.trim();
  return child.stdout;
}

/**
 * Write a tar stream out as some other container.
 *
 * The reverse of the above, and the reason creating a .7z needs no knowledge
 * of the 7z container here: this project produces the tar, libarchive
 * re-packs it. The only path the child is given is the destination, which is
 * a temporary name this code chose.
 */
export function tarStreamToArchive(found, tarStream, destination, format, { timeout, onWarning } = {}) {
  if (!found.bsdtar) return null;
  const formats = { '7z': '7zip', zip: 'zip' };
  const libarchiveFormat = formats[format];
  if (!libarchiveFormat) return null;

  return new Promise((resolve, reject) => {
    const child = spawn(
      found.bsdtar,
      ['-c', '-f', destination, '--format', libarchiveFormat, '@-'],
      { stdio: ['pipe', 'ignore', 'pipe'] }
    );

    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (text) => {
      if (stderr.length < 8192) stderr += text;
    });

    let timer = null;
    if (timeout > 0) {
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(Object.assign(new Error('bsdtar: timed out'), { code: 'ARCHIVE_TIMEOUT' }));
      }, timeout);
    }

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(Object.assign(new Error(`Could not start bsdtar: ${err.message}`), {
        code: 'ARCHIVE_TOOL_FAILED',
      }));
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve();
      else {
        onWarning?.(`bsdtar exited with code ${code}`, stderr.trim());
        reject(Object.assign(new Error('Could not create the archive'), { code: 'ARCHIVE_TOOL_FAILED' }));
      }
    });

    tarStream.on('error', (err) => child.stdin.destroy(err));
    child.stdin.on('error', () => {});
    tarStream.pipe(child.stdin);
  });
}
