/**
 * REST client for the `bookmark-file-manager/server` router.
 *
 * The widget talks to a *provider*, never to fetch() directly, so a host can
 * swap this out for an in-memory, S3, or RPC-backed implementation as long as
 * the same method names are honoured.
 */

/** Error carrying the server's message and machine-readable code. */
export class ProviderError extends Error {
  /**
   * @param {string} message the server's own English text, shown when the
   *   widget has no translation for `code`
   * @param {string} code stable machine-readable code
   * @param {number} status HTTP status
   * @param {object|null} [params] values the server interpolated into the
   *   message — a path, a name, a limit — so the widget can build the same
   *   sentence in its own language
   */
  constructor(message, code = 'UNKNOWN', status = 0, params = null) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.status = status;
    this.params = params;
  }
}

export class HttpProvider {
  /**
   * @param {object} options
   * @param {string} options.endpoint base URL the router is mounted at
   * @param {RequestInit['headers']|(() => RequestInit['headers'])} [options.headers]
   *   extra headers (auth tokens); a function is called per request
   * @param {RequestCredentials} [options.credentials='same-origin']
   */
  constructor({ endpoint, headers, credentials = 'same-origin' } = {}) {
    if (!endpoint) throw new Error('HttpProvider requires an endpoint');
    this.endpoint = String(endpoint).replace(/\/+$/, '');
    this.headersOption = headers;
    this.credentials = credentials;
  }

