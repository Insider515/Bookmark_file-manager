import { formatBytes, formatDate, resolvePath } from './format.js';

/**
 * The commands the terminal understands, and the machinery to run one.
 *
 * Nothing here touches the DOM, so the whole command language is testable
 * without a browser — which matters, because the parts that go wrong in a
 * shell are argument parsing and path arithmetic, not the pixels.
 *
 * These are *not* shell commands. Nothing spawns a process: every one of them
 * is a call into the same REST API the buttons use, so the terminal can do
 * exactly what the widget can do and not one thing more. That is the whole
 * security model — there is no sandbox to escape because there is no shell to
 * escape from, and a deployment that forbids deleting forbids `rm` by the same
 * permission check.
 */

/** One line of output. `tone` picks the colour, nothing else. */
export const line = (text, tone = 'out') => ({ text: String(text), tone });

export const TONES = ['out', 'muted', 'error', 'success', 'prompt'];

/**
 * Split a command line into arguments.
 *
 * Quotes and backslashes matter here more than in most shells: these paths are
 * full of spaces and Cyrillic, and `rm Мій звіт.txt` deleting two files that
 * do not exist is a worse outcome than an error.
 */
export function tokenize(input) {
  const tokens = [];
  let current = '';
  let quote = null;
  let started = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];

    if (char === '\\' && i + 1 < input.length && quote !== "'") {
      current += input[i + 1];
      started = true;
      i += 1;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) tokens.push(current);
      current = '';
      started = false;
      continue;
    }
    current += char;
    started = true;
  }
  if (started) tokens.push(current);
  return { tokens, unterminated: quote !== null };
}

const baseNameOf = (path) => {
  const parts = resolvePath('/', path).split('/');
  return parts[parts.length - 1] ?? '';
};

const parentOf = (path) => {
  const parts = resolvePath('/', path).split('/').filter(Boolean);
  parts.pop();
  return `/${parts.join('/')}`;
};

/**
 * Lay names out in columns that fit the width, the way `ls` does.
 *
 * One name per line is correct and unreadable for a folder of two hundred
 * files, which is exactly the folder someone opens a terminal for.
 */
export function columnize(names, width = 80) {
  if (names.length === 0) return [];
  const longest = names.reduce((max, name) => Math.max(max, name.length), 0);
  const columnWidth = longest + 2;
  const columns = Math.max(1, Math.floor(width / columnWidth));
  if (columns === 1) return names.slice();

  const rows = Math.ceil(names.length / columns);
  const out = [];
  for (let row = 0; row < rows; row += 1) {
    let text = '';
    for (let column = 0; column < columns; column += 1) {
      // Filled down each column and then across, which is what `ls` does and
      // what makes an alphabetical list readable.
      const name = names[column * rows + row];
      if (name === undefined) continue;
      text += column === columns - 1 ? name : name.padEnd(columnWidth, ' ');
    }
    out.push(text.replace(/\s+$/, ''));
  }
  return out;
}

/** Sort a listing the way the file list does: folders first, then by name. */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const byKind = (a, b) => {
  if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
  return collator.compare(a.name, b.name);
};

/**
 * What to print for a caught error.
 *
 * A failure from the server arrives as an English sentence plus a code, so
 * `ctx.errorText` — which knows the active language — gets first refusal;
 * without it the server's own words are still better than nothing.
 */
const messageOf = (err, ctx) =>
  (ctx.errorText ? ctx.errorText(err) : err?.message) || err?.message || ctx.t('term.failed');

/**
 * The command table.
 *
 * `needs` names the permission the command writes with, so a manager opened
 * read-only says which operation is closed instead of letting the request go
 * and reporting a 403.
 */
