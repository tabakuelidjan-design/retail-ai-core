// OFFLINE DIAGNOSTIC of a real trial's recorded answers, against the CURRENT contracts. No network, no cost, no new answer.
//   node scripts/creative-autonomy-replay.mjs --trial <trial outDir> --product gourde-noire --diag <new folder outside the trial and outside any repo>
//
// Safety: the trial folder is READ-ONLY for this script. Every file in it is hashed before and after; the script fails if any hash, any file count or the
// lock changed. The lock is never opened for writing, renamed or deleted. The recorded answers are COPIED into the diagnostic folder and only the copies
// are read for the replay. The replay port returns the recorded text whatever it is asked: if a stage would need another answer (a protocol repair, a
// contract repair, a stage that was never reached), the replay says so and stops there; it never invents one.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync, copyFileSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { createProblemFramer } from '../src/creative-brain/problem-frame.js';
import { createConceptDirector } from '../src/creative-brain/concept.js';
import { createConceptSelector } from '../src/creative-brain/concept-selection.js';
import { createArtDirector } from '../src/creative-brain/art-direction.js';
import { createStageDirector, HABB_ART_DIRECTION_HINT } from '../src/creative-autonomy/stage-contract.js';
import { assertConceptsHabbRules, assertArtDirectionGuard, assertStageGuard } from '../src/creative-autonomy/habb-guard.js';

const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : null; };
const trialDir = resolve(arg('trial')); const product = arg('product') ?? 'gourde-noire'; const diag = resolve(arg('diag'));
const inside = (root, p) => { const r = relative(root, p); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); };
const gitRoot = (p) => { let d = resolve(p); for (;;) { if (existsSync(join(d, '.git'))) return d; const u = dirname(d); if (u === d) return null; d = u; } };
if (!existsSync(join(trialDir, product, 'brain-calls'))) throw new Error('no brain-calls folder in this trial');
if (inside(trialDir, diag)) throw new Error('the diagnostic folder must be OUTSIDE the trial folder');
if (gitRoot(diag)) throw new Error('the diagnostic folder must be outside any git repository');
if (existsSync(diag) && readdirSync(diag).length) throw new Error('the diagnostic folder must be new or empty');

// ---- fingerprint of the whole trial folder (read-only proof)
function fingerprint(root) {
  const out = {};
  const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); const st = statSync(p); if (st.isDirectory()) walk(p); else out[relative(root, p)] = { sha256: createHash('sha256').update(readFileSync(p)).digest('hex'), bytes: st.size, mtime_ms: st.mtimeMs }; } };
  walk(root); return out;
}
const before = fingerprint(trialDir);
const locks = Object.keys(before).filter((f) => f.endsWith('.lock'));

// ---- copies, then replay on the copies only
const src = join(trialDir, product, 'brain-calls'); const copy = join(diag, 'brain-calls-copy');
mkdirSync(copy, { recursive: true });
const files = readdirSync(src).sort();
for (const f of files) copyFileSync(join(src, f), join(copy, f));
const tags = [...new Set(files.filter((f) => f.endsWith('.request.json')).map((f) => f.replace('.request.json', '')))];

