// Every browser module of China Sourcing must PARSE. The other UI tests load the screens through a resolve hook, but app.js (the controller)
// only runs in a browser: a syntax error there blanks the phone app while every unit test stays green (seen 2026-10-15). `node --check` parses
// each file as an ES module without running it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../src/sourcing/ui/', import.meta.url));
const files = [...readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => `${dir}${f}`), ...readdirSync(`${dir}screens`).filter((f) => f.endsWith('.js')).map((f) => `${dir}screens/${f}`)];

test('every China Sourcing UI module parses as an ES module (app.js included)', () => {
  assert.ok(files.length > 10 && files.some((f) => f.endsWith('/app.js')));
  const broken = files.filter((f) => spawnSync(process.execPath, ['--check', '--input-type=module'], { input: readFileSync(f), encoding: 'utf8' }).status !== 0);
  assert.deepEqual(broken, []);
});
