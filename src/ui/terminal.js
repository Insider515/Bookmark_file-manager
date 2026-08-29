import { el } from './dom.js';
import { COMMAND_NAMES, line, resolvePath, runCommand, tokenize } from '../core/terminal-commands.js';

/**
 * The terminal panel.
 *
 * This is the DOM half; the command language lives in core/terminal-commands.js
 * so it can be tested without a browser. What is here is the part that has to
 * feel like a terminal: a prompt that tracks where you are, history on the
 * arrows, completion on Tab, and output that scrolls.
 *
 * It replaces what used to be an event log, and keeps that job: operations
 * done with the mouse are echoed here too, so the panel still answers "what
 * just happened" as well as "do this".
 */

const MAX_LINES = 1000;
const MAX_HISTORY = 200;

export class Terminal {
  #lines = [];
  #history = [];
  #historyIndex = -1;
  #draft = '';
  #cwd = '/';
  #busy = false;
  #completion = null;

  /**
   * @param {object} config
   * @param {object} config.provider
   * @param {string} [config.path] starting folder
   * @param {(action: string) => boolean} [config.can] permission check
   * @param {(path: string) => Promise<unknown>} [config.onNavigate]
   * @param {() => Promise<unknown>} [config.onRefresh]
   * @param {(entry: object) => unknown} [config.onOpen]
   * @param {(paths: string[]) => unknown} [config.onDownload]
   */
  constructor({
    provider,
    path = '/',
    can,
    t,
    localeTag,
    errorText,
    onNavigate,
    onRefresh,
    onOpen,
    onDownload,
  }) {
    this.t = t ?? ((key) => key);
    this.localeTag = localeTag;
    this.errorText = errorText ?? ((err) => err?.message ?? '');
    this.provider = provider;
    this.#cwd = path;
    this.can = can ?? (() => true);
    this.onNavigate = onNavigate;
    this.onRefresh = onRefresh;
    this.onOpen = onOpen;
    this.onDownload = onDownload;

    this.output = el('div.fsfm-term-output', {
      role: 'log',
      'aria-live': 'polite',
      tabindex: '0',
    });

    this.prompt = el('span.fsfm-term-prompt', { text: `${this.#cwd} $` });
    this.input = el('input.fsfm-term-input', {
      type: 'text',
      spellcheck: false,
      autocomplete: 'off',
      autocapitalize: 'off',
      autocorrect: 'off',
      'aria-label': this.t('term.commandLabel'),
    });

    this.element = el('div.fsfm-term', {}, [
      this.output,
      el('div.fsfm-term-line', {}, [this.prompt, this.input]),
    ]);

    this.input.addEventListener('keydown', (event) => this.#onKeyDown(event));
    // Clicking anywhere in the panel puts the caret where typing goes, the way
    // clicking a terminal window does — but not while selecting text.
    this.element.addEventListener('mouseup', () => {
      if (!String(window.getSelection() ?? '')) this.input.focus();
    });

    this.print([
      line(this.t('term.intro'), 'muted'),
      line(this.t('term.introHelp'), 'muted'),
    ]);
  }

  get cwd() {
    return this.#cwd;
  }

  /** Point the prompt somewhere else, without running `cd`. */
  setPath(path) {
    if (path === this.#cwd) return;
    this.#cwd = path;
    this.prompt.textContent = `${path} $`;
  }

  focus() {
    this.input.focus();
  }

  clear() {
    this.#lines = [];
    this.output.replaceChildren();
  }

  /**
   * Append output.
   * @param {Array<{text: string, tone: string}>|{text: string, tone: string}} lines
   */
  print(lines) {
    const list = Array.isArray(lines) ? lines : [lines];
    if (list.length === 0) return;

    const fragment = document.createDocumentFragment();
    for (const item of list) {
      this.#lines.push(item);
      // Text nodes, never innerHTML: these lines carry file contents and
      // filenames, which are exactly the things a user can put markup into.
      fragment.append(el(`div.fsfm-term-row.is-${item.tone}`, { text: item.text || ' ' }));
    }
    this.output.append(fragment);

    // Trimming the model and the DOM together keeps a long session bounded.
    while (this.#lines.length > MAX_LINES) {
      this.#lines.shift();
      this.output.firstChild?.remove();
    }
    this.output.scrollTop = this.output.scrollHeight;
  }

  /** Echo something the widget did, so the panel keeps its old job. */
  note(text) {
    this.print(line(text, 'muted'));
  }

  /** How many characters fit across, for `ls` columns. */
  #width() {
    const probe = el('span', { text: '0'.repeat(10), style: { position: 'absolute', visibility: 'hidden' } });
    this.output.append(probe);
    const per = probe.getBoundingClientRect().width / 10;
    probe.remove();
    const available = this.output.clientWidth || 640;
    return per > 0 ? Math.max(20, Math.floor(available / per) - 1) : 80;
  }

  async run(input) {
    const text = String(input ?? '');
    this.print(line(`${this.#cwd} $ ${text}`, 'prompt'));

    if (text.trim()) {
      // Consecutive duplicates are noise when arrowing back through history.
      if (this.#history[this.#history.length - 1] !== text.trim()) {
        this.#history.push(text.trim());
        while (this.#history.length > MAX_HISTORY) this.#history.shift();
      }
    }
    this.#historyIndex = -1;
    this.#draft = '';

    this.#busy = true;
    this.element.classList.add('is-busy');
    try {
      const { lines } = await runCommand(text, {
        provider: this.provider,
        cwd: this.#cwd,
        width: this.#width(),
        t: this.t,
        errorText: this.errorText,
        localeTag: this.localeTag,
        maxOutputLines: 500,
        can: this.can,
        setCwd: async (path) => {
          this.setPath(path);
          await this.onNavigate?.(path);
        },
        refresh: async () => {
          await this.onRefresh?.();
        },
        open: async (entry) => {
          await this.onOpen?.(entry);
        },
        download: async (paths) => {
          await this.onDownload?.(paths);
        },
        clear: () => this.clear(),
      });
      this.print(lines);
    } finally {
      this.#busy = false;
      this.element.classList.remove('is-busy');
    }
  }

  /* ----------------------------------------------------------- keyboard */

  #onKeyDown(event) {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (this.#busy) return;
      const text = this.input.value;
      this.input.value = '';
      this.#completion = null;
      void this.run(text);
      return;
    }

    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      this.#walkHistory(event.key === 'ArrowUp' ? 1 : -1);
      return;
    }

