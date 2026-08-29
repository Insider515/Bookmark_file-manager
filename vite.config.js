import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Browsers the stylesheet is compiled for.
 *
 * The floor is container queries, which the layout depends on completely: they
 * are what makes the widget adapt to its own box rather than to the window.
 * Vite's default CSS target is older than they are, and while today's minifier
 * happens to pass them through untouched, nothing promises that — naming the
 * target says out loud what the stylesheet actually needs.
 */
const CSS_TARGET = ['chrome105', 'safari16', 'firefox110', 'edge105'];

/**
 * Two builds from one config, selected by Vite's own --mode flag so no
 * environment-variable shell syntax is involved (that syntax differs on
 * Windows):
 *
 *   vite build                library  -> dist/bookmark-file-manager.{js,umd.cjs} + css
 *   vite build --mode demo    demo page -> demo-dist/, served by `npm run serve`
 *
 * They write to different directories on purpose: sharing one `dist/` would
 * have the library build delete the demo's index.html and vice versa.
 *
 * The library build externalises nothing — the widget has no runtime
 * dependencies, so the bundle is self-contained by construction.
 */
export default defineConfig(({ mode }) => {
  const isDemo = mode === 'demo';

  return {
    root: isDemo ? path.join(here, 'demo') : here,
    // The demo serves the bundled per-extension artwork so `iconBasePath` can
    // be exercised; the library build ships no static assets.
    publicDir: isDemo ? path.join(here, 'assets') : false,
    build: isDemo
      ? {
          outDir: path.join(here, 'demo-dist'),
          emptyOutDir: true,
          sourcemap: true,
          cssTarget: CSS_TARGET,
        }
      : {
          outDir: path.join(here, 'dist'),
          emptyOutDir: true,
          sourcemap: true,
          cssTarget: CSS_TARGET,
          lib: {
            entry: path.join(here, 'src/index.js'),
            name: 'BookmarkFileManager',
            formats: ['es', 'umd'],
            fileName: (format) => (format === 'es' ? 'bookmark-file-manager.js' : 'bookmark-file-manager.umd.cjs'),
          },
          rollupOptions: {
            output: {
              // A fixed name keeps the `./style.css` export path stable across
              // builds, so consumers' imports never break.
              assetFileNames: 'bookmark-file-manager.[ext]',
              // The entry exports both named bindings and a default; without
              // this the UMD global would hide them behind `.default`.
              exports: 'named',
            },
          },
        },
    server: {
      // Only used when Vite is started on its own; `npm run dev` runs Vite as
      // middleware inside the API server, where no proxy is needed.
      proxy: { '/api': 'http://localhost:5173' },
    },
  };
});