export const COMMANDS = {
  help: {
    usageKey: 'term.usage.help',
    summaryKey: 'term.desc.help',
    run: async (args, ctx) => {
      const { t } = ctx;
      const [name] = args;
      if (name) {
        const command = COMMANDS[name];
        if (!command) return [line(t('term.noSuchCommand', { name }), 'error')];
        return [line(t(command.usageKey)), line(`  ${t(command.summaryKey)}`, 'muted')];
      }
      const names = Object.keys(COMMANDS).sort();
      return [
        line(t('term.helpIntro'), 'muted'),
        line(''),
        ...names.map((key) => line(`  ${key.padEnd(10)} ${t(COMMANDS[key].summaryKey)}`)),
        line(''),
        line(t('term.helpFooter'), 'muted'),
      ];
    },
  },

  pwd: {
    usageKey: 'term.usage.pwd',
    summaryKey: 'term.desc.pwd',
    run: async (_args, ctx) => [line(ctx.cwd)],
  },

  ls: {
    usageKey: 'term.usage.ls',
    summaryKey: 'term.desc.ls',
    run: async (args, ctx) => {
      const long = args.includes('-l');
      const rest = args.filter((arg) => arg !== '-l');
      const target = resolvePath(ctx.cwd, rest[0] ?? '.');
      const listing = await ctx.provider.list(target);
      const items = [...(listing.items ?? [])].sort(byKind);

      if (items.length === 0) return [line(ctx.t('common.empty'), 'muted')];

      if (!long) {
        return columnize(
          items.map((item) => (item.isDirectory ? `${item.name}/` : item.name)),
          ctx.width
        ).map((text) => line(text));
      }

      const out = items.map((item) =>
        line(
          [
            item.isDirectory ? 'd' : '-',
            (item.modeOctal ?? '---').padStart(4, ' '),
            (item.isDirectory ? '—' : formatBytes(item.size, ctx.t)).padStart(9, ' '),
            formatDate(item.modified, ctx.localeTag).padStart(17, ' '),
            '  ',
            item.isDirectory ? `${item.name}/` : item.name,
          ].join(' ')
        )
      );
      if (listing.truncated) {
        out.push(
          line(ctx.t('term.lsTruncated', { shown: items.length, total: listing.total }), 'muted')
        );
      }
      return out;
    },
  },

  cd: {
    usageKey: 'term.usage.cd',
    summaryKey: 'term.desc.cd',
    run: async (args, ctx) => {
      const target = resolvePath(ctx.cwd, args[0] ?? '/');
      // Checked before moving: a prompt pointing at a folder that is not there
      // makes every following command fail for a reason that is not shown.
      const entry = await ctx.provider.stat(target);
      if (!entry.isDirectory) return [line(ctx.t('term.notFolder', { path: target }), 'error')];
      await ctx.setCwd(target);
      return [];
    },
  },

  cat: {
    usageKey: 'term.usage.cat',
    summaryKey: 'term.desc.cat',
    run: async (args, ctx) => {
      if (args.length === 0) return [line(ctx.t('term.needFile'), 'error')];
      const target = resolvePath(ctx.cwd, args[0]);
      const document = await ctx.provider.readText(target);
      const lines = document.text.split('\n');
      const shown = lines.slice(0, ctx.maxOutputLines);
      const out = shown.map((text) => line(text));
      if (lines.length > shown.length) {
        out.push(line(`… ${ctx.t('count.lines', { n: lines.length - shown.length })}`, 'muted'));
      }
      return out;
    },
  },

  stat: {
    usageKey: 'term.usage.stat',
    summaryKey: 'term.desc.stat',
    run: async (args, ctx) => {
      if (args.length === 0) return [line(ctx.t('term.needPath'), 'error')];
      const target = resolvePath(ctx.cwd, args[0]);
      const details = await ctx.provider.properties(target);
      const rows = [
        [ctx.t('term.f.path'), details.path],
        [
          ctx.t('term.f.type'),
          details.isDirectory ? ctx.t('common.folder') : details.kind || ctx.t('common.file'),
        ],
        [
          ctx.t('term.f.size'),
          details.isDirectory
            ? (details.itemCount ?? '—') + ctx.t('term.f.items')
            : formatBytes(details.size, ctx.t),
        ],
        [ctx.t('term.f.modified'), formatDate(details.modified, ctx.localeTag)],
        [ctx.t('term.f.mode'), `${details.modeOctal ?? '—'} (${details.modeText ?? '—'})`],
      ];
      if (details.isSymbolicLink) rows.push([ctx.t('term.f.link'), ctx.t('common.yes')]);
      return rows.map(([key, value]) => line(`${key.padEnd(9)} ${value}`));
    },
  },

  du: {
    usageKey: 'term.usage.du',
    summaryKey: 'term.desc.du',
    run: async (args, ctx) => {
      const target = resolvePath(ctx.cwd, args[0] ?? '.');
      const details = await ctx.provider.properties(target, { computeSize: true });
      const bytes = details.totalSize ?? details.size ?? 0;
      const out = [line(`${formatBytes(bytes, ctx.t)}  ${target}`)];
      // The server stops counting past a limit; a number that quietly excludes
      // half the tree is worse than one that says it is partial.
      if (details.sizePartial) out.push(line(ctx.t('term.duPartial'), 'muted'));
      return out;
    },
  },

  tree: {
    usageKey: 'term.usage.tree',
    summaryKey: 'term.desc.tree',
    run: async (args, ctx) => {
      const target = resolvePath(ctx.cwd, args[0] ?? '.');
      const depth = Math.min(6, Math.max(1, Number.parseInt(args[1] ?? '2', 10) || 2));
      const node = await ctx.provider.tree(target, depth);

      const out = [];
      const walk = (current, prefix, isLast, top) => {
        const label = top ? current.path : `${current.name}/`;
        out.push(line(top ? label : `${prefix}${isLast ? '└─ ' : '├─ '}${label}`));
        const children = current.children ?? [];
        children.forEach((child, index) => {
          const last = index === children.length - 1;
          walk(child, top ? '' : `${prefix}${isLast ? '   ' : '│  '}`, last, false);
        });
      };
      walk(node, '', true, true);
      return out;
    },
  },

  find: {
    usageKey: 'term.usage.find',
    summaryKey: 'term.desc.find',
    run: async (args, ctx) => {
      if (args.length === 0) return [line(ctx.t('term.needMask'), 'error')];
      const target = resolvePath(ctx.cwd, args[1] ?? '.');
      const result = await ctx.provider.search(target, { query: args[0], mode: 'glob' });
      return searchOutput(result, ctx);
    },
  },

  grep: {
    usageKey: 'term.usage.grep',
    summaryKey: 'term.desc.grep',
    run: async (args, ctx) => {
      if (args.length === 0) return [line(ctx.t('term.needQuery'), 'error')];
      const target = resolvePath(ctx.cwd, args[1] ?? '.');
      const result = await ctx.provider.search(target, {
        query: args[0],
        mode: 'substring',
        scope: 'content',
      });
      const out = [];
      for (const match of result.matches) {
        for (const hit of match.lines ?? []) {
          out.push(line(`${match.path}:${hit.line}: ${hit.text.trim()}`));
        }
      }
      if (out.length === 0) out.push(line(ctx.t('term.nothingFound'), 'muted'));
      if (result.truncated) out.push(line(ctx.t('term.moreMatches'), 'muted'));
      if (result.timedOut) out.push(line(ctx.t('search.timedOut'), 'muted'));
      return out;
    },
  },

  mkdir: {
    usageKey: 'term.usage.mkdir',
    summaryKey: 'term.desc.mkdir',
    needs: 'create',
    run: async (args, ctx) => {
      if (args.length === 0) return [line(ctx.t('term.needName'), 'error')];
      const out = [];
      for (const argument of args) {
        const target = resolvePath(ctx.cwd, argument);
        try {
          await ctx.provider.createDirectory(parentOf(target), baseNameOf(target));
          out.push(line(ctx.t('term.created', { path: target }), 'success'));
        } catch (err) {
          out.push(line(`${argument}: ${messageOf(err, ctx)}`, 'error'));
        }
      }
      await ctx.refresh();
      return out;
    },
  },

  touch: {
    usageKey: 'term.usage.touch',
    summaryKey: 'term.desc.touch',
    needs: 'create',
    run: async (args, ctx) => {
      if (args.length === 0) return [line(ctx.t('term.needName'), 'error')];
      const out = [];
      for (const argument of args) {
        const target = resolvePath(ctx.cwd, argument);
        try {
          await ctx.provider.createFile(parentOf(target), baseNameOf(target), '');
          out.push(line(ctx.t('term.created', { path: target }), 'success'));
        } catch (err) {
          out.push(line(`${argument}: ${messageOf(err, ctx)}`, 'error'));
        }
      }
      await ctx.refresh();
      return out;
    },
  },

  rm: {
    usageKey: 'term.usage.rm',
    summaryKey: 'term.desc.rm',
    needs: 'remove',
    run: async (args, ctx) => {
      if (args.length === 0) return [line(ctx.t('term.needTarget'), 'error')];
      const targets = args.map((argument) => resolvePath(ctx.cwd, argument));
      if (targets.includes('/')) return [line(ctx.t('term.cannotDeleteRoot'), 'error')];

      const result = await ctx.provider.remove(targets);
      await ctx.refresh();
      return (result?.removed ?? targets).map((path) =>
        line(ctx.t('term.deleted', { path }), 'success')
      );
    },
  },

  cp: {
    usageKey: 'term.usage.cp',
    summaryKey: 'term.desc.cp',
    needs: 'copy',
    run: async (args, ctx) => transfer(args, ctx, 'copy'),
  },

  mv: {
    usageKey: 'term.usage.mv',
    summaryKey: 'term.desc.mv',
    needs: 'move',
    run: async (args, ctx) => transfer(args, ctx, 'move'),
  },

  chmod: {
    usageKey: 'term.usage.chmod',
    summaryKey: 'term.desc.chmod',
    needs: 'chmod',
    run: async (args, ctx) => {
      if (args.length < 2) return [line(ctx.t('term.needMode'), 'error')];
      const [mode, ...rest] = args;
      if (!/^[0-7]{3,4}$/.test(mode)) {
        return [line(ctx.t('term.badMode', { mode }), 'error')];
      }
      const targets = rest.map((argument) => resolvePath(ctx.cwd, argument));
      const changed = await ctx.provider.chmod(targets, { mode });
      await ctx.refresh();
      return (changed ?? []).map((item) => line(`${item.modeOctal}  ${item.path}`, 'success'));
    },
  },

  open: {
    usageKey: 'term.usage.open',
    summaryKey: 'term.desc.open',
    run: async (args, ctx) => {
      if (args.length === 0) return [line(ctx.t('term.needPath'), 'error')];
      const target = resolvePath(ctx.cwd, args[0]);
      const entry = await ctx.provider.stat(target);
      await ctx.open(entry);
      return [];
    },
  },

  download: {
    usageKey: 'term.usage.download',
    summaryKey: 'term.desc.download',
    needs: 'download',
    run: async (args, ctx) => {
      if (args.length === 0) return [line(ctx.t('term.needPath'), 'error')];
      const targets = args.map((argument) => resolvePath(ctx.cwd, argument));
      await ctx.download(targets);
      return [line(ctx.t('term.downloading', { paths: targets.join(', ') }), 'muted')];
    },
  },

  clear: {
    usageKey: 'term.usage.clear',
    summaryKey: 'term.desc.clear',
    run: async (_args, ctx) => {
      ctx.clear();
      return [];
    },
  },
};