    if (event.key === 'Tab') {
      event.preventDefault();
      void this.#complete(event.shiftKey ? -1 : 1);
      return;
    }

    if (event.key === 'l' && event.ctrlKey) {
      event.preventDefault();
      this.clear();
      return;
    }

    if (event.key === 'c' && event.ctrlKey && !window.getSelection()?.toString()) {
      // Nothing to interrupt — requests finish on their own — but abandoning
      // the half-typed line is what the reflex is for.
      event.preventDefault();
      this.print(line(`${this.#cwd} $ ${this.input.value}^C`, 'prompt'));
      this.input.value = '';
      this.#historyIndex = -1;
      return;
    }

    this.#completion = null;
  }

  #walkHistory(direction) {
    if (this.#history.length === 0) return;
    if (this.#historyIndex === -1 && direction === 1) this.#draft = this.input.value;

    const next = this.#historyIndex + direction;
    if (next < -1) return;
    if (next >= this.#history.length) return;

    this.#historyIndex = next;
    this.input.value = next === -1 ? this.#draft : this.#history[this.#history.length - 1 - next];
    // The caret belongs at the end, so a recalled line can be extended.
    const end = this.input.value.length;
    this.input.setSelectionRange(end, end);
  }

  /**
   * Complete the word under the caret: a command name in the first position,
   * otherwise a name from the folder the fragment points at.
   */
  async #complete(direction) {
    if (this.#completion) {
      const { matches, prefix, start } = this.#completion;
      this.#completion.index =
        (this.#completion.index + direction + matches.length) % matches.length;
      this.#apply(start, prefix, matches[this.#completion.index]);
      return;
    }

    const value = this.input.value;
    const upto = value.slice(0, this.input.selectionStart ?? value.length);
    const { tokens } = tokenize(upto);
    const trailingSpace = /\s$/.test(upto);
    const fragment = trailingSpace ? '' : (tokens[tokens.length - 1] ?? '');
    const first = tokens.length === 0 || (tokens.length === 1 && !trailingSpace);
    const start = upto.length - fragment.length;

    let matches;
    if (first) {
      matches = COMMAND_NAMES.filter((name) => name.startsWith(fragment));
    } else {
      matches = await this.#namesUnder(fragment);
    }
    if (matches.length === 0) return;

    if (matches.length === 1) {
      this.#apply(start, fragment, matches[0]);
      return;
    }
    // Several: fill in as far as they agree, then show the choices.
    const common = commonPrefix(matches);
    if (common.length > fragment.length) this.#apply(start, fragment, common, false);
    this.#completion = { matches, prefix: fragment, start, index: -1 };
    this.print(line(matches.join('  '), 'muted'));
  }

  /** Names in the folder a fragment points at, filtered by its last segment. */
  async #namesUnder(fragment) {
    const slash = fragment.lastIndexOf('/');
    const directory = slash === -1 ? '.' : fragment.slice(0, slash + 1);
    const partial = slash === -1 ? fragment : fragment.slice(slash + 1);

    let listing;
    try {
      listing = await this.provider.list(resolvePath(this.#cwd, directory));
    } catch {
      return [];
    }
    return (listing.items ?? [])
      .filter((item) => item.name.startsWith(partial))
      .map((item) => `${directory === '.' ? '' : directory}${item.name}${item.isDirectory ? '/' : ''}`);
  }

  #apply(start, fragment, completion, finished = true) {
    const value = this.input.value;
    const tail = value.slice(start + fragment.length);
    // Quote it if it has spaces, so the completed line is one the parser reads
    // back the same way.
    const needsQuotes = /\s/.test(completion);
    const inserted = needsQuotes ? `"${completion}"` : completion;
    const suffix = finished && !completion.endsWith('/') ? ' ' : '';
    this.input.value = `${value.slice(0, start)}${inserted}${suffix}${tail}`;
    const caret = start + inserted.length + suffix.length;
    this.input.setSelectionRange(caret, caret);
  }
}

function commonPrefix(items) {
  if (items.length === 0) return '';
  let prefix = items[0];
  for (const item of items.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < item.length && prefix[i] === item[i]) i += 1;
    prefix = prefix.slice(0, i);
    if (prefix === '') break;
  }
  return prefix;
}

export { COMMANDS, COMMAND_NAMES, runCommand } from '../core/terminal-commands.js';
