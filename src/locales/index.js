/**
 * The five languages that ship with the widget.
 *
 * All five are in the bundle so that `{ locale: 'de' }` just works, with no
 * second import and no async step. They are short string tables; a host that
 * needs a language not listed here passes its own dictionary object instead —
 * see `src/core/i18n.js`.
 */
import en from './en.js';
import uk from './uk.js';
import es from './es.js';
import de from './de.js';
import fr from './fr.js';

export { en, uk, es, de, fr };

/** Every shipped language, by id. */
export const LOCALES = { en, uk, es, de, fr };

/** The one used when a host says nothing. */
export const DEFAULT_LOCALE = en;