/** Shared by cp and mv: everything except which call to make. */
async function transfer(args, ctx, kind) {
  if (args.length < 2) {
    return [line(ctx.t(kind === 'cp' ? 'term.usage.cp' : 'term.needSourceDest'), 'error')];
  }
  const destinationArgument = args[args.length - 1];
  const sources = args.slice(0, -1).map((argument) => resolvePath(ctx.cwd, argument));
  const destination = resolvePath(ctx.cwd, destinationArgument);

  // Is the destination a folder to put things in, or a new name for one thing?
  let destinationIsDirectory = false;
  try {
    destinationIsDirectory = (await ctx.provider.stat(destination)).isDirectory;
  } catch {
    destinationIsDirectory = false;
  }

  if (destinationIsDirectory) {
    const moved = kind === 'move'
      ? await ctx.provider.move(sources, destination)
      : await ctx.provider.copy(sources, destination);
    await ctx.refresh();
    return (moved ?? []).map((entry) => line(`${entry.path}`, 'success'));
  }

  if (sources.length > 1) {
    return [line(ctx.t('term.destNotFolderMany', { path: destination }), 'error')];
  }
  if (kind === 'copy') {
    return [line(ctx.t('term.destNotFolderCopy', { path: destination }), 'error')];
  }

  // A rename, possibly into a different folder — which the API does in two
  // steps, so a half-done result has to be reported as one.
  const source = sources[0];
  const targetParent = parentOf(destination);
  const newName = baseNameOf(destination);
  if (!newName) return [line(ctx.t('term.needNewName'), 'error')];

  if (targetParent === parentOf(source)) {
    const renamed = await ctx.provider.rename(source, newName);
    await ctx.refresh();
    return [line(`${source} → ${renamed.path}`, 'success')];
  }

  const [moved] = (await ctx.provider.move([source], targetParent)) ?? [];
  if (!moved) return [line(ctx.t('term.moveFailed'), 'error')];
  try {
    const renamed = await ctx.provider.rename(moved.path, newName);
    await ctx.refresh();
    return [line(`${source} → ${renamed.path}`, 'success')];
  } catch (err) {
    await ctx.refresh();
    return [
      line(
        ctx.t('term.movedNotRenamed', { path: moved.path, message: messageOf(err, ctx) }),
        'error'
      ),
    ];
  }
}

