/**
 * Development / demo server. Not part of the published package surface —
 * it exists so `npm run dev` gives a working manager out of the box.
 *
 *   node server/standalone.js            serve the built demo from dist/
 *   node server/standalone.js --vite     serve the demo through Vite (HMR)
 *
 * Options: --port, --root, --read-only, --host, --chmod
 *
 * It binds to 127.0.0.1 unless --host says otherwise. This server has no
 * authentication of any kind: listening on every interface would put a
 * read-write file manager over a real directory on the local network.
 */
import express from 'express';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { createFileManagerRouter } from './router.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : true;
}

const port = Number(arg('port', process.env.PORT || 5173));
const storageRoot = path.resolve(String(arg('root', process.env.FM_ROOT || path.join(projectRoot, 'storage'))));
const readOnly = arg('read-only', false) === true;
const host = String(arg('host', process.env.FM_HOST || '127.0.0.1'));
// Off unless asked for, matching the router's own default for this one.
const allowChmod = arg('chmod', false) === true;
const useVite = process.argv.includes('--vite');

/** Seed a sample tree the first time, so the demo is not an empty window. */
async function seed(root) {
  await fs.mkdir(root, { recursive: true });
  const existing = await fs.readdir(root);
  if (existing.length > 0) return;

  const layout = {
    'Documents/Projects/About.rtf': 'A demonstration file.\n',
    'Documents/Projects/Roadmap.md': '# Roadmap\n\n- [x] Uploads\n- [ ] Preview\n',
    'Documents/About.xml': '<?xml version="1.0"?>\n<about>demo</about>\n',
    'Documents/ToDo.txt': 'Check all eight toolbar buttons.\n',
    'Documents/System/Employees.txt': 'Ivanenko\nPetrenko\n',
    'Images/notes.txt': 'Images can be uploaded here with the Upload button.\n',
    'Downloads/archive.txt': 'An empty placeholder.\n',
  };
  for (const [relative, content] of Object.entries(layout)) {
    const absolute = path.join(root, relative);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content, 'utf8');
  }
  await fs.mkdir(path.join(root, 'Documents', 'System', 'Employees'), { recursive: true });
  console.log(`Created a demonstration tree in ${root}`);
}

const app = express();

await seed(storageRoot);

app.use(
  '/api/files',
  createFileManagerRouter({
    root: storageRoot,
    readOnly,
    permissions: { chmod: allowChmod },
    maxUploadSize: 200 * 1024 * 1024,
    onWarning: (message, detail) => console.warn('[bookmark-file-manager]', message, detail),
  })
);

if (useVite) {
  const { createServer } = await import('vite');
  // Same root and publicDir as the `--mode demo` build, so dev and the built
  // demo resolve index.html and the icon artwork identically.
  const vite = await createServer({
    root: path.join(projectRoot, 'demo'),
    publicDir: path.join(projectRoot, 'assets'),
    server: { middlewareMode: true },
    appType: 'spa',
    configFile: false,
  });
  app.use(vite.middlewares);
} else {
  const demoDir = path.join(projectRoot, 'demo-dist');
  const hasBuild = await fs
    .access(path.join(demoDir, 'index.html'))
    .then(() => true)
    .catch(() => false);
  if (!hasBuild) {
    console.warn('demo-dist/ is not built — run `npm run build:demo`, or start with --vite');
  }
  app.use(express.static(demoDir));
  app.get('*', (_req, res) => res.sendFile(path.join(demoDir, 'index.html')));
}

app.listen(port, host, () => {
  console.log(`bookmark-file-manager: http://${host}:${port}`);
  console.log(`  root      : ${storageRoot}`);
  console.log(`  mode      : ${readOnly ? 'read-only' : 'read-write'}`);
  console.log(`  chmod     : ${allowChmod ? 'allowed (--chmod)' : 'refused'}`);
  if (host !== '127.0.0.1' && host !== 'localhost') {
    console.warn('  WARNING   : this server has no authentication and is reachable on the network');
  }
});
