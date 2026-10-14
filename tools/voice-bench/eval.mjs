// Voice benchmark EVALUATION (Node, offline). Input: raw engine transcripts produced by the bench page. It measures the WHOLE chain with the REAL Nordla modules, and keeps two families of metrics apart:
//   TRANSCRIPTION (information only): normalised word error rate.
//   NORDLA UTILITY (decisive): numbers/facts understood, current topic, ASK NEXT correct and non-redundant, contradiction and spontaneous-answer handling.
// A transcript that is textually imperfect may PASS if the needed facts and the ASK NEXT are right; a good transcript that leads to a wrong fact or a wrong ASK NEXT FAILS.
// Provenance is not part of what is measured here (it caps machine facts at MEDIUM and requires individual confirmation in production); this file measures UNDERSTANDING.
//   usage: node tools/voice-bench/eval.mjs <results/acc-*.json> [--lat <results/lat-*.json>] [--label "LAB/CONTROLLED"] [--out name]
import { readFileSync, writeFileSync } from 'node:fs';
import { normalizeNumbers, wer } from './normalize.mjs';
import { extractFacts } from '../../src/sourcing/core/extract/index.js';
import { dispatch } from '../../src/sourcing/core/case.js';
import { currentTopic } from '../../src/sourcing/core/topics.js';
import { planContext } from '../../src/sourcing/core/context-engine.js';
import { classifyCandidates } from '../../src/sourcing/core/understanding.js';
import { NOW, build, run, importer } from '../../test/sourcing-fixtures.js';

const REPO = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const args = process.argv.slice(2); const file = args[0]; const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const latFile = opt('--lat'); const label = opt('--label') ?? 'LAB/CONTROLLED'; const outName = opt('--out') ?? 'eval';
const utter = JSON.parse(readFileSync(`${REPO}tools/voice-bench/corpus/utterances.json`, 'utf8')); const ITEMS = [...utter.items, ...utter.scenarioB]; const byId = Object.fromEntries(ITEMS.map((i) => [i.id, i]));
const res = JSON.parse(readFileSync(file, 'utf8'));
const CATEGORY = (k) => (k === 'quote.moq' ? 'MOQ' : k === 'quote.tiers' || k === 'quote.unitPrice' ? 'PRICE/TIERS' : k === 'quote.currency' ? 'CURRENCY' : k === 'quote.incoterm' || k === 'quote.port' ? 'INCOTERM' : k === 'quote.leadTime' ? 'LEAD TIME' : k.startsWith('payment.') ? 'PAYMENT' : k.startsWith('variant.') || k.startsWith('moq.') ? 'COLOURS' : k === 'identifier.model' ? 'MODEL REF' : k.startsWith('docClaim.') ? 'CE/ROHS/UN38.3 CLAIMS' : 'OTHER');

// ---- value normalisation so that "7.2" = "7.20", "PBX200" = "PB-X200" ---------------------------------------------------------------------------------------------------------
const num = (v) => (Number.isFinite(Number(v)) && String(v).trim() !== '' ? String(Number(v)) : String(v));
const normVal = (key, v) => {
  if (key === 'quote.tiers') { const arr = Array.isArray(v) ? v : String(v).split(';').map((p) => { const [q, u] = p.split('='); return { minQty: q, unitPrice: u }; }); return arr.map((t) => `${num(t.minQty)}=${num(t.unitPrice)}`).sort().join(';'); }
  if (key === 'quote.leadTime') return num(typeof v === 'object' ? v.min : v);
  if (key === 'variant.colours') return (Array.isArray(v) ? v : String(v).split(',')).map((x) => String(x).toLowerCase().trim()).sort().join(',');
  if (key === 'identifier.model') return String(v).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (typeof v === 'boolean') return String(v);
  return num(String(v).trim());
};
const candsOf = (text) => extractFacts({ text, lang: 'en' }).candidates.map((c) => ({ key: c.key, value: c.correctedValue ?? c.value, confidence: c.confidence, norm: normVal(c.key, c.correctedValue ?? c.value) }));

function understandOne(item, hypothesis) {
  const text = normalizeNumbers(hypothesis); const cands = candsOf(text); const truth = item.facts ?? []; const extras = item.allowedExtra ?? []; const notF = item.notFacts ?? [];
  const found = []; const missed = []; const wrong = []; const spurious = [];
  for (const [k, v] of truth) { const nv = normVal(k, v); if (cands.some((c) => c.key === k && c.norm === nv)) found.push(k); else if (cands.some((c) => c.key === k)) { wrong.push({ key: k, expected: nv, got: cands.filter((c) => c.key === k).map((c) => c.norm) }); } else missed.push(k); }
  const known = new Set([...truth.map(([k]) => k), ...extras.map(([k]) => k)]);
  for (const c of cands) { if (c.confidence === 'LOW') continue; if (!known.has(c.key)) spurious.push(c.key); }
  const violated = notF.filter(([k]) => cands.some((c) => c.key === k && c.confidence !== 'LOW')).map(([k]) => k);
  const factsOk = truth.length === 0 ? spurious.length === 0 : missed.length === 0 && wrong.length === 0 && violated.length === 0;
  return { text, cands, found, missed, wrong, spurious, violated, factsOk, truthN: truth.length };
}
const topicOf = (text, who) => { let s = build([{ type: 'NAME', name: 'Power bank' }, { type: 'CATEGORY', category: 'power_bank' }, ...importer]); s = dispatch(s, { type: 'CONVERSATION_START', supplierRef: 'bench', lang: 'auto' }, NOW); s = dispatch(s, { type: 'CONVERSATION_ITEM', convId: 'conv-1', speaker: who === 'owner' ? 'me' : 'supplier', lang: 'en', text: text || '(nothing)' }, NOW); return currentTopic(s).id; };

