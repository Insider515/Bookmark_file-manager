/**
 * Syntax highlighting by tokenisation, not by parsing.
 *
 * Each language is an ordered list of rules; the scanner walks the text once
 * and the first rule that matches at the cursor wins. That is enough to colour
 * code correctly for reading and editing, and it is honest about what it is:
 * there is no syntax tree here, so nothing depends on the file being valid.
 * Half-typed code — which is what an editor shows most of the time — still
 * highlights sensibly instead of collapsing.
 *
 * What that costs, stated plainly:
 *
 *  - Interpolation inside a template literal or an f-string is coloured as
 *    part of the string, not as the expression it contains.
 *  - `/` as regex-versus-division is decided by a heuristic (see JS_REGEX).
 *  - HTML does not switch languages inside <script> or <style>.
 *
 * None of those changes what the file *is*, only how it looks.
 */

/** Token classes. Kept small on purpose: more colours is not more legible. */
export const TOKEN_TYPES = [
  'comment',
  'string',
  'number',
  'keyword',
  'type',
  'builtin',
  'tag',
  'attr',
  'property',
  'variable',
  'operator',
  'punctuation',
  'heading',
  'link',
  'meta',
];

const escapeHtml = (text) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Build a sticky regex, so matching happens at the cursor and nowhere else. */
const rule = (type, source, flags = '') => ({
  type,
  pattern: new RegExp(source, `y${flags}`),
});

// ---------------------------------------------------------------- keywords

const JS_KEYWORDS =
  'break|case|catch|class|const|continue|debugger|default|delete|do|else|export|extends|' +
  'finally|for|function|if|import|in|instanceof|let|new|return|super|switch|this|throw|try|' +
  'typeof|var|void|while|with|yield|async|await|of|static|get|set|from|as';

const TS_KEYWORDS =
  'abstract|declare|enum|implements|infer|interface|is|keyof|namespace|never|override|' +
  'private|protected|public|readonly|satisfies|type|unique|unknown|asserts|out';

const JS_LITERALS = 'true|false|null|undefined|NaN|Infinity';

const TS_TYPES = 'string|number|boolean|object|symbol|bigint|any|void|unknown|never|this';

const PY_KEYWORDS =
  'and|as|assert|async|await|break|class|continue|def|del|elif|else|except|finally|for|' +
  'from|global|if|import|in|is|lambda|nonlocal|not|or|pass|raise|return|try|while|with|yield|match|case';

const SH_KEYWORDS =
  'if|then|else|elif|fi|case|esac|for|while|until|do|done|in|function|select|time|' +
  'return|break|continue|local|export|readonly|declare|typeset|unset|shift|source|alias';

const PHP_KEYWORDS =
  'abstract|and|array|as|break|callable|case|catch|class|clone|const|continue|declare|default|' +
  'do|echo|else|elseif|empty|enddeclare|endfor|endforeach|endif|endswitch|endwhile|enum|extends|' +
  'final|finally|fn|for|foreach|function|global|goto|if|implements|include|include_once|instanceof|' +
  'insteadof|interface|isset|list|match|namespace|new|or|print|private|protected|public|readonly|' +
  'require|require_once|return|static|switch|throw|trait|try|unset|use|var|while|xor|yield';

/**
 * Whether a `/` here begins a regular expression or is division.
 *
 * Undecidable without parsing; the rule every highlighter uses is that a regex
 * cannot follow something that produced a value. Looking back at the last
 * non-space character catches the overwhelming majority and errs towards
 * division, which is the less disruptive mistake — a wrong regex would swallow
 * the rest of the line.
 */
function startsRegex(text, index) {
  for (let i = index - 1; i >= 0; i -= 1) {
    const char = text[i];
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') continue;
    return !/[\w$)\]]/.test(char);
  }
  return true;
}

const C_COMMENTS = [
  rule('comment', '//[^\\n]*'),
  rule('comment', '/\\*[\\s\\S]*?(?:\\*/|$)'),
];

const C_STRINGS = [
  rule('string', "'(?:\\\\.|[^'\\\\\\n])*'?"),
  rule('string', '"(?:\\\\.|[^"\\\\\\n])*"?'),
  // Templates run across lines; interpolation is part of the string here.
  rule('string', '`(?:\\\\.|[^`\\\\])*`?'),
];

