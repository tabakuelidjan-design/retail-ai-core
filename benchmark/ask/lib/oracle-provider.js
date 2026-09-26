// The ORACLE: a scripted stand-in that answers every case as a perfect provider would (plans from oracle.json, explanations built strictly from the facts it is
// given and from the case's expected quantities). It is not a candidate: it validates the benchmark itself.
//   - an oracle run must score 100 % (the expectations are achievable through the real orchestrator);
//   - each `degrade` mode breaks ONE behaviour, so tests can prove that the matching sub-score falls while the scores are still reported separately.
// No network, no model.

import { readFileSync } from 'node:fs';

const fmt = (n) => String(n).replace('.', ',');

/**
 * @param {{ cases: object[], plans?: object, degrade?: 'none'|'forgetPremises'|'hallucinate'|'overClarify'|'wrongTools' }} opts
 */
export function createOracleProvider({ cases, plans = JSON.parse(readFileSync(new URL('../oracle.json', import.meta.url), 'utf8')), degrade = 'none' }) {
  let ctx = { caseId: null, turn: 0 };
  const byId = new Map(cases.map((c) => [c.id, c]));
  const expectedOf = () => { const c = byId.get(ctx.caseId); const last = ctx.turn === c.turns.length - 1; return last ? c.expected : (c.turns[ctx.turn].expected ?? {}); };

  return {
    name: `oracle${degrade === 'none' ? '' : `:${degrade}`}`,
    setContext(caseId, turn) { ctx = { caseId, turn }; },
    async plan() {
      const plan = JSON.parse(JSON.stringify(plans[ctx.caseId][ctx.turn]));
      if (degrade === 'forgetPremises') plan.premises = [];
      if (degrade === 'overClarify') return { premises: [], clarification: { text: 'Pouvez-vous préciser votre question ?' } };
      if (degrade === 'wrongTools' && plan.toolCalls) plan.toolCalls = [{ tool: 'get_categories', args: {} }];
      return plan;
    },
    async explain({ facts, premises }) {
      const exp = expectedOf(); const claims = [];
      const factFor = (q) => facts.find((f) => (q.kind === 'date' ? f.unit === 'date' && f.value === q.value : typeof f.value === 'number' && (q.kind === 'percent' ? f.unit === 'ratio' && Math.round(f.value * 10000) / 100 === q.value : q.kind === 'money' ? /^[A-Z]{3}$/.test(f.unit) && Math.round(f.value * 100) / 100 === q.value : f.unit === (q.kind === 'days' ? 'days' : 'count') && f.value === q.value)));
      for (const q of exp.quantities ?? []) {
        const f = factFor(q); if (!f) continue;
        const text = q.kind === 'money' ? `Valeur : ${fmt(q.value)} €.` : q.kind === 'percent' ? `Évolution : ${fmt(q.value)} %.` : q.kind === 'date' ? `Date : ${q.value}.` : `Nombre : ${q.value}.`;
        claims.push({ kind: 'fact', text, factRefs: [f.ref], quantities: [{ kind: q.kind, value: q.value, factRef: f.ref }] });
      }
      for (const label of exp.labels ?? []) { const f = facts.find((x) => x.unit === 'text' && String(x.value).toLowerCase() === label.toLowerCase()); if (f) claims.push({ kind: 'fact', text: `Le premier est « ${label} ».`, factRefs: [f.ref] }); }
      if (!claims.length) {                                   // nothing specific expected: say the first figure the tools returned
        const f = facts.find((x) => typeof x.value === 'number' && (x.unit === 'count' || /^[A-Z]{3}$/.test(x.unit)));
        if (f) claims.push({ kind: 'fact', text: /^[A-Z]{3}$/.test(f.unit) ? `Valeur : ${fmt(Math.round(f.value * 100) / 100)} €.` : `Nombre : ${f.value}.`, factRefs: [f.ref], quantities: [{ kind: /^[A-Z]{3}$/.test(f.unit) ? 'money' : 'count', value: /^[A-Z]{3}$/.test(f.unit) ? Math.round(f.value * 100) / 100 : f.value, factRef: f.ref }] });
        else claims.push({ kind: 'fact', text: 'Voici les faits disponibles.', factRefs: [facts[0].ref] });
      }
      const hypotheses = [];
      if (exp.hypotheses === 'allowed' && (premises ?? []).every((p) => p.verdict === 'supported')) { const l = facts.find((x) => x.unit === 'text'); if (l) hypotheses.push({ text: `Une cause possible est le poids du produit « ${l.value} ».`, factRefs: [l.ref], confidence: 'low' }); }
      if (degrade === 'hallucinate') { const f = facts.find((x) => x.unit === 'ratio') ?? facts[0]; claims.unshift({ kind: 'fact', text: 'Croissance de 52 %.', factRefs: [f.ref], quantities: [{ kind: 'percent', value: 52, factRef: f.ref }] }); }
      return { claims, hypotheses };
    },
  };
}
