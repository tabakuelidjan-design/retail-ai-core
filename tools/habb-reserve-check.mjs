// Runs D's deterministic checks on the editorial reserve in its own format (reports/editorial-14j/posts.json, version 1) - the single source of truth since the unification.
// READ-ONLY on the reserve. usage: node tools/habb-reserve-check.mjs <posts.json> [--json]
import { readFileSync } from 'node:fs';
import { lintClaimsLikeE, lintPriceChannel, lintProcessClaims } from '../src/asset-library/index.js';

const [path, ...flags] = process.argv.slice(2);
if (!path) { console.error('usage: node tools/habb-reserve-check.mjs <posts.json> [--json]'); process.exit(2); }
const doc = JSON.parse(readFileSync(path, 'utf8'));
const CONFIRMED = [{ excerpts: ['25 €', '25,00 €', '25 euros', '25 EUR'], requires: 'coque', channel: 'IN_STORE' }]; // E's registry + D's channel: 25 EUR is the SHOP price
const MOTIF = /\b(c[œo]eurs?|feuilles?|branch(?:e|es|age)|feuillage|dor[ée]e?s?|glow|paillett\w+|brillants?)\b/i;
const ID = (i) => i.id;
const kind = (i) => (i.id.startsWith('P') ? 'POST' : i.id.startsWith('S') ? 'STORY' : 'REEL');
const problems = []; const counts = { POST: 0, STORY: 0, REEL: 0 };
const status = { READY: 0, BRIEF: 0, NOT_SHOT: 0, OTHER: 0 };
for (const it of doc.items) {
  counts[kind(it)] += 1;
  const v = it.etat_visuel ?? '';
  if (/^\s*PR[ÊE]T/i.test(v)) status.READY += 1; else if (/^\s*BRIEF/i.test(v)) status.BRIEF += 1; else if (/^\s*NON TOURN/i.test(v)) status.NOT_SHOT += 1; else status.OTHER += 1;
  for (const [field, text] of [['legende', it.legende], ['legende_variante_b', it.legende_variante_b]]) {
    if (!text) continue;
    for (const f of lintClaimsLikeE(`${text}\n${(it.hashtags ?? []).map((h) => `#${h}`).join(' ')}`, { confirmed: CONFIRMED })) problems.push({ item: ID(it), field, code: `E_WOULD_BLOCK_${f.code}`, detail: f.excerpt });
    const body = `${text}
${(it.hashtags ?? []).map((h) => `#${h}`).join(' ')}`;
    for (const f of lintProcessClaims(body)) problems.push({ item: ID(it), field, code: f.code, detail: f.excerpt });
    for (const f of lintPriceChannel(body, { confirmed: CONFIRMED })) problems.push({ item: ID(it), field, code: f.code, detail: `${f.excerpt} (${f.channels.join("/")})` });
    const m = text.match(MOTIF); if (m) problems.push({ item: ID(it), field, code: 'FORBIDDEN_DECORATIVE_WORD', detail: m[0] });
  }
  if (kind(it) !== 'REEL' && !it.alt_text && /^\s*PR[ÊE]T/i.test(v)) problems.push({ item: ID(it), field: 'alt_text', code: 'ALT_TEXT_MISSING_ON_READY_VISUAL', detail: '' });
}
const result = { source: path, counts, visual_status: status, problems };
if (flags.includes('--json')) console.log(JSON.stringify(result, null, 1));
else {
  console.log(`items: ${doc.items.length} (${counts.POST} posts, ${counts.STORY} stories, ${counts.REEL} videos) · visuals READY ${status.READY}, BRIEF ${status.BRIEF}, NOT SHOT ${status.NOT_SHOT}, other ${status.OTHER}`);
  console.log(problems.length ? problems.map((p) => `${p.item} ${p.field}: ${p.code} ${p.detail}`).join('\n') : 'no problem found by the deterministic checks');
}
process.exit(problems.length ? 1 : 0);
