/**
 * Host-supplied colours, fonts and metrics.
 *
 * The stylesheet is already written entirely in custom properties, so a theme
 * is nothing more than a set of those properties applied to one widget. What
 * makes this more than a call to `style.setProperty` is the light/dark split:
 * an inline style wins over every rule in the stylesheet, so setting a colour
 * inline would freeze it and the dark theme could never take effect. Instead a
 * small scoped stylesheet is emitted, mirroring the same three cases the
 * built-in stylesheet uses — system-dark, forced dark, forced light.
 *
 * Passing nothing emits nothing, and the widget keeps the built-in palette.
 */

/** Metrics and fonts. One value each — these do not change with the scheme. */
export const METRIC_PROPERTIES = {
  font: '--fsfm-font',
  fontSize: '--fsfm-font-size',
  codeFont: '--fsfm-code-font',
  codeSize: '--fsfm-code-size',
  codeLineHeight: '--fsfm-code-line',
  radius: '--fsfm-radius',
  radiusLarge: '--fsfm-radius-lg',
  sidebarWidth: '--fsfm-sidebar-width',
  tileWidth: '--fsfm-tile-width',
  rowHeight: '--fsfm-row-height',
};

/** Colours. Each may be given once for both schemes, or per scheme. */
export const COLOR_PROPERTIES = {
  bg: '--fsfm-bg',
  bgSubtle: '--fsfm-bg-subtle',
  bgSunken: '--fsfm-bg-sunken',
  border: '--fsfm-border',
  borderStrong: '--fsfm-border-strong',
  text: '--fsfm-text',
  textMuted: '--fsfm-text-muted',
  textInverse: '--fsfm-text-inverse',
  accent: '--fsfm-accent',
  accentHover: '--fsfm-accent-hover',
  accentSoft: '--fsfm-accent-soft',
  accentContrast: '--fsfm-accent-contrast',
  danger: '--fsfm-danger',
  dangerHover: '--fsfm-danger-hover',
  success: '--fsfm-success',
  warning: '--fsfm-warning',
  terminalBg: '--fsfm-term-bg',
  shadow: '--fsfm-shadow',
  shadowLarge: '--fsfm-shadow-lg',
};

/** Syntax highlighting, under `tokens`. Also colours, also per scheme. */
export const TOKEN_PROPERTIES = {
  comment: '--fsfm-tok-comment',
  string: '--fsfm-tok-string',
  number: '--fsfm-tok-number',
  keyword: '--fsfm-tok-keyword',
  type: '--fsfm-tok-type',
  builtin: '--fsfm-tok-builtin',
  tag: '--fsfm-tok-tag',
  attr: '--fsfm-tok-attr',
  property: '--fsfm-tok-property',
  variable: '--fsfm-tok-variable',
  operator: '--fsfm-tok-operator',
  punctuation: '--fsfm-tok-punctuation',
  heading: '--fsfm-tok-heading',
  link: '--fsfm-tok-link',
  meta: '--fsfm-tok-meta',
};

/**
 * Characters that would end the declaration and start something else.
 *
 * These values are written into a stylesheet, so a value carrying `;` or `}`
 * could close the rule and open one of its own — and a host may well be
 * passing colours that came from its own users. Rejecting is deliberate: a
 * silently dropped brace would leave a theme that half works.
 */
const FORBIDDEN = /[;{}<>\\]|\*\/|url\s*\(|expression\s*\(|@import/i;
const MAX_VALUE_LENGTH = 200;

/**
 * @param {string} name for the error message
 * @param {unknown} value
 * @returns {string|null} the value to write, or null to skip it
 */
function cleanValue(name, value) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (text === '') return null;
  if (text.length > MAX_VALUE_LENGTH) {
    throw new Error(`FileManager: theme value "${name}" is too long`);
  }
  if (FORBIDDEN.test(text)) {
    throw new Error(`FileManager: theme value "${name}" contains characters that are not allowed`);
  }
  return text;
}

/**
 * Turn one group of host values into declarations.
 *
 * A key that is not in `map` but looks like a custom property (`--my-var`) is
 * passed through, so a host can reach a variable this list has not caught up
 * with. Anything else is an error rather than a no-op: a typo that silently
 * does nothing is the kind of thing someone spends an afternoon on.
 */
function declarations(values, map, where) {
  if (!values) return [];
  const out = [];
  for (const [key, raw] of Object.entries(values)) {
    const property = map[key] ?? (key.startsWith('--') ? key : null);
    if (!property) {
      throw new Error(
        `FileManager: unknown theme key "${key}" in ${where}. ` +
          `Known: ${Object.keys(map).join(', ')}`
      );
    }
    const value = cleanValue(key, raw);
    if (value !== null) out.push(`  ${property}: ${value};`);
  }
  return out;
}

/** Colours plus the nested `tokens` group, as one list of declarations. */
function colourDeclarations(group, where) {
  if (!group) return [];
  const { tokens, ...colours } = group;
  return [
    ...declarations(colours, COLOR_PROPERTIES, where),
    ...declarations(tokens, TOKEN_PROPERTIES, `${where}.tokens`),
  ];
}

/**
 * Build the stylesheet for one widget.
 *
 * @param {string} scope an attribute selector unique to this instance
 * @param {object|null} theme the host's `theme` option
 * @returns {string} CSS, or '' when the host asked for nothing
 */
export function buildThemeCss(scope, theme) {
  if (!theme || typeof theme !== 'object') return '';

  const { colors, light, dark, tokens, ...metrics } = theme;

  const metricLines = declarations(metrics, METRIC_PROPERTIES, 'theme');
  // `colors` and a top-level `tokens` apply to both schemes; `light` and `dark`
  // narrow them.
  const sharedLines = colourDeclarations({ ...colors, tokens }, 'theme.colors');
  const lightLines = colourDeclarations(light, 'theme.light');
  const darkLines = colourDeclarations(dark, 'theme.dark');

  /**
   * Later wins, and only once.
   *
   * A scheme-specific colour is meant to replace the shared one, not sit
   * after a dead declaration of it.
   */
  const merge = (...lists) => {
    const byProperty = new Map();
    for (const line of lists.flat()) {
      byProperty.set(line.slice(0, line.indexOf(':')), line);
    }
    return [...byProperty.values()];
  };

  const rules = [];
  const rule = (selector, lines) => {
    if (lines.length) rules.push(`${selector} {\n${lines.join('\n')}\n}`);
  };

  const scheme = (query, selector, lines) => {
    if (!lines.length) return;
    const indented = lines.map((line) => `  ${line}`).join('\n');
    rules.push(
      `@media (prefers-color-scheme: ${query}) {\n  .fsfm${scope}${selector} {\n${indented}\n  }\n}`
    );
  };

  // Metrics and the colours that apply to both schemes. `light` deliberately
  // does *not* go here: sitting in the base rule it would out-rank the
  // built-in dark theme by source order, and a host that themed only the light
  // scheme would get a white background at night — which is exactly what it
  // did before this was split out.
  rule(`.fsfm${scope}`, merge(metricLines, sharedLines));

  // Each scheme repeats the shared colours, so it never matters whether the
  // built-in rule for that scheme comes before or after this stylesheet.
  const darkAll = merge(sharedLines, darkLines);
  const lightAll = merge(sharedLines, lightLines);

  scheme('dark', ':not(.fsfm-light)', darkAll);
  rule(`.fsfm${scope}.fsfm-dark`, darkAll);

  scheme('light', ':not(.fsfm-dark)', lightAll);
  rule(`.fsfm${scope}.fsfm-light`, lightAll);

  return rules.join('\n\n');
}
