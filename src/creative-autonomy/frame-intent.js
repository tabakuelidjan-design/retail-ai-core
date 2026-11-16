// FRAME LEAVES THE SET OPEN (2026-11-07). In the decor-first route the problem frame states the commercial intention and the physical constraints of the photograph; it does not choose the set.
// Real run 2026-11-07: what_we_show was "a battery on a floor of polished concrete, soft light from the left, a wall of whitened bricks" and its distinctive levers were that wall, that light and that floor: the three concepts that followed were
// that same room. This guard refuses a frame that prescribes a surface, a material or a light quality (repairable, collected with the other violations of the answer, in the one repair of the stage). The side of the light of the PHOTOGRAPH is a
// physical constraint and stays allowed; only its quality ("soft", "douce"...) is a decor decision.
import { fail, BRAIN_ERROR } from '../creative-brain/validation.js';
import { unsourcedBenefitProblems } from './decor-coherence.js';
import { ROUTE_ENVIRONMENT_FIRST, ROUTE_PRODUCT_VISIBLE } from './route-executability.js';
const LEAVES_SET_OPEN = (route) => route === ROUTE_ENVIRONMENT_FIRST || route === ROUTE_PRODUCT_VISIBLE;

const L = '\\p{L}\\p{N}_';
const word = (alternatives) => new RegExp(`(?<![${L}])(?:${alternatives.join('|')})(?![${L}])`, 'iu');
export const FRAME_DECOR_RE = word(['walls?', 'murs?', 'floors?', 'sols?', 'planchers?', 'grounds?', 'ceilings?', 'plafonds?', 'concrete', 'b[ée]ton', 'bricks?', 'briques?', 'plaster', 'pl[âa]tre', 'stone', 'pierres?', 'marble', 'marbre', 'wood(?:en)?', 'bois', 'tiles?', 'carrelage', 'wallpaper', 'papier peint', 'architecture', 'pedestals?', 'plinths?', 'socles?', 'backdrops?', 'arri[èe]re-plans?']);
export const FRAME_LIGHT_QUALITY_RE = new RegExp(`(?<![${L}])(?:lumi[èe]re|light(?:ing)?|[ée]clairage)\\s+(?:[${L}]+\\s+)?(?:douce?s?|dure?s?|rasante?s?|chaude?s?|froide?s?|diffuse?s?|dramatique|soft|hard|warm|cold|cool|grazing|diffuse|dramatic)(?![${L}])`, 'iu');
export const FRAME_LIGHT_QUALITY_EN_RE = new RegExp(`(?<![${L}])(?:soft|hard|warm|cold|cool|grazing|diffuse|dramatic|gentle)\\s+(?:light|lighting)(?![${L}])`, 'iu');
// the fields of the frame in which a set would be prescribed (generic_risks may NAME the clichés to avoid, so they are not examined)
const SCALAR_FIELDS = ['what_we_show', 'understood_immediately', 'felt', 'remembered'];

const issueOf = (text) => {
  const grab = (re) => [...String(text ?? '').matchAll(new RegExp(re.source, 'giu'))].map((m) => m[0].toLowerCase());
  const words = [...new Set([...grab(FRAME_DECOR_RE), ...grab(FRAME_LIGHT_QUALITY_RE), ...grab(FRAME_LIGHT_QUALITY_EN_RE)])];
  return words.length ? words : null;
};

/** Every field of the frame that prescribes the set: [{ field: 'frame.what_we_show', words }]. */
export function frameDecorProblems(frame) {
  const out = [];
  for (const f of SCALAR_FIELDS) { const w = issueOf(frame?.[f]); if (w) out.push({ field: `frame.${f}`, words: w }); }
  (Array.isArray(frame?.distinctive_levers) ? frame.distinctive_levers : []).forEach((t, i) => { const w = issueOf(t); if (w) out.push({ field: `frame.distinctive_levers[${i}]`, words: w }); });
  return out;
}

/** The refusal of the stage: the FIRST field, as a Brain contract refusal (repairable). */
const FRAME_TEXTS = (frame) => Object.entries(frame ?? {}).flatMap(([k, v]) => (typeof v === 'string' ? [[`frame.${k}`, v]] : Array.isArray(v) ? v.filter((x) => typeof x === 'string').map((x, i) => [`frame.${k}[${i}]`, x]) : []));
/** The benefits the frame presents as VERIFIED without a source in the verified text (any route): [{ field, benefit, missing }]. */
export const frameUnsourcedBenefits = (frame, verifiedText) => FRAME_TEXTS(frame).flatMap(([field, t]) => unsourcedBenefitProblems(t, verifiedText).map((u) => ({ field, ...u })));
export function assertFrameLeavesSetOpen(frame, route, { verifiedText = null } = {}) {
  if (verifiedText !== null) {
    const [u] = frameUnsourcedBenefits(frame, verifiedText);
    if (u) fail(BRAIN_ERROR.RULE_VIOLATION, `${u.field} presents as verified a benefit the facts do not state ("${u.benefit}"): state only what the verified product text says, or do not call it verified`, u.field, { problem: 'UNSOURCED_VERIFIED_BENEFIT', benefit: u.benefit });
  }
  if (!LEAVES_SET_OPEN(route)) return frame;
  const [first] = frameDecorProblems(frame);
  if (first) fail(BRAIN_ERROR.RULE_VIOLATION, `${first.field} chooses the set (${first.words.join(', ')}): the frame states the intention and the constraints of the photograph, the concepts decide the set`, first.field, { problem: 'FRAME_PRESCRIBES_DECOR', words: first.words });
  return frame;
}

/** Every violation of a FRAME answer, grouped by field, for the one repair: [{ field, issues: [{ rule, message, words }] }]. [] when the answer is unreadable or the route is not decor-first. */
export function collectFrameViolations(answerText, { route = null, verifiedText = null } = {}) {
  if (!LEAVES_SET_OPEN(route) && verifiedText === null) return [];
  let answer; try { answer = JSON.parse(answerText); } catch { return []; }
  if (answer && typeof answer === 'object' && !Array.isArray(answer) && Object.hasOwn(answer, 'frame') && answer.frame && typeof answer.frame === 'object') answer = answer.frame;
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return [];
  const decor = LEAVES_SET_OPEN(route) ? frameDecorProblems(answer).map((p) => ({ field: p.field, issues: [{ rule: 'FRAME_PRESCRIBES_DECOR', message: `${p.field} chooses the set (${p.words.join(', ')})`, words: p.words }] })) : [];
  const benefits = verifiedText === null ? [] : frameUnsourcedBenefits(answer, verifiedText).map((u) => ({ field: u.field, issues: [{ rule: 'UNSOURCED_VERIFIED_BENEFIT', message: `${u.field} presents as verified a benefit the facts do not state ("${u.benefit}")` }] }));
  return [...decor, ...benefits];
}
