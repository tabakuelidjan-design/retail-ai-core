// Report generator of the ASR physical benchmark: scores every stored run of a session, computes the context lift and the verdicts, and writes ONE markdown report (+ the scored JSON).
// It never states "production ready": REJECT / PROMISING / STRONG CANDIDATE, and NO WINNER when nothing is STRONG.
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { scoreRun, contextLift, verdict, overall, GATES } from './score.mjs';
import { loadCanonical } from './canonical.mjs';
import { PROVIDER_META } from './provider.mjs';
import { KEY_REFERENCES, syntheticIdentifiers } from './corpus.mjs';

const pct = (r) => (r === null || r === undefined ? 'n/a' : `${Math.round(r * 1000) / 10}%`);
const frac = (a) => `${a.ok}/${a.n} (${pct(a.rate)})`;

export function loadRuns(root, session) {
  const dir = join(root, 'asr-results', session); if (!existsSync(dir)) return []; const latest = new Map();
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) { const r = JSON.parse(readFileSync(join(dir, f), 'utf8')); latest.set(`${r.provider}|${r.pass}`, { ...r, file: f }); }
  return [...latest.values()];
}
export function buildReport({ canonicalDir, runs, knownCatalogue = true }) {
  const c = loadCanonical(canonicalDir); const knownSets = { key: [...KEY_REFERENCES], catalogue: knownCatalogue ? [...KEY_REFERENCES, ...syntheticIdentifiers(c.script.seed).map((s) => s.id)] : null };
  const scored = runs.map((r) => ({ run: r, score: scoreRun({ script: c.script, windows: c.windows, references: c.references, result: r, knownSets }) }));
  const by = (p, pass) => scored.find((s) => s.run.provider === p && s.run.pass === pass)?.score; const providers = [...new Set(runs.map((r) => r.provider))];
  const verdicts = providers.map((p) => ({ provider: p, ...(by(p, 'B') ? verdict(by(p, 'B'), by(p, 'A')) : { verdict: 'NOT RUN (PASS B missing)', reasons: [] }), lift: by(p, 'A') && by(p, 'B') ? contextLift(by(p, 'A'), by(p, 'B')) : null }));
  const L = []; const P = (s = '') => L.push(s);
  P(`# ASR physical benchmark: ${c.meta.session}`); P();
  P(`- Canonical recording: **${c.meta.audio.durationSec} s**, ${c.meta.audio.sampleRate} Hz, ${c.meta.audio.channels} ch, ${c.meta.audio.format}; sha256 \`${c.meta.audio.sha256}\``); P(`- Derived for providers: 16 kHz mono PCM16, sha256 \`${c.meta.derivedForProviders.sha256}\` (${c.meta.derivedForProviders.transformation.steps.join('; ')})`); P(`- Device: ${JSON.stringify(c.meta.device)} · browser audio processing: ${JSON.stringify(c.meta.browserAudioProcessing)}`); P(`- Script: ${c.script.items.length} items, ${KEY_REFERENCES.length} key references + ${syntheticIdentifiers(c.script.seed).length} synthetic identifiers (never part of a provider context)`);
  P(`- Natural-speech references: ${Object.keys(c.references).length ? 'provided by the owner' : '**MISSING: natural speech is not scored without them**'}`); P(`- Gates (fixed before the first run): ${JSON.stringify(GATES.strong)}`); P();
  P('## Verdicts'); P('| provider | verdict | key references exact (PASS B) | critical facts (PASS B) | silence/noise hallucination | loops | errors |'); P('|---|---|---|---|---|---|---|');
  for (const v of verdicts) { const b = by(v.provider, 'B'); P(`| ${v.provider} | **${v.verdict}** | ${b ? frac(b.metrics.identifiers.keyReferences) : '-'} | ${b ? frac(b.metrics.criticalFacts.overall) : '-'} | ${b ? `${b.metrics.hallucination.events} events / ${b.metrics.hallucination.words} words` : '-'} | ${b ? b.metrics.stability.loops : '-'} | ${b ? b.metrics.stability.errors : '-'} |`); }
  P(); P(`**Overall: ${overall(verdicts.map((v) => v.verdict))}.** No engine is declared production-ready by this benchmark.`); P();
  P('## Raw ASR vs resolved identifier candidates (different metrics)'); P('| provider | pass | raw: key references exact | raw: synthetic exact | resolved (known = 5 key refs): key refs | confident-wrong proposals | false snaps on unknown refs | resolved (catalogue of 35 known) |'); P('|---|---|---|---|---|---|---|---|');
  for (const s of scored) { const m = s.score.metrics; P(`| ${s.run.provider} | ${s.run.pass} | ${frac(m.identifiers.keyReferences)} | ${frac(m.identifiers.synthetic)} | ${frac(m.resolved.keyReferences)} | ${m.resolved.confidentWrongKey} | ${m.resolved.falseSnapOnUnknown} | ${m.resolved.catalogue ? frac(m.resolved.catalogue) : 'n/a'} |`); }
  P(); P('Resolved candidates are proposals to confirm (source KNOWN_NEAR); the ASR text was never rewritten.'); P();
  P('## Critical sourcing facts'); P('| provider | pass | overall | by type |'); P('|---|---|---|---|');
  for (const s of scored) P(`| ${s.run.provider} | ${s.run.pass} | ${frac(s.score.metrics.criticalFacts.overall)} | ${Object.entries(s.score.metrics.criticalFacts.byType).map(([k, v]) => `${k} ${v.ok}/${v.n}`).join(', ')} |`);
  P(); P('## Context lift (PASS B minus PASS A; for WER and hallucinations negative is better)'); P('| provider | key refs exact | critical facts | resolved key refs | natural WER | hallucinated words | synthetic refs (spillover) |'); P('|---|---|---|---|---|---|---|');
  for (const v of verdicts) if (v.lift) P(`| ${v.provider} | ${pct(v.lift.keyReferenceExact)} | ${pct(v.lift.criticalFacts)} | ${pct(v.lift.resolvedKey)} | ${pct(v.lift.naturalWer)} | ${v.lift.hallucinatedWords} | ${pct(v.lift.syntheticExactSpillover)} |`);
  P(); P('## Natural speech, hallucination, stability, latency'); P('| provider | pass | natural WER | meaning errors (manual) | silence words/min | segments/min | words/segment | lag median / p90 (ms) |'); P('|---|---|---|---|---|---|---|---|');
  for (const s of scored) { const m = s.score.metrics; P(`| ${s.run.provider} | ${s.run.pass} | ${pct(m.natural.wer)} (${m.natural.errors}/${m.natural.refWords}) | to classify below | ${m.hallucination.wordsPerMinute ?? 'n/a'} | ${m.stability.segmentsPerMinute} | ${m.stability.wordsPerSegmentMedian ?? 'n/a'} | ${m.latency.lagMsMedian ?? 'n/a'} / ${m.latency.lagMsP90 ?? 'n/a'} |`); }
  P(); P('## Key references: expected vs heard (raw ASR, no correction)'); for (const s of scored) { P(`### ${s.run.provider} PASS ${s.run.pass}`); P('| item | expected | heard | exact | resolved candidate |'); P('|---|---|---|---|---|'); for (const r of s.score.items.filter((x) => x.identifier?.isKey)) P(`| ${r.id} | ${r.identifier.expected} | ${r.heard || '(nothing)'} | ${r.identifier.rawCorrect ? 'yes' : 'NO'} | ${r.identifier.resolvedKey.top ?? '-'}${r.identifier.resolvedKey.confidentWrong ? ' (WRONG)' : ''} |`); P(); }
  P('## Natural speech: reference vs heard (classify material meaning errors by hand)'); for (const s of scored) { P(`### ${s.run.provider} PASS ${s.run.pass}`); for (const r of s.score.items.filter((x) => x.natural && !x.natural.referenceMissing)) { P(`- **${r.id}** WER ${pct(r.natural.wer)}`); P(`  - reference: ${r.natural.reference}`); P(`  - heard: ${r.heard || '(nothing)'}`); } P(); }
  P('## Silence / noise windows (anything recognised here is hallucination)'); for (const s of scored) for (const h of s.score.metrics.hallucination.samples) P(`- ${s.run.provider} PASS ${s.run.pass} ${h.id}: "${h.text}"`); P();
  P('## Data flow, privacy and China (VERIFIED / DOCUMENTED CLAIM / UNKNOWN: unknown stays unknown)'); P('| provider | execution | audio destination | retention | training | DPA | EU endpoint | China access | account | pricing |'); P('|---|---|---|---|---|---|---|---|---|---|');
  for (const p of providers) { const m = PROVIDER_META[p]; const f = (x) => `${x.v} [${x.label}]`; P(`| ${p} | ${f(m.executionLocation)} | ${f(m.audioDestination)} | ${f(m.retention)} | ${f(m.training)} | ${f(m.dpa)} | ${f(m.euEndpoint)} | ${f(m.chinaAccess)} | ${f(m.account)} | ${f(m.pricing)} |`); }
  P(); P('## Context actually sent'); for (const r of runs) P(`- ${r.provider} PASS ${r.pass}: ${r.contextApplied?.mechanism ?? 'none'} - \`${JSON.stringify(r.contextApplied?.payload ?? {}).slice(0, 600)}\``);
  return { markdown: L.join('\n'), scored, verdicts };
}
export function writeReport(root, session) {
  const dir = join(root, 'canonical', session); const out = buildReport({ canonicalDir: dir, runs: loadRuns(root, session) }); const base = join(root, 'asr-results', session);
  writeFileSync(join(base, 'report.md'), out.markdown); writeFileSync(join(base, 'scored.json'), JSON.stringify({ verdicts: out.verdicts, scored: out.scored.map((s) => s.score) }, null, 1)); return { file: join(base, 'report.md'), overall: overall(out.verdicts.map((v) => v.verdict)), verdicts: out.verdicts.map((v) => `${v.provider}: ${v.verdict}`) };
}
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('asr-bench/report.mjs')) {
  const session = process.argv[2]; if (!session) { console.log('usage: node tools/asr-bench/report.mjs <session>'); process.exit(2); }
  const root = process.env.VOICE_BENCH_DATA ?? new URL('../../data/local/voice-bench', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'); const r = writeReport(root, session); console.log(r.verdicts.join('\n')); console.log(`overall: ${r.overall}\nreport: ${r.file}`);
}