  #headers(extra = {}) {
    const base = typeof this.headersOption === 'function' ? this.headersOption() : this.headersOption;
    return { ...(base || {}), ...extra };
  }

  url(route, query) {
    // Resolve against the document so a relative endpoint ("/api/files") works
    // the same as an absolute one pointing at another origin.
    const base = typeof document !== 'undefined' ? document.baseURI : 'http://localhost/';
    const url = new URL(`${this.endpoint}${route}`, base);
    for (const [key, value] of Object.entries(query || {})) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(key, item);
      } else {
        url.searchParams.set(key, value);
      }
    }
    return url.toString();
  }

  async #request(route, { method = 'GET', query, body, signal } = {}) {
    let response;
    try {
      response = await fetch(this.url(route, query), {
        method,
        credentials: this.credentials,
        signal,
        headers: this.#headers(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      throw new ProviderError('Could not reach the server', 'NETWORK', 0);
    }

    if (response.status === 204) return null;

    let payload = null;
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      payload = await response.json().catch(() => null);
    }

    if (!response.ok) {
      throw new ProviderError(
        payload?.error || `Error ${response.status}`,
        payload?.code || 'HTTP_ERROR',
        response.status,
        payload?.params ?? null
      );
    }
    return payload;
  }

  config(signal) {
    return this.#request('/config', { signal });
  }

  list(path, signal) {
    return this.#request('/list', { query: { path }, signal });
  }

  tree(path, depth = 1, signal) {
    return this.#request('/tree', { query: { path, depth }, signal });
  }

  stat(path, signal) {
    return this.#request('/stat', { query: { path }, signal });
  }

  /**
   * Full metadata for one entry. `computeSize` walks a directory's tree, so it
   * is opt-in rather than part of every properties request.
   */
  properties(path, { computeSize = false, signal } = {}) {
    return this.#request('/properties', {
      query: { path, size: computeSize ? '1' : undefined },
      signal,
    });
  }

  /**
   * Change permission bits.
   * @param {string[]} paths
   * @param {{mode?: string, executable?: boolean, recursive?: boolean}} change
   *   `mode` is octal digits as a string ("755"); a number would be read as
   *   decimal by JSON and silently mean something else.
   */
  chmod(paths, change = {}) {
    return this.#request('/chmod', {
      method: 'POST',
      body: {
        paths,
        ...(change.mode !== undefined ? { mode: String(change.mode) } : {}),
        ...(change.executable !== undefined ? { executable: !!change.executable } : {}),
        recursive: !!change.recursive,
      },
    });
  }

  /** Read a file as text for the code editor. */
  readText(path, signal) {
    return this.#request('/text', { query: { path }, signal });
  }

  /** Save edited text, keeping the encoding and line endings it came with. */
  saveText(path, text, options = {}) {
    return this.#request('/text/save', {
      method: 'POST',
      body: {
        path,
        text,
        encoding: options.encoding,
        bom: options.bom,
        newline: options.newline,
      },
    });
  }

  /** Open a spreadsheet as a workbook. */
  readSheet(path, signal) {
    return this.#request('/sheet', { query: { path }, signal });
  }

  /** Save an edited workbook back over its file. */
  saveSheet(path, workbook, options = {}) {
    return this.#request('/sheet/save', {
      method: 'POST',
      body: { path, workbook, format: options.format },
    });
  }

  /**
   * Search the tree below a path.
   *
   * @param {string} path where to start
   * @param {object} options query, mode, type, scope, extensions, caseSensitive
   * @param {AbortSignal} [signal] so a slow search can be abandoned
   */
  search(path, options = {}, signal) {
    return this.#request('/search', {
      query: {
        path,
        query: options.query,
        mode: options.mode,
        type: options.type,
        scope: options.scope,
        extensions: Array.isArray(options.extensions)
          ? options.extensions.join(',')
          : options.extensions,
        // Sent only when on: the server reads absence as off, and a `false`
        // in a query string is a string that is not empty.
        ...(options.caseSensitive ? { caseSensitive: '1' } : {}),
        ...(options.maxDepth ? { maxDepth: options.maxDepth } : {}),
        ...(options.limit ? { limit: options.limit } : {}),
      },
      signal,
    });
  }

  /** Open a document: rich text for docx/odt/doc, pages for PDF. */
  readDocument(path, signal) {
    return this.#request('/document', { query: { path }, signal });
  }

  /** Save an edited document back over its file. */
  saveDocument(path, document, options = {}) {
    return this.#request('/document/save', {
      method: 'POST',
      body: { path, document, format: options.format },
    });
  }

  /**
   * Delete, reorder, rotate, split or merge the pages of a PDF.
   *
   * @param {string} path the PDF the plan indexes as source 0
   * @param {Array<{source?: number, page: number, rotate?: number}>} plan
   * @param {{sources?: string[], target?: string}} [options]
   */
  saveDocumentPages(path, plan, options = {}) {
    return this.#request('/document/pages', {
      method: 'POST',
      body: { path, plan, sources: options.sources ?? [], target: options.target },
    });
  }

  /** What is inside an archive, without unpacking it. */
  listArchive(path, signal) {
    return this.#request('/archive/list', { query: { path }, signal });
  }

  /**
   * Pack a selection into a new archive.
   * @param {string[]} paths
   * @param {{format: string, destination?: string, name?: string}} options
   */
  createArchive(paths, options) {
    return this.#request('/archive', {
      method: 'POST',
      body: {
        paths,
        format: options.format,
        destination: options.destination,
        name: options.name,
      },
    });
  }

  /** Unpack one archive beside itself. */
  extract(path, options = {}) {
    return this.#request('/extract', {
      method: 'POST',
      body: { path, destination: options.destination },
    });
  }

  createDirectory(path, name) {
    return this.#request('/directory', { method: 'POST', body: { path, name } });
  }

  createFile(path, name, content = '') {
    return this.#request('/file', { method: 'POST', body: { path, name, content } });
  }

  rename(path, name) {
    return this.#request('/rename', { method: 'POST', body: { path, name } });
  }

  move(paths, destination, options = {}) {
    return this.#request('/move', {
      method: 'POST',
      body: { paths, destination, overwrite: !!options.overwrite },
    });
  }

  copy(paths, destination, options = {}) {
    return this.#request('/copy', {
      method: 'POST',
      body: { paths, destination, overwrite: !!options.overwrite },
    });
  }

  remove(paths) {
    return this.#request('/delete', { method: 'POST', body: { paths } });
  }

  /**
   * Browser URL for one entry's thumbnail.
   *
   * A separate route from downloadUrl() because a tile must not pull the
   * original: a folder of photos would otherwise cost hundreds of megabytes to
   * draw as 128px squares.
   *
   * @param {string} path virtual path
   * @param {number} size one of the sizes the server advertises in /config
   */
  thumbnailUrl(path, size) {
    return this.url('/thumbnail', { path, size });
  }

  /**
   * Browser URL for a viewable rendition of an image.
   *
   * Only for the formats no browser draws — TIFF and HEIC. Everything else is
   * shown from downloadUrl() untouched, because re-encoding a JPEG just to
   * look at it would lose something for nothing.
   *
   * @param {string} path virtual path
   * @param {number} width one of the widths the server advertises
   */
  renderUrl(path, width) {
    return this.url('/render', { path, width });
  }

  /** Browser URL that downloads the given paths (one file, or a zip). */
  downloadUrl(paths, { inline = false } = {}) {
    const list = Array.isArray(paths) ? paths : [paths];
    return this.url('/download', { paths: list, inline: inline ? '1' : undefined });
  }

  /**
   * Upload files with progress.
   *
   * Uses XMLHttpRequest rather than fetch: upload progress events are still
   * the only cross-browser way to drive a progress bar.
   *
   * @param {string} path destination directory
   * @param {File[]|FileList} files
   * @param {{onProgress?: (fraction: number, loaded: number, total: number) => void,
   *          overwrite?: boolean, signal?: AbortSignal}} [options]
   */
  upload(path, files, options = {}) {
    const list = Array.from(files);
    if (list.length === 0) return Promise.resolve({ uploaded: [], failures: [] });

    return new Promise((resolve, reject) => {
      const form = new FormData();
      // The destination field is appended first so the server knows where to
      // write before the first file part arrives.
      form.append('path', path);
      for (const file of list) form.append('files', file, file.name);

      const xhr = new XMLHttpRequest();
      xhr.open('POST', this.url('/upload', { path, overwrite: options.overwrite ? '1' : undefined }));
      xhr.withCredentials = this.credentials === 'include';

      for (const [key, value] of Object.entries(this.#headers())) {
        // Content-Type must stay unset so the browser adds the multipart boundary.
        if (key.toLowerCase() === 'content-type') continue;
        xhr.setRequestHeader(key, value);
      }

      xhr.upload.addEventListener('progress', (event) => {
        if (!event.lengthComputable) return;
        options.onProgress?.(event.loaded / event.total, event.loaded, event.total);
      });

      xhr.addEventListener('load', () => {
        let payload = null;
        try {
          payload = JSON.parse(xhr.responseText);
        } catch {
          payload = null;
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          options.onProgress?.(1, 1, 1);
          resolve(payload ?? { uploaded: [], failures: [] });
        } else {
          reject(
            new ProviderError(
              payload?.error || `Upload failed (${xhr.status})`,
              payload?.code || 'UPLOAD_FAILED',
              xhr.status,
              payload?.params ?? null
            )
          );
        }
      });

      xhr.addEventListener('error', () =>
        reject(new ProviderError('Network unavailable during upload', 'NETWORK', 0))
      );
      xhr.addEventListener('abort', () => {
        const err = new Error('Upload cancelled');
        err.name = 'AbortError';
        reject(err);
      });

      if (options.signal) {
        if (options.signal.aborted) {
          xhr.abort();
          return;
        }
        options.signal.addEventListener('abort', () => xhr.abort(), { once: true });
      }

      xhr.send(form);
    });
  }
}

export default HttpProvider;
