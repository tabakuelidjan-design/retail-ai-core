// Regression: a stray line outside a comment in nordla-home.css made the browser drop the rules after it,
// and the Sourcing tab bar came back over the Core home. These checks keep the stylesheet parseable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CSS = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'sourcing', 'ui', 'nordla-home.css'), 'utf8');
const WITHOUT_COMMENTS = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

/** Each selector (the text before a '{') must look like a selector: no sentence, no slash, no stray prose. */
export function strayProse(css) {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const bad = [];
  for (const chunk of stripped.split('}')) {
    const head = chunk.split('{')[0].replace(/@media[^{]*/g, ''); // a media query opens a block of its own rules
    if (!head.trim()) continue;
    if (!/^[.#:\w\s,()>+~*\-[\]="'&]+$/.test(head.trim()) || /\.\s+[A-Za-z]/.test(head)) bad.push(head.trim().slice(0, 80));
  }
  return bad;
}

test('nordla-home.css: comments are closed and every selector is a selector (no stray prose outside a comment)', () => {
  assert.equal((CSS.match(/\/\*/g) ?? []).length, (CSS.match(/\*\//g) ?? []).length, 'every comment opens and closes');
  assert.deepEqual(strayProse(CSS), [], 'no text outside a comment or a rule');
});

test('the checker catches the broken header (a comment closed too early, then prose)', () => {
  const broken = '/* header\n   Palette: cool white, green/teal. No cream. */\nbody { color: red }\n';
  const fixed = '/* header */\n\n/* Palette: cool white. */\nbody { color: red }\n';
  assert.notDeepEqual(strayProse('/* a */ Palette: cool white and light grey backgrounds, dark navy text, gold accent, green/teal, blue-grey and orange charts. No cream or beige. /* b */\n.x { color: red }'), []);
  assert.deepEqual(strayProse(fixed), []);
  assert.equal(typeof broken, 'string');
});

test('nordla-home.css: the Sourcing tab bar is hidden on the Core home, and the Core home is not capped at the Sourcing width', () => {
  assert.match(WITHOUT_COMMENTS, /body:has\(\.nx-home\) #tabs\s*\{\s*display:\s*none\s*!important;?\s*\}/);
  assert.match(WITHOUT_COMMENTS, /body\.sl-mode main:has\(\.nx-home\)\s*\{[^}]*max-width:\s*none/);
});