// the verified facts the guards compare against: those the trial itself sent to STAGE (or, failing that, the product text of the observation)
const factsOf = () => {
  for (const tag of tags) { if (!/STAGE/.test(tag)) continue; const u = JSON.parse(JSON.parse(readFileSync(join(copy, `${tag}.request.json`), 'utf8')).user); if (u.verified_facts) return u.verified_facts; }
  const fr = tags.find((t) => /FRAME/.test(t)); if (!fr) return {};
  const obs = JSON.parse(JSON.parse(readFileSync(join(copy, `${fr}.request.json`), 'utf8')).user).observation; return { description: obs?.public_facts?.product ?? '' };
};
const FACTS = factsOf();
const results = []; let frame = null; let concepts = null;
for (const tag of tags) {
  const req = JSON.parse(readFileSync(join(copy, `${tag}.request.json`), 'utf8'));
  // a scoped repair's answer was normalised AFTER the merge: judge what production judged (the .merged.txt), and say so
  const mergedPath = join(copy, `${tag}.merged.txt`);
  const respPath = existsSync(mergedPath) ? mergedPath : join(copy, `${tag}.response.txt`);
  const recorded = existsSync(respPath) ? readFileSync(respPath, 'utf8') : null;
  const stepName = tag.replace(/^\d+-/, '').replace(/-cnc_.*/, '');
  const stage = stepName.replace(/_REPAIR$/, ''); // a repair answer is judged by its stage's contract
  const row = { tag, stage, repair: stepName.endsWith('_REPAIR'), judged: existsSync(mergedPath) ? 'MERGED_ANSWER (scoped repair)' : 'RECORDED_ANSWER', recorded_response_chars: recorded?.length ?? null, recorded_error: existsSync(join(copy, `${tag}.error.json`)) ? JSON.parse(readFileSync(join(copy, `${tag}.error.json`), 'utf8')) : null };
  if (recorded == null) { row.current_contract = 'NO_RECORDED_ANSWER'; results.push(row); continue; }
  let served = 0; let currentPromptSha = null;
  const replay = async (instruction) => { served += 1; currentPromptSha = createHash('sha256').update(instruction.system).digest('hex'); if (served > 1) throw Object.assign(new Error('the replay has no second answer'), { code: 'REPLAY_HAS_NO_OTHER_ANSWER' }); return { text: recorded, model: 'REPLAY_OF_RECORDED_ANSWER', request_id: null }; };
  const user = JSON.parse(req.user);
  try {
    if (stage === 'FRAME') { ({ frame } = await createProblemFramer({ complete: replay }).frame({ observation: user.observation })); row.current_contract = 'ACCEPTED'; }
    else if (stage === 'IDEATE') { ({ concepts } = await createConceptDirector({ complete: replay, count: { min: 3, max: 3 } }).ideate({ frame: user.problem_frame ?? frame })); assertConceptsHabbRules(concepts, FACTS); row.current_contract = 'ACCEPTED'; row.concepts = concepts.map((c) => ({ concept_id: c.concept_id, central_idea: c.central_idea })); }
    else if (stage === 'SELECT') { const { selection } = await createConceptSelector({ complete: replay }).select({ frame: user.problem_frame ?? frame, concepts: user.concepts ?? concepts }); row.current_contract = 'ACCEPTED'; row.selection = selection.outcome ?? null; }
    else if (stage === 'ART_DIRECT') { const { art_direction: a } = await createArtDirector({ complete: replay }).direct({ frame: user.problem_frame, concept: user.concept, hints: [HABB_ART_DIRECTION_HINT] }); assertArtDirectionGuard(a, user.verified_facts ?? FACTS); row.current_contract = 'ACCEPTED'; }
    else if (stage === 'STAGE') { const raw = JSON.parse(recorded); row.rationale_chars = typeof raw.rationale === 'string' ? raw.rationale.length : null; const { stage: st } = await createStageDirector({ complete: replay }).stage({ frame: user.problem_frame, concept: user.concept, artDirection: user.art_direction, facts: user.verified_facts ?? {} }); assertStageGuard(st, user.verified_facts ?? FACTS); row.current_contract = 'ACCEPTED'; }
    else row.current_contract = `UNKNOWN_STAGE_${stage}`;
  } catch (error) {
    row.current_contract = 'REFUSED'; row.refusal = { code: error.code ?? null, field: error.field ?? null, message: String(error.message).slice(0, 300) };
  }
  const recordedSystem = String(req.system).replace(/\nYour previous answer was REFUSED by Nordla's contract:[\s\S]*$/, ''); // the repair note is the run's, not the stage's prompt
  row.prompt_changed_since_trial = currentPromptSha ? currentPromptSha !== createHash('sha256').update(recordedSystem).digest('hex') : null;
  results.push(row);
}

// ---- read-only proof
const after = fingerprint(trialDir);
const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((f) => JSON.stringify(before[f]) !== JSON.stringify(after[f]));
const proof = { trial_files: Object.keys(before).length, locks_found: locks, changed_files: changed, read_only_respected: changed.length === 0 };
const report = { kind: 'OFFLINE_REPLAY_DIAGNOSTIC', network_calls: 0, new_answers: 0, trial_dir_read_only: proof, results,
  limits: 'The replay can only judge the recorded answers. It cannot continue the run: every stage after the last recorded answer would need a NEW model call, i.e. a new authorised attempt.' };
writeFileSync(join(diag, 'replay.json'), JSON.stringify(report, null, 1));
const md = ['# Rejeu hors ligne des réponses réelles (aucun appel, aucune nouvelle réponse)', '',
  `- Dossier d'essai : ${proof.trial_files} fichiers, verrou(x) : ${locks.join(', ') || 'aucun'}, intact : **${proof.read_only_respected ? 'oui' : `NON (${changed.join(', ')})`}**`, '',
  '| Appel | Étape | Contrat actuel | Détail | Prompt modifié depuis l\'essai |', '|---|---|---|---|---|',
  ...results.map((r) => `| ${r.tag} | ${r.stage} | ${r.current_contract} | ${r.refusal ? `${r.refusal.code} · ${r.refusal.field ?? ''} · ${r.refusal.message.replace(/\|/g, '/')}` : r.rationale_chars ? `justification : ${r.rationale_chars} caractères` : r.selection ?? ''} | ${r.prompt_changed_since_trial == null ? '-' : r.prompt_changed_since_trial ? 'oui' : 'non'} |`),
  '', report.limits, '', '> Ce fichier contient des extraits des réponses réelles du modèle : il reste privé, hors de tout dépôt.'].join('\n');
writeFileSync(join(diag, 'REPLAY.md'), md);
console.log(JSON.stringify({ diag: join(diag, 'REPLAY.md'), read_only_respected: proof.read_only_respected, results: results.map((r) => `${r.tag}: ${r.current_contract}${r.refusal ? ` (${r.refusal.code} ${r.refusal.field ?? ''})` : ''}`) }, null, 1));
if (!proof.read_only_respected) process.exit(4);
