// TEST-ONLY fake AI provider implementing the Nordla provider contract { name, plan, explain }. It stands in for a model: NO real provider exists in this phase.
// The question -> tools mapping below lives ONLY here (a stand-in for a model's understanding); the business code has no such rules.

const fmt = (n) => Number(n).toFixed(2).replace('.', ',');
const has = (q, re) => re.test(q.toLowerCase());

/** The fake "model": understands a handful of test questions and answers with tool calls or a clarification. */
export function defaultPlanner({ question, history, selectedPeriod, turn, previousCalls }) {
  const q = question;
  if (has(q, /pourquoi.*(baiss|recul)/)) return { toolCalls: [
    { tool: 'get_sales_metrics', args: { period: { period: 'last_30_days' } } },
    { tool: 'compare_sales', args: { periodA: { period: 'last_30_days' }, periodB: { period: 'previous_month' } } },
    { tool: 'get_top_products', args: { period: { period: 'last_30_days' }, sort: 'revenue', limit: 3 } },
    { tool: 'get_channels', args: { period: { period: 'last_30_days' } } }] };
  // any other "why" question: the same cause analysis (the fake model would happily run it - the premise guard is what must stop it when the premise is false)
  if (has(q, /pourquoi/)) return { toolCalls: [
    { tool: 'get_sales_metrics', args: { period: { period: 'last_30_days' } } },
    { tool: 'get_top_products', args: { period: { period: 'last_30_days' }, sort: 'revenue', limit: 3 } },
    { tool: 'get_channels', args: { period: { period: 'last_30_days' } } }] };
  if (has(q, /remboursements?.*(expliquent|baisse)/)) {
    if (turn === 1) return { toolCalls: [{ tool: 'get_sales_metrics', args: { period: { period: 'last_30_days' } } }], more: true };
    return { toolCalls: [{ tool: 'get_sales_metrics', args: { period: { period: 'previous_month' } } }] };   // second turn: it saw only "call 1 ok"
  }
  if (has(q, /et le mois dernier/) && history.some((h) => /meilleur produit/i.test(h.text))) return { toolCalls: [{ tool: 'get_top_products', args: { period: { period: 'previous_month' }, limit: 1 } }] };
  if (has(q, /meilleur produit/)) return { toolCalls: [{ tool: 'get_top_products', args: { ...(selectedPeriod ? {} : { period: { period: 'this_month' } }), limit: 1 } }] };
  if (has(q, /trafic|visites|publicit/)) return { cannotAnswer: { gaps: ['traffic', 'ad_spend'] } };
  if (has(q, /devine|prédis|prevois|prévois/)) return { cannotAnswer: {} };
  if (has(q, /marge/)) return { toolCalls: [{ tool: 'get_sales_metrics', args: {} }] };
  if (has(q, /corr[eé]l/)) return { toolCalls: [{ tool: 'get_sales_metrics', args: {} }, { tool: 'get_top_products', args: { limit: 3 } }] };
  if (has(q, /chiffre d.affaires|ventes/)) return { toolCalls: [{ tool: 'get_sales_metrics', args: {} }] };
  if (has(q, /aide|truc|machin/)) return { clarification: { text: 'Sur quelle période et quel indicateur voulez-vous des précisions ?' } };
  return { done: true };
}

const find = (facts, re) => facts.find((f) => re.test(f.ref));

/** Builds a structured, honest explanation from the facts it is given (never from anything else). */
export function honestExplanation(facts) {
  const claims = []; const q = (kind, value, factRef) => ({ kind, value, factRef });
  const net = find(facts, /^c1\.values\.net_sales_ex_tax$/); const from = find(facts, /^c1\.period\.from$/); const to = find(facts, /^c1\.period\.to$/);
  const dpct = find(facts, /^c\d+\.comparison\.net_sales_ex_tax\.delta_pct$/);
  const orders = find(facts, /^c1\.values\.order_count$/);
  if (net && from && to) claims.push({ text: `Du ${from.value} au ${to.value}, le chiffre d'affaires net est de ${fmt(net.value)} €.`, factRefs: [net.ref, from.ref, to.ref], quantities: [q('money', Number(net.value.toFixed(2)), net.ref), q('date', from.value, from.ref), q('date', to.value, to.ref)] });
  if (dpct) { const v = Number((dpct.value * 100).toFixed(2)); const cur = find(facts, /^c\d+\.comparison\.net_sales_ex_tax\.current$/); claims.push({ kind: 'comparison', text: `Le chiffre d'affaires net évolue de ${fmt(v)} % par rapport à la période de référence.`, factRefs: [dpct.ref, ...(cur ? [cur.ref] : [])], quantities: [q('percent', v, dpct.ref)] }); }
  if (orders) claims.push({ text: `Il y a ${orders.value} commandes sur la période.`, factRefs: [orders.ref], quantities: [q('count', orders.value, orders.ref)] });
  const top = find(facts, /^c\d+\.items\.0\.label$/);
  if (top) claims.push({ kind: 'fact', text: `Le premier produit est « ${top.value} ».`, factRefs: [top.ref] });
  if (!claims.length) { const any = facts[0]; claims.push({ text: 'Voici les faits disponibles.', factRefs: [any.ref] }); }
  const hypotheses = top ? [{ text: `Une cause possible est le poids du produit « ${top.value} » dans les ventes.`, factRefs: [top.ref], confidence: 'low' }] : [];
  return { answer: claims.map((c) => c.text).join(' '), claims, hypotheses };
}