const NUMBER = rule(
  'number',
  '0[xX][0-9a-fA-F_]+n?|0[bB][01_]+n?|0[oO][0-7_]+n?|(?:\\d[\\d_]*)?\\.?\\d[\\d_]*(?:[eE][+-]?\\d+)?n?'
);

const javascript = (extra = '') => [
  ...C_COMMENTS,
  ...C_STRINGS,
  { type: 'string', pattern: /\/(?![/*])(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n])+\/[dgimsuvy]*/y, guard: startsRegex },
  rule('keyword', `\\b(?:${JS_KEYWORDS}${extra})\\b`),
  rule('builtin', `\\b(?:${JS_LITERALS})\\b`),
  NUMBER,
  rule('type', '\\b[A-Z][A-Za-z0-9_$]*\\b'),
  rule('variable', '[A-Za-z_$][\\w$]*(?=\\s*\\()'),
  rule('operator', '=>|\\?\\?=?|\\.{3}|[+\\-*/%=<>!&|^~?:]+'),
  rule('punctuation', '[{}()\\[\\];,.]'),
];

const typescript = () => {
  const rules = javascript(`|${TS_KEYWORDS}`);
  // Primitive type names only count where a type may appear, which a
  // tokeniser cannot know; colouring them everywhere is the honest compromise
  // and reads correctly in the annotations where they actually occur.
  rules.splice(5, 0, rule('type', `\\b(?:${TS_TYPES})\\b`));
  return rules;
};

const css = (nested = false) => [
  rule('comment', '/\\*[\\s\\S]*?(?:\\*/|$)'),
  ...(nested ? [rule('comment', '//[^\\n]*')] : []),
  rule('string', '"(?:\\\\.|[^"\\\\\\n])*"?'),
  rule('string', "'(?:\\\\.|[^'\\\\\\n])*'?"),
  rule('meta', '@[\\w-]+'),
  ...(nested ? [rule('variable', '[$@][\\w-]+')] : []),
  rule('number', '[+-]?(?:\\d*\\.)?\\d+(?:px|em|rem|ex|ch|vw|vh|vmin|vmax|%|s|ms|deg|fr|pt|cm|mm|in)?\\b'),
  rule('number', '#[0-9a-fA-F]{3,8}\\b'),
  rule('property', '[-\\w]+(?=\\s*:)'),
  rule('keyword', '\\b(?:important|from|to|and|not|only|or)\\b'),
  rule('tag', '[.#&][\\w-]+'),
  rule('builtin', '\\b[a-zA-Z-]+(?=\\()'),
  rule('operator', '[>+~*/=-]'),
  rule('punctuation', '[{}()\\[\\];,:]'),
];

const markup = [
  rule('comment', '<!--[\\s\\S]*?(?:-->|$)'),
  rule('meta', '<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>|$)'),
  rule('meta', '<[!?][^>]*>?'),
  rule('tag', '</?[A-Za-z_][\\w:.-]*'),
  rule('string', '"[^"]*"?'),
  rule('string', "'[^']*'?"),
  rule('attr', '[A-Za-z_@:][\\w:.-]*(?=\\s*=)'),
  rule('punctuation', '/?>'),
];

const LANGUAGES = {
  // The only label that is a word rather than a product name, so the only
  // one that gets translated — by the caller, which has the translator.
  txt: { label: 'code.plainText', rules: [] },

  js: { label: 'JavaScript', rules: javascript() },
  ts: { label: 'TypeScript', rules: typescript() },
  tsx: { label: 'TypeScript JSX', rules: typescript() },

  json: {
    label: 'JSON',
    rules: [
      rule('property', '"(?:\\\\.|[^"\\\\])*"(?=\\s*:)'),
      rule('string', '"(?:\\\\.|[^"\\\\])*"?'),
      rule('number', '-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?'),
      rule('builtin', '\\b(?:true|false|null)\\b'),
      rule('punctuation', '[{}\\[\\],:]'),
    ],
  },

  xml: { label: 'XML', rules: markup },
  html: { label: 'HTML', rules: markup },

  css: { label: 'CSS', rules: css() },
  scss: { label: 'SCSS', rules: css(true) },
  sass: { label: 'Sass', rules: css(true) },
  less: { label: 'Less', rules: css(true) },
  styl: { label: 'Stylus', rules: css(true) },

  md: {
    label: 'Markdown',
    rules: [
      rule('comment', '^ {0,3}(?:```|~~~)[^\\n]*[\\s\\S]*?(?:\\n {0,3}(?:```|~~~)|$)', 'm'),
      rule('heading', '^ {0,3}#{1,6}[^\\n]*', 'm'),
      rule('heading', '^ {0,3}(?:={3,}|-{3,})$', 'm'),
      rule('string', '`[^`\\n]*`'),
      rule('link', '!?\\[[^\\]\\n]*\\]\\([^)\\n]*\\)'),
      rule('link', '<https?://[^>\\s]+>'),
      rule('link', 'https?://[^\\s<>)\\]]+'),
      rule('keyword', '\\*\\*[^*\\n]+\\*\\*|__[^_\\n]+__'),
      rule('type', '\\*[^*\\n]+\\*|_[^_\\n]+_'),
      rule('meta', '^ {0,3}(?:[-*+]|\\d+\\.)\\s', 'm'),
      rule('meta', '^ {0,3}>[^\\n]*', 'm'),
    ],
  },

  yaml: {
    label: 'YAML',
    rules: [
      rule('comment', '#[^\\n]*'),
      rule('meta', '^---$|^\\.\\.\\.$', 'm'),
      rule('string', '"(?:\\\\.|[^"\\\\])*"?'),
      rule('string', "'(?:''|[^'])*'?"),
      rule('property', '^\\s*-?\\s*[\\w.$/-]+(?=\\s*:(?:\\s|$))', 'm'),
      rule('variable', '[&*][\\w-]+'),
      rule('builtin', '\\b(?:true|false|null|yes|no|on|off|~)\\b'),
      rule('number', '[+-]?(?:\\d[\\d_]*)?\\.?\\d[\\d_]*(?:[eE][+-]?\\d+)?\\b'),
      rule('punctuation', '[-:|>{}\\[\\],]'),
    ],
  },

  sh: {
    label: 'Shell',
    rules: [
      rule('meta', '^#![^\\n]*', 'm'),
      rule('comment', '#[^\\n]*'),
      rule('string', '"(?:\\\\.|[^"\\\\])*"?'),
      rule('string', "'[^']*'?"),
      rule('string', '<<-?\\s*(["\\\']?)(\\w+)\\1[\\s\\S]*?^\\t*\\2$', 'm'),
      rule('variable', '\\$\\{[^}]*\\}|\\$[\\w@*#?$!-]+'),
      rule('keyword', `\\b(?:${SH_KEYWORDS})\\b`),
      rule('builtin', '\\b(?:echo|cd|ls|rm|cp|mv|mkdir|grep|sed|awk|cat|test|printf|read|exit|set)\\b'),
      rule('number', '\\b\\d+\\b'),
      rule('operator', '&&|\\|\\||[|&;<>=!]+'),
      rule('punctuation', '[{}()\\[\\]]'),
    ],
  },

  py: {
    label: 'Python',
    rules: [
      rule('comment', '#[^\\n]*'),
      rule('string', '[rbfuRBFU]{0,3}"""[\\s\\S]*?(?:"""|$)'),
      rule('string', "[rbfuRBFU]{0,3}'''[\\s\\S]*?(?:'''|$)"),
      rule('string', '[rbfuRBFU]{0,3}"(?:\\\\.|[^"\\\\\\n])*"?'),
      rule('string', "[rbfuRBFU]{0,3}'(?:\\\\.|[^'\\\\\\n])*'?"),
      rule('meta', '@[\\w.]+'),
      rule('keyword', `\\b(?:${PY_KEYWORDS})\\b`),
      rule('builtin', '\\b(?:True|False|None|self|cls|print|len|range|int|str|float|list|dict|set|tuple|open|super|type|isinstance)\\b'),
      NUMBER,
      rule('type', '\\b[A-Z][A-Za-z0-9_]*\\b'),
      rule('variable', '[A-Za-z_]\\w*(?=\\s*\\()'),
      rule('operator', '[+\\-*/%=<>!&|^~:@]+'),
      rule('punctuation', '[{}()\\[\\];,.]'),
    ],
  },

  php: {
    label: 'PHP',
    rules: [
      rule('meta', '<\\?php|<\\?=|\\?>'),
      ...C_COMMENTS,
      rule('comment', '#[^\\n]*'),
      rule('string', '"(?:\\\\.|[^"\\\\])*"?'),
      rule('string', "'(?:\\\\.|[^'\\\\])*'?"),
      rule('variable', '\\$[A-Za-z_]\\w*'),
      rule('keyword', `\\b(?:${PHP_KEYWORDS})\\b`),
      rule('builtin', '\\b(?:true|false|null|TRUE|FALSE|NULL|__DIR__|__FILE__|__LINE__|__CLASS__)\\b'),
      NUMBER,
      rule('type', '\\b[A-Z][A-Za-z0-9_]*\\b'),
      rule('variable', '[A-Za-z_]\\w*(?=\\s*\\()'),
      rule('operator', '=>|->|::|\\?\\?|[+\\-*/%=<>!&|^~?:.]+'),
      rule('punctuation', '[{}()\\[\\];,]'),
    ],
  },
};

/**
 * extension -> language, longest spelling first.
 *
 * `d.ts` has to beat `ts` for the same reason `tar.gz` had to beat `gz`: both
 * end the same way, and matching the short one first labels every declaration
 * file as something it is not.
 */
const EXTENSIONS = [
  ['d.ts', 'ts'], ['d.mts', 'ts'], ['d.cts', 'ts'],
  ['mts', 'ts'], ['cts', 'ts'], ['tsx', 'tsx'], ['ts', 'ts'],
  ['mjs', 'js'], ['cjs', 'js'], ['jsx', 'js'], ['js', 'js'],
  ['json', 'json'], ['jsonc', 'json'],
  ['html', 'html'], ['htm', 'html'], ['xml', 'xml'], ['svg', 'xml'],
  ['scss', 'scss'], ['sass', 'sass'], ['less', 'less'], ['styl', 'styl'], ['css', 'css'],
  ['md', 'md'], ['markdown', 'md'],
  // `yml` is the same language under the commoner spelling; leaving it out
  // would mean most real config files fell through to plain text.
  ['yaml', 'yaml'], ['yml', 'yaml'],
  ['sh', 'sh'], ['bash', 'sh'], ['zsh', 'sh'],
  ['py', 'py'], ['php', 'php'],
  ['txt', 'txt'], ['log', 'txt'], ['csv', 'txt'], ['ini', 'txt'], ['conf', 'txt'], ['env', 'txt'],
].sort((a, b) => b[0].length - a[0].length);

/** The language id for a filename, or null when it is not a text file we know. */
export function languageOf(name) {
  const lower = String(name).toLowerCase();
  for (const [extension, id] of EXTENSIONS) {
    if (lower.endsWith(`.${extension}`)) return id;
  }
  // Dotfiles and extensionless scripts people edit constantly.
  const base = lower.slice(lower.lastIndexOf('/') + 1);
  if (base === 'makefile' || base === 'dockerfile') return 'txt';
  if (base.startsWith('.') && !base.slice(1).includes('.')) return 'txt';
  return null;
}

/**
 * Display name of a language.
 *
 * Returns `'code.plainText'` for plain text and for anything unrecognised;
 * that is a translation key, and the editor resolves it. Every other value is
 * a product name shown as-is.
 */
export function languageLabel(id) {
  return LANGUAGES[id]?.label ?? 'code.plainText';
}

export const LANGUAGE_IDS = Object.keys(LANGUAGES);

/** Every extension the editor claims, for the widget to match on. */
export const TEXT_EXTENSIONS = EXTENSIONS.map(([extension]) => extension);

/**
 * Highlight `text`, returning HTML with the source escaped.
 *
 * One pass, first rule wins. Anything no rule matched is emitted as plain
 * text, so unknown syntax degrades to "uncoloured" rather than to "missing".
 */
export function highlight(text, language) {
  const spec = LANGUAGES[language];
  const source = String(text);
  if (!spec || spec.rules.length === 0) return escapeHtml(source);

  const out = [];
  let plain = '';
  let index = 0;

  const flushPlain = () => {
    if (plain) {
      out.push(escapeHtml(plain));
      plain = '';
    }
  };

  while (index < source.length) {
    let matched = null;
    for (const item of spec.rules) {
      item.pattern.lastIndex = index;
      if (item.guard && !item.guard(source, index)) continue;
      const found = item.pattern.exec(source);
      // A zero-length match would spin forever; treat it as no match.
      if (found && found[0].length > 0) {
        matched = { type: item.type, text: found[0] };
        break;
      }
    }

    if (!matched) {
      plain += source[index];
      index += 1;
      continue;
    }

    flushPlain();
    out.push(`<span class="fsfm-tok-${matched.type}">${escapeHtml(matched.text)}</span>`);
    index += matched.text.length;
  }

  flushPlain();
  return out.join('');
}