function searchOutput(result, ctx) {
  if (result.matches.length === 0) return [line(ctx.t('term.nothingFound'), 'muted')];
  const out = result.matches.map((match) =>
    line(match.isDirectory ? `${match.path}/` : match.path)
  );
  if (result.truncated) out.push(line(ctx.t('term.firstMatches', { n: result.matches.length }), 'muted'));
  if (result.timedOut) out.push(line(ctx.t('search.timedOut'), 'muted'));
  return out;
}

export const COMMAND_NAMES = Object.keys(COMMANDS).sort();

// Re-exported because this is where a reader of the command language expects
// to find it; it lives in format.js with the other path helpers.
export { resolvePath } from './format.js';

/**
 * Run one line and return what to print.
 *
 * Never throws: a terminal that dies on a bad command is not a terminal. Every
 * failure comes back as an error line, which is also what makes this testable
 * against a fake provider.
 *
 * @param {string} input
 * @param {object} ctx provider, cwd, width, and the callbacks the commands use
 * @returns {Promise<{lines: object[], command: string|null}>}
 */
export async function runCommand(input, ctx) {
  // Falling back to the key keeps this callable from a test with a bare ctx.
  if (!ctx.t) ctx = { ...ctx, t: (key) => key };
  const text = String(input ?? '').trim();
  if (text === '') return { lines: [], command: null };

  const { tokens, unterminated } = tokenize(text);
  if (unterminated) {
    return { lines: [line(ctx.t('term.unclosedQuote'), 'error')], command: null };
  }

  const [name, ...args] = tokens;
  const command = COMMANDS[name];
  if (!command) {
    return {
      lines: [line(ctx.t('term.unknownCommand', { name }), 'error')],
      command: null,
    };
  }

  if (command.needs && ctx.can && !ctx.can(command.needs)) {
    return {
      lines: [line(ctx.t('term.forbidden', { permission: command.needs }), 'error')],
      command: name,
    };
  }

  try {
    const lines = (await command.run(args, ctx)) ?? [];
    return { lines, command: name };
  } catch (err) {
    return { lines: [line(messageOf(err, ctx), 'error')], command: name };
  }
}
