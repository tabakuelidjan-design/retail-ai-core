// Nordla Growth - evaluation runner. It NEVER calls a network service: the only provider it uses is a capture stub that returns answers
// supplied in a file. A real provider's answers are produced elsewhere (an explicit, owner-approved step) and then graded here offline.
// It never prints a secret: provider configuration is reported by variable NAME only.

import { CASES, AGENT_CASE_COUNT } from './cases.js';
import { gradeAnswer } from './grade.js';
import { createAgentGateway } from '../agents/gateway.js';
import { AGENTS } from '../agents/registry.js';
import { FORBIDDEN_KEYS } from './remax-cases.js';
import { detectPersonalData } from '../agents/privacy.js';

const PROVIDER_VARS = ['GROWTH_AI_PROVIDER', 'GROWTH_AI_API_KEY', 'GROWTH_AI_MODEL'];

/** Which provider variables are set, by NAME. Never a value. */
export function providerVariableState(env = process.env) {
  return Object.fromEntries(PROVIDER_VARS.map((k) => [k, Boolean(String(env[k] ?? '').trim())]));
}

/** The case as the gateway's getters: available data, not connected (the server's marker), or unavailable (null). */
function gettersOf(c) {
  const out = {};
  for (const [k, v] of Object.entries(c.sources)) {
    if (v.status === 'available') out[k] = async () => v.data;
    else if (v.status === 'not_connected') out[k] = async () => ({ status: 'NOT_CONNECTED' });
    else out[k] = async () => null;
  }
  return out;
}

/** Structural checks on the cases themselves: every agent covered, sources the agent really reads, no personal format in the synthetic data. */
export function validateCases(cases = CASES) {
  const problems = [];
  for (const a of AGENTS) if ((AGENT_CASE_COUNT[a.id] ?? 0) < 3) problems.push(`${a.id}: fewer than 3 cases`);
  for (const c of cases) {
    const agent = AGENTS.find((a) => a.id === c.agent);
    if (!agent) { problems.push(`${c.id}: unknown agent`); continue; }
    for (const k of Object.keys(c.sources)) if (!agent.sources.includes(k)) problems.push(`${c.id}: source ${k} is not read by ${c.agent}`);
    if (detectPersonalData(JSON.stringify(c.sources) + c.question).length) problems.push(`${c.id}: personal format in synthetic data`);
    const keys = []; const walk = (v) => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { keys.push(k); walk(x); } };
    walk(c.sources);
    if (c.group === 'remax') {
      // REAL catalogue facts: public fields only, no purchase cost, margin, supplier, stock, sales or customer key, at any depth
      for (const k of keys) if (FORBIDDEN_KEYS.includes(k)) problems.push(`${c.id}: forbidden field ${k} in a REAL-catalogue case`);
      if (keys.includes('synthetic')) problems.push(`${c.id}: a synthetic block in a REAL-catalogue case`);
    }
    if (c.group === 'remax-synthetic') {
      // FICTIONAL figures: each case carries a block explicitly labelled FICTIF
      if (!keys.includes('synthetic') || !JSON.stringify(c.sources).includes('FICTIF')) problems.push(`${c.id}: fictional figures without the FICTIF label`);
    }
  }
  return problems;
}

/**
 * Grades answers offline. `answers` maps case id -> the model's answer (JSON text or object). Without answers nothing is graded:
 * the result says so, and no quality is claimed.
 */
export async function runEvaluation({ answers = null, env = process.env, cases = CASES } = {}) {
  const problems = validateCases(cases);
  const provider = providerVariableState(env);
  const configured = PROVIDER_VARS.every((k) => provider[k]);
  const result = { casesTotal: cases.length, agents: Object.keys(AGENT_CASE_COUNT).length, validation: { ok: problems.length === 0, problems }, provider: { configured, variables: provider }, graded: [], quality: 'NOT EVALUATED: no real provider answer was graded' };
  if (!answers) return result;
  for (const c of cases) {
    if (!(c.id in answers)) { result.graded.push({ id: c.id, agent: c.agent, missing: true }); continue; }
    let captured = null;
    const capture = { name: 'capture', model: 'offline', complete: async ({ user }) => { captured = user; return typeof answers[c.id] === 'string' ? answers[c.id] : JSON.stringify(answers[c.id]); } };
    const gw = createAgentGateway({ provider: capture, getters: gettersOf(c) });
    try { await gw.run({ agentId: c.agent, question: c.question, scope: `eval-${c.id}` }); } catch (e) { /* a refused answer is graded as failed below */ }
    const g = gradeAnswer(c, answers[c.id], captured ?? JSON.stringify(c.sources));
    result.graded.push({ ...g, promptHasPersonalData: detectPersonalData(captured ?? '').length > 0 });
  }
  const done = result.graded.filter((g) => !g.missing);
  result.quality = done.length ? `graded offline: ${done.length} of ${cases.length} cases` : result.quality;
  return result;
}
