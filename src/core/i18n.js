/**
 * Translation for everything the widget puts on screen.
 *
 * Three decisions worth stating, because they are what make this usable by a
 * host that speaks a language nobody here anticipated:
 *
 *   1. English is the base and the fallback. A key missing from a translation
 *      falls back to English rather than showing the key or an empty string —
 *      a half-translated build stays usable instead of turning into `nav.up`.
 *   2. Plurals are per-language rules, not a "1 vs many" guess. Ukrainian needs
 *      three forms and picks them by the last digits, not by the value; getting
 *      that wrong is how "5 файла" happens.
 *   3. A host can pass its own dictionary object instead of a language id. The
 *      five shipped languages are a convenience, not a limit.
 */

/**
 * Which plural form a count takes.
 *
 * The Slavic rule is genuinely different in kind from the Germanic/Romance one
 * — 2 and 22 behave alike, 12 does not — so it is written out rather than
 * approximated.
 */
export const PLURAL_RULES = {
  /** English, Spanish, German, French: one, other. */
  default: (n) => (n === 1 ? 'one' : 'other'),
  /** Ukrainian: one, few, many. */
  slavic: (n) => {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return 'one';
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'few';
    return 'many';
  },
};

/** `{name}` in a string is replaced by `params.name`. */
function interpolate(text, params) {
  if (!params) return text;
  return String(text).replace(/\{(\w+)\}/g, (whole, key) =>
    params[key] === undefined ? whole : String(params[key])
  );
}

/**
 * Build a lookup over one dictionary, with English underneath it.
 *
 * @param {object} dictionary the active language
 * @param {object} fallback used for anything the active one is missing
 * @returns {(key: string, params?: object) => string}
 */
export function createTranslator(dictionary, fallback) {
  const strings = dictionary?.strings ?? {};
  const spare = fallback?.strings ?? {};
  const plural = dictionary?.plural ?? PLURAL_RULES.default;

  return function translate(key, params) {
    let value = strings[key];
    let rule = plural;
    if (value === undefined) {
      value = spare[key];
      // The fallback text is English, so it must be counted the English way:
      // reusing the active language's rule would ask for a form English does
      // not have and produce nothing.
      rule = fallback?.plural ?? PLURAL_RULES.default;
    }
    // An unknown key returns itself. It is ugly on purpose: silently empty
    // text is a bug that ships, and a visible `nav.up` is one that gets fixed.
    if (value === undefined) return key;

    if (typeof value === 'object') {
      const count = Number(params?.n ?? params?.count ?? 0);
      value = value[rule(count)] ?? value.other ?? value.one ?? '';
    }
    return interpolate(value, params);
  };
}

/**
 * Turn whatever a host passed as `locale` into a dictionary.
 *
 * Accepts a shipped language id (`'en'`, `'uk'`, `'es'`, `'de'`, `'fr'`), a
 * full BCP-47 tag whose base matches one of them (`'de-AT'` → German), or a
 * dictionary object of the host's own. Anything unrecognised falls back to
 * English rather than throwing: a typo in a config value should not take the
 * file manager down.
 *
 * @param {string|object|undefined} locale
 * @param {Record<string, object>} available the shipped languages, by id
 * @param {object} fallback English
 */
export function resolveLocale(locale, available, fallback) {
  if (!locale) return fallback;

  if (typeof locale === 'object') {
    // A host dictionary need not be complete — anything it omits comes from
    // English underneath, so a host can translate ten strings and leave the
    // rest, and still get a working widget.
    return {
      id: locale.id ?? 'custom',
      name: locale.name ?? locale.id ?? 'custom',
      tag: locale.tag ?? locale.id ?? undefined,
      plural: locale.plural ?? PLURAL_RULES.default,
      strings: locale.strings ?? locale,
    };
  }

  const wanted = String(locale).toLowerCase();
  // 'de-AT' and 'de' should both find German.
  const base = wanted.split(/[-_]/)[0];
  return available[wanted] ?? available[base] ?? fallback;
}