// ---- per-utterance metrics ---------------------------------------------------------------------------------------------------------------------------------------------------------
const rows = []; const byKey = {};
for (const r of res.runs) {
  const item = byId[r.id]; if (!item) continue; const u = understandOne(item, r.text); const w = wer(item.spoken, r.text); const topic = topicOf(u.text, item.who);
  const row = { engine: r.engine, cond: r.cond, id: r.id, who: item.who, text: r.text, normText: u.text, wer: +w.wer.toFixed(3), factsOk: u.factsOk, found: u.found.length, truthN: u.truthN, missed: u.missed, wrong: u.wrong, spurious: u.spurious, violated: u.violated, topicTruth: item.topic, topic, topicOk: topic === item.topic || (item.topicAlt ?? []).includes(topic), useful: u.factsOk && (topic === item.topic || (item.topicAlt ?? []).includes(topic)) };
  rows.push(row); (byKey[`${r.engine}|${r.cond}`] ??= []).push(row);
}

// ---- scenario replay: ASK NEXT, contradiction, spontaneous answer ----------------------------------------------------------------------------------------------------------------
function replay(engine, cond) {
  const get = (id) => rows.find((x) => x.engine === engine && x.cond === cond && x.id === id); const checks = [];
  let s = build([{ type: 'NAME', name: 'Power bank' }, { type: 'CATEGORY', category: 'power_bank' }, ...importer]); s = dispatch(s, { type: 'CONVERSATION_START', supplierRef: 'bench', lang: 'auto' }, NOW);
  for (const it of utter.items) {
    const r = get(it.id); if (!r) return null; const at = new Date(NOW.getTime() + 1000 * (1 + utter.items.indexOf(it)));
    try { s = dispatch(s, { type: 'CONVERSATION_ITEM', convId: 'conv-1', speaker: it.who === 'owner' ? 'me' : 'supplier', lang: 'en', text: r.normText || '(nothing)' }, at); } catch { return null; }
    if (it.who !== 'supplier') continue; const ctx = planContext(s, run(s)); const sug = ctx.suggestion?.id ?? null;
    if (it.askNextExpected) checks.push({ id: it.id, kind: 'ASK NEXT expected', want: it.askNextExpected, got: sug, ok: it.askNextExpected.includes(sug) });
    if (it.askNextForbidden) checks.push({ id: it.id, kind: 'ASK NEXT not redundant', forbidden: it.askNextForbidden, got: sug, ok: !it.askNextForbidden.includes(sug) });
    if (it.contradiction) { const cl = classifyCandidates(s); const dup = cl.attention.some((a) => a.candidate.key === it.contradiction.key && ['DUPLICATE', 'CONFLICT'].includes(a.reason)); const al = ctx.alerts.some((a) => a.kind === 'CONFLICT'); checks.push({ id: it.id, kind: 'contradiction detected', ok: dup || al, via: al ? 'alert' : dup ? 'duplicate values' : 'none' }); }
  }
  // scenario B: a single price tier must lead to "ask the other tiers"
  const b = get('B1'); if (b) { let t = build([{ type: 'NAME', name: 'Power bank' }, { type: 'CATEGORY', category: 'power_bank' }, ...importer]); t = dispatch(t, { type: 'CONVERSATION_START', supplierRef: 'bench', lang: 'auto' }, NOW); t = dispatch(t, { type: 'CONVERSATION_ITEM', convId: 'conv-1', speaker: 'supplier', lang: 'en', text: b.normText || '(nothing)' }, NOW); const sug = planContext(t, run(t)).suggestion?.id ?? null; checks.push({ id: 'B1', kind: 'ASK NEXT expected', want: ['s:price_tiers'], got: sug, ok: sug === 's:price_tiers' }); }
  return checks;
}

