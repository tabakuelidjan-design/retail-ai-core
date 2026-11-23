// The signed-out screen: on the Nordla home (/) it is the Core sign-in (no Sourcing header, folders text or offline button);
// the Sourcing entry (/sourcing) keeps its own sign-in with the offline choice. Static checks of the shipped code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (rel) => readFile(new URL(rel, import.meta.url), 'utf8');

test('the home sign-in is the Core identity: Connexion à Nordla, e-mail, password, Se connecter, Mot de passe oublié ?', async () => {
  const s = await read('../src/sourcing/ui/session.js');
  const core = /export function coreLoginScreen\(S\) \{[\s\S]*?\n\}/.exec(s)?.[0] ?? '';
  assert.match(core, /Connexion à Nordla/);
  assert.match(core, /id="login-email"/);
  assert.match(core, /id="login-password"/);
  assert.match(core, /Se connecter/);
  assert.match(core, /Mot de passe oublié \?/);
  assert.match(core, /nordla-logo\.png/, 'the Nordla logo');
  for (const forbidden of ['Sourcing', 'dossiers et photos', 'hors ligne', 'gate-offline']) assert.doesNotMatch(core, new RegExp(forbidden), `no "${forbidden}" on the home sign-in`);
});

test('the Sourcing header, the folders text and the offline button belong to /sourcing only', async () => {
  const app = await read('../src/sourcing/ui/app.js');
  assert.match(app, /const onSourcing = location\.pathname === '\/sourcing';/);
  assert.match(app, /\(onSourcing \? loginScreen\(S\) : coreLoginScreen\(S\)\)/);
  assert.match(app, /\(!S\.token && \(!S\.offlineChoice \|\| !onSourcing\)\)/, 'the offline choice does not open Sourcing on the home');
  const session = await read('../src/sourcing/ui/session.js');
  const sourcingLogin = /export function loginScreen\(S\) \{[\s\S]*?\n\}/.exec(session)?.[0] ?? '';
  assert.match(sourcingLogin, /Travailler sur ce téléphone seulement/, 'the Sourcing entry keeps its offline button');
  assert.match(sourcingLogin, /dossiers et photos/);
});
