// fr-BE customer-facing terminology (owner decisions 2026-09-28): the words for the different "approval" actions must stay distinct.
//   sales document becoming official -> ÉMETTRE ; supplier invoice checked -> VALIDER LA FACTURE ;
//   Développement des ventes: no approval action (removed 2026-09-28) ; Analyses' « définition approuvée » unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

function dict(file) {
  const ctx = { window: { FINANCE_LANG: {} } };
  vm.createContext(ctx);
  vm.runInContext(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), ctx);
  return file.includes('/finance/') ? ctx.window.FINANCE_LANG.fr.messages : ctx.window.NORDLA_DICTS.fr;
}

test('Finances: issuing a sales document is "émettre", never "valider"', () => {
  const fr = dict('src/finance/ui/lang-fr.js');
  const issuance = ['Approve', 'Approve and issue', 'Review before you approve.', 'Ready for approval', 'To approve', 'Awaiting your approval', 'Nothing to approve',
    'Submit for approval', 'Submitted for approval', '{0} submitted for approval', '{0} invoice(s) waiting for your approval', '(assigned on approval: {0})',
    'Approving issues the document, assigns its number ({0}) and freezes it. Afterwards it can only be corrected with a credit note. Nothing is sent to your customer.',
    'Draft - this impact applies once the credit note is approved and issued.'];
  for (const k of issuance) {
    assert.ok(fr[k], `missing ${k}`);
    assert.match(fr[k], /émet|émis|émission/iu, `${k} -> ${fr[k]}`);
    assert.doesNotMatch(fr[k], /valid|approuv|approb/iu, `${k} -> ${fr[k]}`);
  }
  assert.equal(fr.Approve, 'Émettre');
  assert.equal(fr['Ready for approval'], 'À émettre');
});

test('Finances: checking a supplier invoice is "Valider la facture"', () => {
  const fr = dict('src/finance/ui/lang-fr.js');
  assert.equal(fr.Validate, 'Valider la facture');
  assert.equal(fr['Validate supplier invoices'], 'Valider les factures fournisseurs');
  assert.match(fr['{0} supplier invoice(s) require validation'], /valider/iu);
});

test('Développement des ventes has no approval button (removed 2026-09-28) and never says "approuver"; Analyses keeps « définition approuvée »', () => {
  const gr = dict('src/growth/ui/lang-fr.js');
  assert.equal(gr['gr.op.appr.approve'], undefined);
  assert.equal(gr['gr.att.soon'], undefined);
  assert.ok(Object.values(gr).every((v) => typeof v !== 'string' || !/approuv|approbation/iu.test(v)));
  const an = dict('src/analytics-premium/ui/lang-fr.js');
  const approuvee = Object.values(an).filter((v) => typeof v === 'string' && /approuvée/u.test(v));
  assert.equal(approuvee.length, 3, 'the three « définition / règle approuvée » texts stay unchanged');
});