// ---- aggregation --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const pct = (a, b) => (b ? Math.round((100 * a) / b) : null); const fmt = (x) => (x === null ? 'n/a' : `${x}%`);
const summary = {}; const lines = [];
lines.push(`# Voice bench evaluation (${label})`, '', `Source: ${file.split(/[\\/]/).pop()} ; engines: ${[...new Set(res.runs.map((r) => r.engine))].join(', ')} ; conditions: ${[...new Set(res.runs.map((r) => r.cond))].join(', ')}`, '');
lines.push('| engine | condition | WER (info) | numbers/facts per category (found/expected) | topic | useful utterances (facts AND topic) | ASK NEXT ok | contradiction | spurious facts |', '|---|---|---|---|---|---|---|---|---|');
for (const [key, rs] of Object.entries(byKey)) {
  const [engine, cond] = key.split('|'); const sup = rs.filter((r) => r.who === 'supplier' || r.id.startsWith('B')); const cat = {};
  for (const r of rs) { const item = byId[r.id]; for (const [k] of item.facts) { const c = CATEGORY(k); cat[c] ??= [0, 0]; cat[c][1]++; if (r.found && !r.missed.includes(k) && !r.wrong.some((w) => w.key === k)) cat[c][0]++; } }
  const catTxt = Object.entries(cat).map(([c, [a, b]]) => `${c} ${a}/${b}`).join('; '); const werAvg = rs.reduce((s, r) => s + r.wer, 0) / rs.length; const topicAcc = pct(rs.filter((r) => r.topicOk).length, rs.length); const useful = pct(sup.filter((r) => r.useful).length, sup.length);
  const checks = replay(engine, cond); const askOk = checks ? `${checks.filter((c) => c.kind.startsWith('ASK') && c.ok).length}/${checks.filter((c) => c.kind.startsWith('ASK')).length}` : 'n/a'; const contra = checks ? (checks.find((c) => c.kind === 'contradiction detected')?.ok ? 'yes' : 'NO') : 'n/a'; const spur = rs.reduce((s, r) => s + r.spurious.length, 0);
  summary[key] = { wer: +werAvg.toFixed(3), categories: cat, topicAcc, usefulPct: useful, askNext: askOk, contradiction: contra, spurious: spur, checks, nUtterances: rs.length };
  lines.push(`| ${engine} | ${cond} | ${(werAvg * 100).toFixed(0)}% | ${catTxt} | ${fmt(topicAcc)} | ${fmt(useful)} | ${askOk} | ${contra} | ${spur} |`);
}
// the two dissociations the owner asked for
const sup = rows.filter((r) => r.who === 'supplier' || r.id.startsWith('B')); const badWerPass = sup.filter((r) => r.wer > 0.2 && r.useful); const goodWerFail = sup.filter((r) => r.wer <= 0.2 && !r.useful);
lines.push('', `## Dissociation WER / utility (supplier utterances)`, '', `- Imperfect transcription (WER above 20 %) that still PASSES on Nordla utility: ${badWerPass.length} of ${sup.length}`, `- Good transcription (WER at most 20 %) that FAILS on Nordla utility: ${goodWerFail.length} of ${sup.length}`);
if (goodWerFail.length) lines.push('', '| engine | cond | id | WER | what failed |', '|---|---|---|---|---|', ...goodWerFail.slice(0, 25).map((r) => `| ${r.engine} | ${r.cond} | ${r.id} | ${(r.wer * 100).toFixed(0)}% | ${[r.missed.length ? 'missed ' + r.missed.join(',') : '', r.wrong.length ? 'wrong ' + r.wrong.map((w) => `${w.key}=${w.got}`).join(',') : '', r.violated.length ? 'claim ' + r.violated.join(',') : '', r.spurious.length ? 'spurious ' + r.spurious.join(',') : '', !r.topicOk ? `topic ${r.topic}≠${r.topicTruth}` : ''].filter(Boolean).join('; ')} |`));
// latency (real-time runs)
if (latFile) { const lat = JSON.parse(readFileSync(latFile, 'utf8')); const by = {}; for (const r of lat.runs) { if (!byId[r.id] || byId[r.id].who !== 'supplier') continue; (by[r.engine] ??= []).push(r); }
  lines.push('', '## Latency, real-time replay of the clean clips (supplier utterances; milliseconds after the end of the phrase)', '', '| engine | utterances | first partial (median) | final text median / p90 | speed factor (CPU time / audio time) | suggestion shown (final + 1.5 s quiet, median) |', '|---|---|---|---|---|---|');
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; }; const p90 = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(0.9 * s.length))] : null; };
  for (const [e, rs] of Object.entries(by)) { const f = rs.map((r) => r.finalMs).filter((x) => x != null); const p = rs.map((r) => r.firstPartialMs).filter((x) => x != null); const rtf = rs.map((r) => r.rtf); summary[`${e}|latency`] = { n: rs.length, firstPartialMedian: med(p), finalMedian: med(f), finalP90: p90(f), rtfMedian: med(rtf), suggestionMedian: med(f) != null ? med(f) + 1500 : null }; lines.push(`| ${e} | ${rs.length} | ${med(p) ?? 'n/a'} | ${med(f) ?? 'n/a'} / ${p90(f) ?? 'n/a'} | ${med(rtf)} | ${med(f) != null ? med(f) + 1500 : 'n/a'} |`); } }
writeFileSync(`${REPO}data/local/voice-bench/results/${outName}.json`, JSON.stringify({ label, file, summary, rows }, null, 1)); writeFileSync(`${REPO}data/local/voice-bench/results/${outName}.md`, lines.join('\n') + '\n'); console.log(lines.join('\n'));
