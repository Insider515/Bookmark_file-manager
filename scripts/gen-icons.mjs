import { readFileSync, writeFileSync } from 'node:fs';

const NAMES = [
  'folder-plus', 'file-earmark-plus', 'arrow-left-right', 'clipboard-check',
  'pencil-square', 'trash-fill', 'file-earmark-arrow-down', 'file-earmark-arrow-up',
  'caret-right-fill', 'caret-down-fill', 'folder', 'folder2-open',
  // 'clipboard-check' already reads as "copy these files"; copying a path
  // needs a plain clipboard so the two actions stay distinguishable.
  'clipboard',
  'arrow-up', 'arrow-clockwise', 'x-lg', 'check-lg', 'house-fill',
  // Recursive search is a separate action from the in-folder filter box,
  // so it needs a control of its own rather than sharing that input.
  'search',
  // The terminal panel's show/hide control.
  'terminal',
  // Used by the demo page's controls, which sit in the widget's own toolbar
  // and so need to look like the buttons already there.
  // Outline rather than 'house-fill', so the row of demo controls has one
  // weight; the filled one is unused.
  'layout-sidebar', 'moon', 'sun', 'palette', 'menu-button-wide', 'house',
  // The rest of the context menu, mirrored onto the toolbar for touch devices
  // that have no right-click.
  'eye', 'file-earmark-spreadsheet', 'file-earmark-text', 'file-earmark-zip',
  'box-arrow-down', 'list-ul', 'shield-lock', 'lightning', 'info-circle', 'check-all',
];

const out = [];
for (const name of NAMES) {
  const raw = readFileSync(`node_modules/bootstrap-icons/icons/${name}.svg`, 'utf8');
  const inner = raw
    .replace(/^[\s\S]*?<svg[^>]*>/, '')
    .replace(/<\/svg>\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  const key = name.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
  out.push(`  ${key}: '${inner.replace(/'/g, "\\'")}',`);
}

const file = `// Generated from bootstrap-icons v${JSON.parse(readFileSync('node_modules/bootstrap-icons/package.json', 'utf8')).version} (MIT).
// Inlined so the widget carries no icon-font dependency. Regenerate with scripts/gen-icons.mjs.

const PATHS = {
${out.join('\n')}
};

/**
 * Render an inline SVG icon. Uses currentColor, so it inherits the host's text colour.
 * @param {string} name key from PATHS
 * @param {number} size px, applied to both width and height
 */
export function icon(name, size = 16) {
  const body = PATHS[name];
  if (!body) throw new Error(\`Unknown icon: \${name}\`);
  return \`<svg xmlns="http://www.w3.org/2000/svg" width="\${size}" height="\${size}" fill="currentColor" viewBox="0 0 16 16" aria-hidden="true" focusable="false">\${body}</svg>\`;
}

export const iconNames = Object.keys(PATHS);
`;

writeFileSync('src/ui/icons.js', file);
console.log('wrote src/ui/icons.js with', NAMES.length, 'icons');
