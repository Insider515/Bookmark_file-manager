import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  COLOR_PROPERTIES,
  METRIC_PROPERTIES,
  TOKEN_PROPERTIES,
  buildThemeCss,
} from '../src/core/theme.js';

const SCOPE = '[data-fsfm-theme="1"]';
const css = (theme) => buildThemeCss(SCOPE, theme);

/**
 * The declarations inside the first rule whose selector contains `needle`.
 *
 * The selector is compared after trimming, so `base()` can ask for the plain
 * scoped rule without also matching `.fsfm[scope].fsfm-light`.
 */
function block(text, needle) {
  const rules = text.split(/\n\n/);
  const found = rules.find((rule) => rule.split('{')[0].includes(needle));
  return found ?? '';
}

/** Only the unscoped base rule, `.fsfm[scope] { … }`. */
function base(text) {
  const rules = text.split(/\n\n/);
  const found = rules.find((rule) => rule.split('{')[0].trim() === `.fsfm${SCOPE}`);
  return found ?? '';
}

describe('theme: nothing in, nothing out', () => {
  test('no theme emits no stylesheet at all', () => {
    for (const value of [null, undefined, false, 0, '', {}]) {
      assert.equal(css(value), '', `${JSON.stringify(value)} should emit nothing`);
    }
  });

  test('a key whose value is empty is skipped rather than written blank', () => {
    assert.equal(css({ fontSize: null, font: undefined, radius: '' }), '');
  });
});

describe('theme: metrics and fonts', () => {
  test('each metric reaches its custom property', () => {
    const text = css({
      font: 'Inter, sans-serif',
      fontSize: '15px',
      codeFont: 'Menlo, monospace',
      codeSize: '12px',
      codeLineHeight: '18px',
      radius: '2px',
      radiusLarge: '4px',
      sidebarWidth: '300px',
      tileWidth: '140px',
      rowHeight: '44px',
    });
    for (const property of Object.values(METRIC_PROPERTIES)) {
      assert.ok(text.includes(`${property}:`), `${property} is missing`);
    }
  });

  test('metrics land in the base rule, not in a scheme', () => {
    const text = css({ fontSize: '15px' });
    assert.match(base(text), /--fsfm-font-size: 15px;/);
    assert.ok(!text.includes('prefers-color-scheme'), 'a metric is not scheme-specific');
  });
});

