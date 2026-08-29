/**
 * The little bit of HTTP the file manager needs, without a framework.
 *
 * This exists so the router can be mounted anywhere — AdonisJS, Fastify, Nest,
 * plain `node:http` — instead of only in Express. It is not a general router:
 * every route here is a fixed path with no parameters, so matching is a lookup
 * on `method + pathname` and nothing more.
 *
 * The handler it produces has the signature `(req, res, next)`, which is also
 * exactly what Express accepts as middleware. One function serves both worlds,
 * and Express stops being a dependency at all.
 */
import { FsError } from './safe-path.js';

/** '16mb' -> 16777216. A number passes through. */
export function parseSize(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return fallback;
  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i.exec(value.trim());
  if (!match) return fallback;
  const units = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 };
  return Math.round(Number(match[1]) * units[(match[2] ?? 'b').toLowerCase()]);
}

/**
 * Repeated keys become an array, a single key stays a string.
 *
 * That is what the routes expect: `?paths=/a&paths=/b` has to arrive as two
 * paths, and `?path=/a` as one string.
 */
export function parseQuery(searchParams) {
  const query = Object.create(null);
  for (const key of new Set(searchParams.keys())) {
    const all = searchParams.getAll(key);
    query[key] = all.length > 1 ? all : all[0];
  }
  return query;
}

/**
 * Read and parse a JSON body, refusing one that is too large.
 *
 * The limit is a function of the request rather than a constant: the editors
 * post whole documents, so those routes allow far more than the rest, and a
 * single global limit would either reject them or open everything up.
 */
async function readJsonBody(req, limitFor) {
  const type = String(req.headers['content-type'] ?? '');
  if (!type.includes('application/json')) return undefined;

  const limit = limitFor(req);
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    throw new FsError(413, 'TOO_LARGE', 'The request is too large');
  }

  const chunks = [];
  let size = 0;
  let overflowed = false;
  // Once the body is known to be too large, the rest of it is read and thrown
  // away rather than kept. Two failed attempts are behind that: destroying the
  // socket meant the 413 never reached the client, and simply stopping meant
  // the client was still writing when the response came and saw a reset. Both
  // times the user got "network error" instead of being told the file was too
  // big. Draining costs bandwidth that is already on the wire, and is bounded
  // so a flood still gets cut off.
  const drainLimit = limit + 4 * 1024 * 1024;
  for await (const chunk of req) {
    size += chunk.length;
    // Checked as it arrives, not only against Content-Length: that header is
    // the client's claim, and a chunked request has none at all.
    if (size > limit) {
      overflowed = true;
      chunks.length = 0;
      if (size > drainLimit) {
        req.destroy();
        break;
      }
      continue;
    }
    chunks.push(chunk);
  }
  if (overflowed) {
    throw new FsError(413, 'TOO_LARGE', 'The request is too large');
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new FsError(400, 'INVALID_JSON', 'The request body is not valid JSON');
  }
}

/**
 * Give a raw node request and response the handful of conveniences the routes
 * use, without pulling in a framework to provide them.
 *
 * Express already defines several of these on its prototypes as getters, so
 * they are installed with defineProperty rather than assignment — under
 * Express 5 a plain assignment to `req.query` throws.
 */
function decorate(req, res, basePath) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  let pathname = url.pathname;
  // A host that mounts at a prefix passes it as `basePath`. Express rewrites
  // `req.url` itself when mounted, so there it is already relative and this
  // does nothing.
  if (basePath && pathname.startsWith(basePath)) {
    pathname = pathname.slice(basePath.length) || '/';
  }
  if (!pathname.startsWith('/')) pathname = `/${pathname}`;

  const define = (target, name, value) =>
    Object.defineProperty(target, name, { value, configurable: true, writable: true });

  define(req, 'path', pathname);
  define(req, 'query', parseQuery(url.searchParams));
  if (typeof req.get !== 'function') {
    define(req, 'get', (name) => req.headers[String(name).toLowerCase()]);
  }
  if (!req.protocol) {
    define(req, 'protocol', req.socket?.encrypted ? 'https' : 'http');
  }

  if (typeof res.status !== 'function') {
    define(res, 'status', (code) => {
      res.statusCode = code;
      return res;
    });
  }
  if (typeof res.json !== 'function') {
    define(res, 'json', (payload) => {
      if (!res.headersSent) res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(payload));
      return res;
    });
  }
  return req;
}

/**
 * A router over fixed paths.
 *
 * `use(fn)` registers a middleware that runs for every request; `get`/`post`
 * register one path each. Error middleware is whatever `use` receives with
 * four parameters, matching the convention the routes were written against.
 */
export function createRouter({ basePath = '', jsonLimit } = {}) {
  const middleware = [];
  const routes = new Map();
  const errorHandlers = [];

  const key = (method, path) => `${method} ${path}`;

  const router = {
    use(fn) {
      if (typeof fn !== 'function') return router;
      if (fn.length >= 4) errorHandlers.push(fn);
      else middleware.push(fn);
      return router;
    },
    get(path, ...handlers) {
      routes.set(key('GET', path), handlers);
      return router;
    },
    post(path, ...handlers) {
      routes.set(key('POST', path), handlers);
      return router;
    },
    /** Every path this router answers, for a host that wants to mount them. */
    paths() {
      return [...routes.keys()].map((entry) => {
        const [method, path] = entry.split(' ');
        return { method, path };
      });
    },
  };

  /**
   * The mounted handler. Returns true when it answered, false when the path
   * belongs to somebody else — a host can use that to fall through.
   */
  async function handle(req, res, next) {
    decorate(req, res, basePath);

    const chain = routes.get(key(req.method, req.path));
    if (!chain) {
      // HEAD is answered by the GET route; node drops the body itself.
      const asGet = req.method === 'HEAD' ? routes.get(key('GET', req.path)) : null;
      if (!asGet) {
        if (typeof next === 'function') {
          next();
          return false;
        }
        res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
        return true;
      }
    }

    const handlers = chain ?? routes.get(key('GET', req.path));

    try {
      if (jsonLimit && req.method === 'POST' && req.body === undefined) {
        const parsed = await readJsonBody(req, jsonLimit);
        if (parsed !== undefined) req.body = parsed;
      }
      if (req.body === undefined) req.body = {};

      for (const fn of [...middleware, ...handlers]) {
        // Each link decides whether the chain continues, the way the routes
        // were already written to expect.
        let advance = false;
        await new Promise((resolve, reject) => {
          const step = (err) => {
            if (err) reject(err);
            else {
              advance = true;
              resolve();
            }
          };
          Promise.resolve(fn(req, res, step)).then(
            () => resolve(),
            (err) => reject(err)
          );
        });
        if (!advance) break;
      }
    } catch (err) {
      for (const fn of errorHandlers) {
        await fn(err, req, res, () => {});
      }
      if (!res.writableEnded && !res.headersSent) {
        res.status(500).json({ error: 'Internal server error', code: 'INTERNAL' });
      }
    }
    return true;
  }

  handle.router = router;
  handle.use = router.use;
  handle.get = router.get;
  handle.post = router.post;
  handle.paths = router.paths;
  return handle;
}
