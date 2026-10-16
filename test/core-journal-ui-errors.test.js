// Journal failures must remain visible and actionable, including after a refresh.
// Everything here is synthetic: no disk, server, Railway or Supabase changes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { coreErrorMessage, coreDisabledReason } from '../src/sourcing/ui/core-journal-errors.js';
import { createCorePanel } from '../src/sourcing/ui/core-panel.js';
import { createModulesPanel } from '../src/sourcing/ui/modules-panel.js';

test('journal errors are explicit, safe, and never assert that an uncertain write did not happen', () => {
  const protectedText = coreErrorMessage({ status: 503, body: { error: 'JOURNAL_PROTECTED', message: '/app/data/internal-path' } });
  assert.match(protectedText, /JOURNAL_PROTECTED/);
  assert.match(protectedText, /peut déjà être présente/);
  assert.doesNotMatch(protectedText, /internal-path|Rien n.a été changé/);
  const torn = coreDisabledReason('JOURNAL_TORN_TAIL: line 4 raw-path');
  assert.match(torn, /JOURNAL_TORN_TAIL/);
  assert.match(torn, /récupération contrôlée/);
  assert.doesNotMatch(torn, /raw-path/);
  const permission = coreErrorMessage({ status: 503, body: { error: 'JOURNAL_LOCK_PERMISSION' } });
  assert.match(permission, /JOURNAL_LOCK_PERMISSION/);
  assert.match(permission, /droits/);
  assert.match(coreErrorMessage({ status: 401, body: { message: 'internal exception' } }), /Session expirée/);
  assert.match(coreErrorMessage({ status: 503, body: {} }), /vérifiez son historique/);
});

test('Core startup warning is displayed when no status could be loaded', async () => {
  const panel = createCorePanel({
    S: { online: true, token: 'synthetic' },
    api: async () => { throw { status: 503, body: { error: 'JOURNAL_TORN_TAIL' } }; },
    refresh: () => {},
  });
  await panel.load(null);
  assert.match(panel.section(null), /JOURNAL_TORN_TAIL/);
});

test('Core disabled reason is translated even when the server returns HTTP 200', async () => {
  const panel = createCorePanel({
    S: { online: true, token: 'synthetic' },
    api: async () => ({ enabled: false, reason: 'JOURNAL_TORN_TAIL: file offset 128' }),
    refresh: () => {},
  });
  await panel.load(null);
  const html = panel.section(null);
  assert.match(html, /récupération contrôlée/);
  assert.doesNotMatch(html, /file offset/);
});

test('Nordla modules retain the write-failure warning when a subsequent read succeeds', async () => {
  const oldDocument = globalThis.document;
  let click;
  globalThis.document = {
    addEventListener: (kind, fn) => { if (kind === 'click') click = fn; },
    getElementById: () => null,
  };
  try {
    const S = { online: true, token: 'synthetic' };
    const mods = ['core', 'finance', 'analytics', 'sourcing', 'branding', 'marketing', 'creative'];
    const panel = createModulesPanel({
      S,
      refresh: () => {},
      api: async (path, options) => {
        if (options?.method === 'POST') throw { status: 503, body: { error: 'JOURNAL_PROTECTED' } };
        if (path === '/api/core/modules') return { modules: mods.map((key) => ({ key, label: key, state: 'NON RACCORDÉ', detail: '', offline: false })) };
        if (path === '/api/core/branding') return { status: 'NOT_CONNECTED' };
        if (path === '/api/core/campaigns') return { campaigns: [] };
        if (path === '/api/core/creation') return { status: 'NOT_CONNECTED', creations: [] };
        throw Error('unexpected route: ' + path);
      },
    });
    await panel.load();
    const target = { dataset: { act: 'nx-ask', q: 'test', label: 'test' }, closest: () => null };
    await click({ target: { closest: () => target } });
    assert.match(panel.section(), /JOURNAL_PROTECTED/);
    assert.match(S.nx.error, /peut déjà être présente/);
  } finally {
    if (oldDocument === undefined) delete globalThis.document;
    else globalThis.document = oldDocument;
  }
});