describe('theme: colours', () => {
  test('`colors` applies to both schemes', () => {
    const text = css({ colors: { accent: '#7c3aed' } });
    assert.match(block(text, 'prefers-color-scheme: dark'), /--fsfm-accent: #7c3aed;/);
    assert.match(block(text, 'prefers-color-scheme: light'), /--fsfm-accent: #7c3aed;/);
    assert.match(block(text, '.fsfm-dark'), /--fsfm-accent: #7c3aed;/);
    assert.match(block(text, '.fsfm-light'), /--fsfm-accent: #7c3aed;/);
  });

  test('a scheme-specific colour replaces the shared one, once', () => {
    const text = css({ colors: { accent: '#111111' }, dark: { accent: '#eeeeee' } });
    const dark = block(text, '.fsfm-dark');
    assert.match(dark, /--fsfm-accent: #eeeeee;/);
    assert.ok(!dark.includes('#111111'), 'the shared value should not linger in the dark rule');
    assert.match(block(text, '.fsfm-light'), /--fsfm-accent: #111111;/);
  });

  test('a light-only palette never reaches the dark scheme', () => {
    // The regression this guards: `light` used to be written into the base
    // rule, where it out-ranked the built-in dark theme by source order — a
    // host that themed only the light scheme got a white background at night.
    const text = css({ light: { bg: '#fffdf7', text: '#2b2415' } });
    assert.ok(!base(text).includes('--fsfm-bg'), 'a light colour must not sit in the base rule');
    assert.ok(
      !block(text, 'prefers-color-scheme: dark').includes('--fsfm-bg'),
      'a light colour must not appear in the dark rule'
    );
    assert.match(block(text, 'prefers-color-scheme: light'), /--fsfm-bg: #fffdf7;/);
    assert.match(block(text, '.fsfm-light'), /--fsfm-bg: #fffdf7;/);
  });

  test('the forced-theme rules outrank the built-in ones', () => {
    const text = css({ dark: { bg: '#000000' } });
    // `.fsfm[attr].fsfm-dark` is one class more specific than `.fsfm.fsfm-dark`.
    assert.ok(text.includes(`.fsfm${SCOPE}.fsfm-dark {`));
    assert.ok(text.includes(`.fsfm${SCOPE}:not(.fsfm-light) {`));
  });

  test('every documented colour key is accepted', () => {
    const all = Object.fromEntries(Object.keys(COLOR_PROPERTIES).map((key) => [key, '#123456']));
    const text = css({ colors: all });
    for (const property of Object.values(COLOR_PROPERTIES)) {
      assert.ok(text.includes(`${property}:`), `${property} is missing`);
    }
  });

  test('syntax tokens are their own group and can differ per scheme', () => {
    const all = Object.fromEntries(Object.keys(TOKEN_PROPERTIES).map((key) => [key, '#abcdef']));
    const text = css({ tokens: all, dark: { tokens: { string: '#9ece6a' } } });
    for (const property of Object.values(TOKEN_PROPERTIES)) {
      assert.ok(text.includes(`${property}:`), `${property} is missing`);
    }
    assert.match(block(text, '.fsfm-dark'), /--fsfm-tok-string: #9ece6a;/);
  });
});

describe('theme: a typo is an error, not a no-op', () => {
  test('an unknown key names what it should have been', () => {
    assert.throws(() => css({ colors: { acent: '#fff' } }), /unknown theme key "acent"/);
    assert.throws(() => css({ fontsize: '15px' }), /unknown theme key "fontsize"/);
    assert.throws(() => css({ dark: { backgroundColor: '#fff' } }), /theme\.dark/);
    assert.throws(() => css({ tokens: { srting: '#fff' } }), /theme\.colors\.tokens/);
  });

  test('a raw custom property is passed through for anything not listed', () => {
    const text = css({ '--fsfm-something-new': '4px', colors: { '--fsfm-other': 'red' } });
    assert.match(text, /--fsfm-something-new: 4px;/);
    assert.match(text, /--fsfm-other: red;/);
  });
});

describe('theme: a value cannot break out of its declaration', () => {
  const attacks = [
    '#fff; } body { display: none',
    'red } .fsfm { --fsfm-bg: black',
    'url(https://example.com/track.png)',
    'red; background: url("x")',
    'expression(alert(1))',
    '#fff /* } */',
    'red<style>',
    'red\\3c script',
  ];

  test('anything that could close the rule is refused', () => {
    for (const value of attacks) {
      assert.throws(
        () => css({ colors: { accent: value } }),
        /not allowed/,
        `should have refused: ${value}`
      );
    }
  });

  test('an absurdly long value is refused', () => {
    assert.throws(() => css({ colors: { accent: 'a'.repeat(500) } }), /too long/);
  });

  test('the values a real theme uses all pass', () => {
    const text = css({
      font: "'Segoe UI', -apple-system, BlinkMacSystemFont, sans-serif",
      fontSize: '0.9375rem',
      radius: 'calc(2px + 0.1em)',
      colors: {
        accent: 'rgb(124 58 237 / 90%)',
        bg: 'hsl(210, 20%, 98%)',
        shadow: '0 1px 2px rgba(0, 0, 0, 0.06)',
        text: 'var(--brand-text, #111)',
      },
    });
    assert.match(text, /--fsfm-accent: rgb\(124 58 237 \/ 90%\);/);
    assert.match(text, /--fsfm-shadow: 0 1px 2px rgba\(0, 0, 0, 0\.06\);/);
    assert.match(text, /--fsfm-text: var\(--brand-text, #111\);/);
  });
});