/** Explanation variants used to prove that the verifier blocks what it must block. `facts` are the ones the provider received. */
export function explanationFor(mode, facts) {
  const base = honestExplanation(facts);
  const dpct = find(facts, /^c\d+\.comparison\.net_sales_ex_tax\.delta_pct$/); const net = find(facts, /^c1\.values\.net_sales_ex_tax$/); const orders = find(facts, /^c1\.values\.order_count$/);
  const clone = () => JSON.parse(JSON.stringify(base));
  const pctClaim = (text, value, ref) => ({ text, factRefs: [ref], quantities: [{ kind: 'percent', value, factRef: ref }] });
  switch (mode) {
    case 'honest': return base;
    case 'sneaky-answer': { const e = clone(); e.answer = 'Les ventes ont explosé, du jamais vu.'; return e; }
    case 'margin': {
      const gm = find(facts, /^c1\.values\.gross_margin$/); const e = clone();
      if (gm) { const v = Number((gm.value * 100).toFixed(2)); e.claims.push({ kind: 'fact', text: `La marge brute est de ${fmt(v)} %.`, factRefs: [gm.ref], quantities: [{ kind: 'percent', value: v, factRef: gm.ref }] }); }
      return e;
    }
    case 'correlation': {
      const e = clone(); const a = find(facts, /^c1\.values\.net_sales_ex_tax$/); const b = find(facts, /^c2\.items\.0\.label$/);
      e.claims.push({ kind: 'correlation', text: `Les ventes et le produit « ${b.value} » évoluent ensemble sur la période.`, factRefs: [a.ref, b.ref] }); return e;
    }
    case 'bad-correlation': { const e = clone(); const a = find(facts, /^c1\.values\.net_sales_ex_tax$/); e.claims = [{ kind: 'correlation', text: 'Deux choses évoluent ensemble.', factRefs: [a.ref] }]; return e; }
    case 'bad-comparison': { const e = clone(); const a = find(facts, /^c1\.values\.net_sales_ex_tax$/); e.claims = [{ kind: 'comparison', text: 'Une seule valeur comparée.', factRefs: [a.ref] }]; return e; }
    case 'causal-claim': { const e = clone(); const a = find(facts, /^c1\.values\.net_sales_ex_tax$/); e.claims = [{ kind: 'fact', text: 'Les ventes baissent à cause de la météo.', factRefs: [a.ref] }]; return e; }
    case 'invent-percent': { const e = clone(); e.claims = [pctClaim('Le chiffre d\'affaires a progressé de 52 %.', 52, dpct.ref)]; e.answer = e.claims[0].text; e.hypotheses = []; return e; }
    case 'invent-in-text': { const e = clone(); e.claims = [{ text: 'Le chiffre d\'affaires a progressé de 52 %.', factRefs: [dpct.ref], quantities: [{ kind: 'percent', value: Number((dpct.value * 100).toFixed(2)), factRef: dpct.ref }] }]; e.answer = 'Croissance forte.'; e.hypotheses = []; return e; }
    case 'no-ref': { const e = clone(); e.claims = [{ text: 'Les ventes vont très bien.', factRefs: [] }]; e.answer = 'Les ventes vont très bien.'; return e; }
    case 'unknown-ref': { const e = clone(); e.claims = [{ text: 'Les ventes évoluent.', factRefs: ['c9.values.net_sales_ex_tax'] }]; e.answer = 'Les ventes évoluent.'; return e; }
    case 'wrong-unit': { const e = clone(); e.claims = [{ text: `Le CA est de ${orders.value} €.`, factRefs: [orders.ref], quantities: [{ kind: 'money', value: orders.value, factRef: orders.ref }] }]; e.answer = e.claims[0].text; e.hypotheses = []; return e; }
    case 'wrong-sign': { const e = clone(); const v = Number((-dpct.value * 100).toFixed(2)); e.claims = [pctClaim(`Le CA change de ${fmt(Math.abs(v))} %.`, v, dpct.ref)]; e.answer = e.claims[0].text; e.hypotheses = []; return e; }
    case 'wrong-money': { const e = clone(); e.claims = [{ text: `Le CA net est de ${fmt(net.value + 1)} €.`, factRefs: [net.ref], quantities: [{ kind: 'money', value: Number((net.value + 1).toFixed(2)), factRef: net.ref }] }]; e.answer = e.claims[0].text; e.hypotheses = []; return e; }
    case 'wrong-date': { const e = clone(); const from = find(facts, /^c1\.period\.from$/); e.claims = [{ text: 'La période commence le 2026-01-01.', factRefs: [from.ref], quantities: [{ kind: 'date', value: '2026-01-01', factRef: from.ref }] }]; e.answer = e.claims[0].text; e.hypotheses = []; return e; }
    case 'date-in-text': { const e = clone(); const from = find(facts, /^c1\.period\.from$/); e.claims = [{ text: 'La période commence le 1er janvier 2026.', factRefs: [from.ref] }]; e.answer = e.claims[0].text; e.hypotheses = []; return e; }
    case 'answer-number': { const e = clone(); e.answer = `${e.answer} Soit 999 commandes au total.`; return e; }
    case 'invalid-shape': return { text: 'Le chiffre d\'affaires est de 1000 €.' };
    case 'hyp': {
      const e = clone(); const top = find(facts, /^c\d+\.items\.0\.label$/);
      e.hypotheses = [
        { text: `Une cause possible est le poids du produit « ${top.value} ».`, factRefs: [top.ref], confidence: 'low' },
        { text: 'Une cause possible est la météo.', factRefs: [], confidence: 'low' },
        { text: 'Une cause possible est une campagne inexistante.', factRefs: ['c1.values.campaign_spend'], confidence: 'medium' },
        { text: 'Une cause possible est un recul de 77 % des visites.', factRefs: [top.ref], confidence: 'medium' },
        { text: `La baisse est due à « ${top.value} ».`, factRefs: [top.ref], confidence: 'high' },
      ]; return e;
    }
    default: throw new Error(`unknown explanation mode ${mode}`);
  }
}

