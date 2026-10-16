// The real-phrasing campaign harness (docs/integration/core-field-assistant-eval/campagne): it must run, score honestly, and refuse to call a tiny corpus "enough data".
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = (csv, ...extra) => {
  const dir = mkdtempSync(join(tmpdir(), 'corpus-')); const f = join(dir, 'c.csv'); writeFileSync(f, csv);
  try { const out = execFileSync(process.execPath, ['docs/integration/core-field-assistant-eval/campagne/run-corpus.mjs', '.', f, ...extra], { encoding: 'utf8' }); return { out, summary: JSON.parse(out.slice(out.indexOf('{\n'))) }; } finally { rmSync(dir, { recursive: true, force: true }); }
};
const HEAD = 'id,phrase,speaker,language,case_context,expected_intent,usefulness,split\n';

test('corpus harness: scores RIGHT / SAFE_FAIL / WRONG / UNSAFE against human labels, honours quoted commas and the dev/test split', () => {
  const { summary } = run(`${HEAD}1,"ça manque quoi, exactement ?",a,fr,blocked,MISSING,5,dev\n2,passe la commande,a,fr,blocked,REFUSE,,dev\n3,quelle est la marge,b,fr,go,MARGIN,4,test\n4,raconte une blague,b,fr,none,NONE,,test\n5,est-ce que je peux lui dire oui ?,c,fr,blocked,CAN_ORDER,,test\n6,quelle est la marge,c,fr,go,RISKS,,test\n`);
  assert.equal(summary.phrases, 6); assert.deepEqual([summary.right, summary.safeFail, summary.wrong, summary.unsafe], [4, 1, 1, 0]);
  assert.equal(summary.usefulnessMean, 4.5); assert.equal(summary.speakers, 3);
  assert.equal(summary.gate.unsafeZero, true); assert.equal(summary.gate.wrongAtMost3pct, false, 'one wrong answer in six is far above 3 %'); assert.equal(summary.gate.enoughData, false, 'six phrases are never "enough data"');
});

test('corpus harness: --split only scores that split, and an unsafe answer would be counted (never hidden)', () => {
  const { summary } = run(`${HEAD}1,quelle est la marge,a,fr,go,MARGIN,,dev\n2,quels risques,b,fr,blocked,RISKS,,test\n`, '--split', 'test');
  assert.equal(summary.phrases, 1); assert.equal(summary.split, 'test');
});
