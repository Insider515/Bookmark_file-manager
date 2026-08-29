import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { PLURAL_RULES, createTranslator, resolveLocale } from '../src/core/i18n.js';
import { DEFAULT_LOCALE, LOCALES } from '../src/locales/index.js';
import { formatBytes, formatDate } from '../src/core/format.js';

const IDS = Object.keys(LOCALES);
const EN = LOCALES.en.strings;

describe('locales: the five stay in step', () => {
  test('every language has exactly the English key set', () => {
    for (const id of IDS) {
      const keys = Object.keys(LOCALES[id].strings);
      const missing = Object.keys(EN).filter((key) => !(key in LOCALES[id].strings));
      const extra = keys.filter((key) => !(key in EN));
      assert.deepEqual(missing, [], `${id} is missing keys`);
      assert.deepEqual(extra, [], `${id} has keys English does not`);
    }
  });

  test('a key that is a plural set in English is one everywhere', () => {
    for (const [key, value] of Object.entries(EN)) {
      const plural = typeof value === 'object';
      for (const id of IDS) {
        assert.equal(
          typeof LOCALES[id].strings[key] === 'object',
          plural,
          `${id}.${key} disagrees with English about being a plural set`
        );
      }
    }
  });

  test('a translation uses only the placeholders English uses', () => {
    const namesIn = (value) =>
      new Set(
        Object.values(typeof value === 'object' ? value : { one: value })
          .flatMap((text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((m) => m[1]))
      );
    for (const [key, english] of Object.entries(EN)) {
      const allowed = namesIn(english);
      for (const id of IDS) {
        for (const name of namesIn(LOCALES[id].strings[key])) {
          // A placeholder English does not have is never substituted, so it
          // would reach the user as a literal `{whatever}`.
          assert.ok(allowed.has(name), `${id}.${key} uses {${name}}, which English does not`);
        }
      }
    }
  });

  test('each declares an id, a name and a BCP-47 tag', () => {
    for (const id of IDS) {
      const locale = LOCALES[id];
      assert.equal(locale.id, id);
      assert.ok(locale.name, `${id} has no display name`);
      // Constructing with the tag proves it is one Intl accepts.
      assert.doesNotThrow(() => new Intl.DateTimeFormat(locale.tag));
    }
  });

  test('no language leaves a string empty', () => {
    for (const id of IDS) {
      for (const [key, value] of Object.entries(LOCALES[id].strings)) {
        const forms = typeof value === 'object' ? Object.values(value) : [value];
        for (const form of forms) {
          assert.ok(String(form).length > 0, `${id}.${key} is empty`);
        }
      }
    }
  });
});

describe('plural rules', () => {
  test('English and the Romance/Germanic languages split at one', () => {
    assert.equal(PLURAL_RULES.default(1), 'one');
    for (const n of [0, 2, 5, 11, 21, 100]) {
      assert.equal(PLURAL_RULES.default(n), 'other', `${n}`);
    }
  });

  test('the Slavic rule picks by the last digits, not by the value', () => {
    const slavic = PLURAL_RULES.slavic;
    for (const n of [1, 21, 101, 131]) assert.equal(slavic(n), 'one', `${n}`);
    for (const n of [2, 3, 4, 22, 34, 104]) assert.equal(slavic(n), 'few', `${n}`);
    // The teens are the case a naive "ends in 1/2-4" rule gets wrong.
    for (const n of [0, 5, 11, 12, 13, 14, 19, 25, 111]) assert.equal(slavic(n), 'many', `${n}`);
  });

  test('Ukrainian counts through all three forms', () => {
    const t = createTranslator(LOCALES.uk, LOCALES.en);
    assert.equal(t('count.files', { n: 1 }), '1 файл');
    assert.equal(t('count.files', { n: 3 }), '3 файли');
    assert.equal(t('count.files', { n: 5 }), '5 файлів');
    assert.equal(t('count.files', { n: 12 }), '12 файлів');
    assert.equal(t('count.files', { n: 22 }), '22 файли');
  });
});

describe('translator', () => {
  test('substitutes named placeholders', () => {
    const t = createTranslator(LOCALES.en, LOCALES.en);
    assert.equal(t('toast.folderCreated', { name: 'Reports' }), 'Folder “Reports” created');
  });

  test('leaves a placeholder alone when nothing was given for it', () => {
    const t = createTranslator(LOCALES.en, LOCALES.en);
    assert.equal(t('toast.folderCreated', {}), 'Folder “{name}” created');
  });

  test('an unknown key comes back as itself rather than as blank text', () => {
    const t = createTranslator(LOCALES.en, LOCALES.en);
    assert.equal(t('no.such.key'), 'no.such.key');
  });

  test('a partial dictionary falls back to English for what it omits', () => {
    const t = createTranslator(
      { plural: PLURAL_RULES.default, strings: { 'common.save': 'Spara' } },
      LOCALES.en
    );
    assert.equal(t('common.save'), 'Spara');
    assert.equal(t('common.cancel'), 'Cancel');
  });

  test('a fallback plural is counted the English way, not the active one', () => {
    // A Slavic dictionary that omits `count.files` must still get English's
    // two forms; asking it for `few` would find nothing.
    const t = createTranslator({ plural: PLURAL_RULES.slavic, strings: {} }, LOCALES.en);
    assert.equal(t('count.files', { n: 3 }), '3 files');
    assert.equal(t('count.files', { n: 1 }), '1 file');
  });
});

describe('resolveLocale', () => {
  test('nothing means English', () => {
    assert.equal(resolveLocale(undefined, LOCALES, DEFAULT_LOCALE).id, 'en');
    assert.equal(resolveLocale(null, LOCALES, DEFAULT_LOCALE).id, 'en');
    assert.equal(resolveLocale('', LOCALES, DEFAULT_LOCALE).id, 'en');
  });

  test('a shipped id selects that language', () => {
    for (const id of IDS) {
      assert.equal(resolveLocale(id, LOCALES, DEFAULT_LOCALE).id, id);
    }
  });

  test('a regional tag falls back to its base language', () => {
    assert.equal(resolveLocale('de-AT', LOCALES, DEFAULT_LOCALE).id, 'de');
    assert.equal(resolveLocale('fr_CA', LOCALES, DEFAULT_LOCALE).id, 'fr');
    assert.equal(resolveLocale('ES', LOCALES, DEFAULT_LOCALE).id, 'es');
  });

  test('an unknown language is English, not a crash', () => {
    assert.equal(resolveLocale('kl', LOCALES, DEFAULT_LOCALE).id, 'en');
    assert.equal(resolveLocale('not a language!!', LOCALES, DEFAULT_LOCALE).id, 'en');
  });

  test('a host dictionary is taken as given, with English underneath', () => {
    const custom = { id: 'sv', name: 'Svenska', tag: 'sv', strings: { 'common.save': 'Spara' } };
    const resolved = resolveLocale(custom, LOCALES, DEFAULT_LOCALE);
    const t = createTranslator(resolved, DEFAULT_LOCALE);
    assert.equal(resolved.id, 'sv');
    assert.equal(t('common.save'), 'Spara');
    assert.equal(t('common.delete'), 'Delete');
  });

  test('a bare map of strings works as a dictionary too', () => {
    const resolved = resolveLocale({ 'common.save': 'Spara' }, LOCALES, DEFAULT_LOCALE);
    assert.equal(createTranslator(resolved, DEFAULT_LOCALE)('common.save'), 'Spara');
  });
});

describe('sizes and dates follow the language', () => {
  test('byte units are translated, and English is the default', () => {
    const fr = createTranslator(LOCALES.fr, LOCALES.en);
    assert.equal(formatBytes(1536), '1.5 KB');
    assert.equal(formatBytes(1536, fr), '1.5 Ko');
    assert.equal(formatBytes(500), '500 B');
  });

  test('a date is formatted for the tag it is given', () => {
    const stamp = '2026-03-04T09:05:00Z';
    const de = formatDate(stamp, 'de-DE');
    const us = formatDate(stamp, 'en-US');
    assert.notEqual(de, us);
    assert.match(de, /04\.03\.2026/);
  });

  test('a malformed tag falls back instead of throwing', () => {
    assert.doesNotThrow(() => formatDate('2026-03-04T09:05:00Z', 'not a tag!!'));
    assert.ok(formatDate('2026-03-04T09:05:00Z', 'not a tag!!').length > 0);
  });
});

describe('server error codes', () => {
  test('every language answers the codes the server can send', () => {
    const codes = Object.keys(EN).filter((key) => key.startsWith('srv.'));
    assert.ok(codes.length > 30, 'the mapped set should not have shrunk by accident');
    for (const id of IDS) {
      for (const code of codes) {
        assert.ok(LOCALES[id].strings[code], `${id} has no text for ${code}`);
      }
    }
  });

  test('every permission the server names has a word in each language', () => {
    const permissions = [
      'archive', 'chmod', 'create', 'edit', 'extract',
      'upload', 'move', 'copy', 'rename', 'remove', 'download',
    ];
    for (const id of IDS) {
      for (const permission of permissions) {
        assert.ok(LOCALES[id].strings[`op.${permission}`], `${id} has no word for ${permission}`);
      }
    }
  });
});