/** @param {{ planner?, explainMode?: string, planError?, explainError?: 'throw'|'hang' }} opts */
/**
 * The premise a "why" question takes for granted, as a fake model would state it in structure (test-only understanding; the business code has no such rules).
 * Only used when the fake is created with `declarePremises: true`.
 */
export function premisesFor(question) {
  const q = question.toLowerCase(); const out = [];
  if (/pourquoi.*ventes.*(baiss|recul)/.test(q)) out.push({ kind: 'trend', metric: 'sales', direction: 'decrease' });
  if (/pourquoi.*ventes.*(augment|hausse|progress)/.test(q)) out.push({ kind: 'trend', metric: 'sales', direction: 'increase' });
  if (/pourquoi.*remboursements.*(augment|hausse)/.test(q)) out.push({ kind: 'trend', metric: 'refunds', direction: 'increase' });
  if (/pourquoi.*panier moyen.*baiss/.test(q)) out.push({ kind: 'trend', metric: 'aov', direction: 'decrease' });
  if (/pourquoi.*remises.*(augment|hausse)/.test(q)) out.push({ kind: 'trend', metric: 'discounts', direction: 'increase' });
  if (/pourquoi.*tva.*([ée]lev|augment|hausse)/.test(q)) out.push({ kind: 'trend', metric: 'vat', direction: 'increase' });
  if (/pourquoi.*ventes.*nulles/.test(q)) out.push({ kind: 'level', metric: 'sales', level: 'zero' });
  const best = q.match(/pourquoi.*meilleur produit (?:est|c.est) (.+?)\s*\??$/);
  if (best) out.push({ kind: 'ranking', scope: 'product', subject: best[1] });
  return out;
}

export function createFakeProvider({ planner = defaultPlanner, explainMode = 'honest', planError = null, explainError = null, declarePremises = false } = {}) {
  const seen = { plan: [], explain: [] };
  const provider = {
    name: 'fake-test-provider', seen, lastExplanation: null,
    async plan(input) {
      const { signal, ...rest } = input; seen.plan.push(JSON.parse(JSON.stringify(rest)));
      if (planError === 'throw') throw new Error('secret provider failure: sk-live-123');
      if (planError === 'hang') await new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted'))));
      const plan = typeof planner === 'function' ? planner(input) : planner;
      const premises = declarePremises && plan?.toolCalls ? premisesFor(input.question) : [];
      return premises.length ? { ...plan, premises } : plan;
    },
    async explain(input) {
      const { signal, ...rest } = input; seen.explain.push(JSON.parse(JSON.stringify(rest)));
      if (explainError === 'throw') throw new Error('secret provider failure: sk-live-123');
      if (explainError === 'hang') await new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted'))));
      provider.lastExplanation = explanationFor(explainMode, input.facts);
      return provider.lastExplanation;
    },
  };
  return provider;
}
