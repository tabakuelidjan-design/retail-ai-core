import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The reserve checker reads the editorial reserve format (synthetic items here, no real content).
const run = (items) => {
  const dir = mkdtempSync(join(tmpdir(), 'rsv-'));
  const file = join(dir, 'posts.json');
  writeFileSync(file, JSON.stringify({ version: 1, items }));
  const r = spawnSync(process.execPath, ['tools/habb-reserve-check.mjs', file, '--json'], { encoding: 'utf8' });
  return { status: r.status, out: JSON.parse(r.stdout) };
};
const post = (over = {}) => ({ id: 'P01', canal: ['Instagram (feed)'], etat_visuel: 'BRIEF', legende: 'Coque personnalisée : 25 € en boutique. Prête en environ 5 minutes, selon le modèle.', hashtags: ['Namur'], ...over });

test('RC-1 a clean reserve passes; counts and visual status are reported', () => {
  const r = run([post(), post({ id: 'S01', etat_visuel: 'PRÊT', alt_text: 'x', legende: 'Écran 1 : texte.' }), post({ id: 'V1', etat_visuel: 'NON TOURNÉE' })]);
  assert.equal(r.status, 0);
  assert.deepEqual(r.out.counts, { POST: 1, STORY: 1, REEL: 1 });
  assert.deepEqual(r.out.visual_status, { READY: 1, BRIEF: 1, NOT_SHOT: 1, OTHER: 0 });
});

test('RC-2 it finds what E would block, forbidden decorative words, and a ready visual without alt text', () => {
  const r = run([
    post({ id: 'P01', legende: 'Gourde à 28,90 €.' }),
    post({ id: 'P02', legende: 'Livraison gratuite.' }),
    post({ id: 'P03', legende: 'Des feuilles dorées sur la coque.' }),
    post({ id: 'S01', etat_visuel: 'PRÊT', legende: 'ok' }),
    post({ id: 'P04', legende: 'Coque personnalisée : 25 €.' }),
    post({ id: 'V2', legende: 'Notre équipe vérifie le cadrage avant impression.' }),
  ]);
  assert.equal(r.status, 1);
  const codes = r.out.problems.map((p) => `${p.item}:${p.code}`).sort();
  assert.deepEqual(codes, ['P01:E_WOULD_BLOCK_PRICE', 'P02:E_WOULD_BLOCK_DELIVERY_DELAY', 'P02:E_WOULD_BLOCK_DISCOUNT', 'P03:FORBIDDEN_DECORATIVE_WORD', 'P04:PRICE_CHANNEL_UNSTATED', 'S01:ALT_TEXT_MISSING_ON_READY_VISUAL', 'V2:PROCESS_CLAIM_UNCONFIRMED']);
});
