import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Cheap checks over the source itself.
 *
 * A duplicated property in an object literal is legal JavaScript — the last
 * one silently wins — so nothing complains about it, and a bad automated edit
 * can leave ten of them behind without a single test failing. This file is
 * what notices.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const roots = ['src', 'server'].map((d) => path.join(here, '..', d));

function sources() {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) found.push(full);
    }
  };
  roots.forEach(walk);
  return found;
}

/** Property keys that appear twice at the same nesting level in one literal. */
function duplicateKeys(code) {
  const keyLine = /^\s*([A-Za-z_$][\w$]*)\s*:/;
  const stack = [new Map()];
  const found = [];

  code.split('\n').forEach((line, index) => {
    const match = keyLine.exec(line);
    if (match) {
      const seen = stack[stack.length - 1];
      const key = match[1];
      if (seen.has(key)) found.push({ key, line: index + 1, first: seen.get(key) });
      else seen.set(key, index + 1);
    }
    for (const character of line) {
      if (character === '{') stack.push(new Map());
      else if (character === '}' && stack.length > 1) stack.pop();
    }
  });
  return found;
}

describe('source hygiene', () => {
  test('no object literal sets the same property twice', () => {
    const offences = [];
    for (const file of sources()) {
      for (const { key, line, first } of duplicateKeys(fs.readFileSync(file, 'utf8'))) {
        offences.push(`${path.relative(path.join(here, '..'), file)}:${line} — “${key}” is already set on line ${first}`);
      }
    }
    assert.deepEqual(offences, [], `\n${offences.join('\n')}\n`);
  });

  test('the checker itself notices a duplicate', () => {
    // Otherwise the case above passes by being blind rather than by being true.
    const found = duplicateKeys('const x = {\n  a: 1,\n  b: 2,\n  a: 3,\n};');
    assert.equal(found.length, 1);
    assert.equal(found[0].key, 'a');
    assert.equal(found[0].line, 4);
  });

  test('and does not flag the same name in two different literals', () => {
    const found = duplicateKeys('const x = { a: 1 };\nconst y = { a: 2 };\nconst z = { p: { a: 1 }, a: 2 };');
    assert.deepEqual(found, []);
  });
});
