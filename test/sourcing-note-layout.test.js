// The Noter screen in three cards (option A): every existing function is still rendered, with the same actions and ids.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { noteHtml } from '../src/sourcing/ui/screens/nx.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const salon = readFileSync(path.join(root, 'src/sourcing/ui/screens/salon.js'), 'utf8');
const css = readFileSync(path.join(root, 'src/sourcing/ui/nx.css'), 'utf8');

const base = {
  info: { caseId: 'case-1', supplier: 'Fournisseur test', title: 'Coque personnalisée' },
  flash: '', speaker: 'supplier', draft: '', proposals: '', notes: [], photos: [], online: true, conflicts: 0,
  voice: { available: false, state: 'off', title: '', message: '', items: [] },
};

test('the Noter screen is three cards: Prise de note, Fiche fournisseur, Outils de sourcing', () => {
  const html = noteHtml({ ...base, mode: 'text' });
  assert.match(html, /class="nx-note-grid"/);
  assert.match(html, /class="nx-ncard nx-card-note"[^]*?Prise de note/);
  assert.match(html, /class="nx-ncard nx-card-fiche"[^]*?Fiche fournisseur/);
  assert.match(html, /class="nx-ncard nx-card-tools"[^]*?Outils de sourcing/);
});

test('the note card keeps the input modes, the speaker choice and the text form', () => {
  const html = noteHtml({ ...base, mode: 'text' });
  const note = html.slice(html.indexOf('nx-card-note'), html.indexOf('nx-card-fiche'));
  assert.match(note, /data-act="sl-note-mode"/);
  assert.match(note, /data-act="sl-note-speaker" data-key="supplier"/);
  assert.match(note, /data-act="sl-note-speaker" data-key="me"/);
  assert.match(note, /data-form="sl-note"/);
  assert.match(note, /Enregistrer la note/);
});

test('each mode still renders its own pane inside the note card (photo, voice, document)', () => {
  const photo = noteHtml({ ...base, mode: 'photo' });
  assert.match(photo, /Photographier le produit/);
  assert.match(photo, /data-act="sl-note-photo"/);
  const voice = noteHtml({ ...base, mode: 'voice', voice: { available: true, state: 'idle', title: 'Dictée', message: 'Prête', items: [] } });
  assert.match(voice, /data-act="sl-voice-start"/);
  const doc = noteHtml({ ...base, mode: 'doc' });
  assert.match(doc, /data-act="sl-update-offer"/);
  assert.match(doc, /data-act="sl-embed"/);
});

test('the proposals and the notes of the case stay in the layout', () => {
  const html = noteHtml({ ...base, mode: 'text', proposals: '<p class="prop-marker">PROPOSITION</p>', notes: [{ id: 'n1', text: 'Note existante', at: '2026-11-24T09:00:00Z' }] });
  assert.match(html, /PROPOSITION/);
  assert.match(html, /Notes de ce dossier/);
});

test('the tools card uses the existing actions: Réglages and Récupération (sheet), Synchronisation (sync)', () => {
  const html = noteHtml({ ...base, mode: 'text' });
  const tools = html.slice(html.indexOf('nx-card-tools'));
  assert.match(tools, /data-act="sl-recover"/);
  assert.match(tools, /data-act="sl-sync-now"/);
  // those actions are handled by the Sourcing controller
  assert.match(salon, /case 'sl-sync-now'/);
  assert.match(salon, /case 'sl-recover'/);
});

test('phone: one column; computer: note and fiche side by side, tools below (CSS)', () => {
  assert.match(css, /@media \(min-width:900px\)\{[^}]*grid-template-areas:"note fiche" "tools tools"/);
  assert.match(css, /@media \(max-width:899px\)\{ \.nx-tools\{grid-template-columns:1fr\} \}/);
});
