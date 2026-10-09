import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// The doc maps every numbered case of the mandate to a test; this test keeps that map honest.

const DOC = '../docs/architecture/provider-provisioning-live-connections-v1.md';

test('Coverage matrix: the doc maps all 115 mandate cases, and every test it names exists', async () => {
  const doc = await readFile(new URL(DOC, import.meta.url), 'utf8');
  const matrix = doc.slice(doc.indexOf('<!-- coverage-matrix:start -->'), doc.indexOf('<!-- coverage-matrix:end -->'));
  const rows = [...matrix.matchAll(/^\| (\d+) \| (.+?) \| (.+?) \|$/gm)].map((m) => ({ n: Number(m[1]), ref: m[3] }));
  assert.ok(rows.length >= 115, `only ${rows.length} rows`);
  assert.deepEqual(rows.map((r) => r.n), Array.from({ length: rows.length }, (_, i) => i + 1));
  for (const { n, ref } of rows) {
    if (ref.startsWith('(CI)')) continue; // cross-domain suites and the real-PostgreSQL smoke run in the dedicated workflow
    const [file, name] = ref.split(' › ');
    const text = await readFile(new URL(`./${file}`, import.meta.url), 'utf8');
    assert.ok(text.includes(`test('${name}'`), `mandate case ${n} names a test that does not exist: ${ref}`);
  }
});

test('Coverage matrix: the (CI) rows name files and scripts that exist', async () => {
  const doc = await readFile(new URL(DOC, import.meta.url), 'utf8');
  const named = [...new Set([...doc.matchAll(/^\| \d+ \| .+? \| \(CI\)[^|]*?`(test\/[\w./-]+)`/gm)].map((m) => m[1]))];
  assert.ok(named.length >= 4);
  for (const file of named) await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
});
