// Windows portability guard: a file: URL turned into a path with `.pathname` gives "/C:/..." on Windows (and "C:\C:\..." once re-wrapped), which broke the Sourcing tests there. Paths come from fileURLToPath.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('.', import.meta.url));
test('no Sourcing test turns a file: URL into a path with .pathname', () => {
  const offenders = readdirSync(dir).filter((f) => f.startsWith('sourcing-') && f.endsWith('.js'))
    .filter((f) => /(import\.meta\.url\)|\broot\))\.pathname/.test(readFileSync(`${dir}${f}`, 'utf8')));
  assert.deepEqual(offenders, []);
});
