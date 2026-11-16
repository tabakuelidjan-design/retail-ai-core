import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { FORMAT, POST_STATE } from '../src/social/constants.js';

const ui = await readFile(new URL('../src/social/ui/app.js', import.meta.url), 'utf8');

test('UL-1 the phone UI has a label for every post format (a Story or a carousel never shows an empty or "undefined" chip)', () => {
  const block = ui.match(/const FORMAT = \{([^}]*)\}/)?.[1] ?? '';
  for (const format of Object.values(FORMAT)) assert.ok(block.includes(` ${format}:`), `no label for ${format}`);
});

test('UL-2 the narrow phone layout keeps the bottom tabs on one line', async () => {
  const css = await readFile(new URL('../src/social/ui/app.css', import.meta.url), 'utf8');
  assert.match(css, /\.tabs button\{[^}]*white-space:nowrap/);
  assert.ok(Object.keys(POST_STATE).length > 0);
});
