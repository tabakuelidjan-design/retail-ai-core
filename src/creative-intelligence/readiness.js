// Pre-C2 readiness. C2 (real providers, product segmentation / compositing, background generation, benchmarking) is BLOCKED until the
// dependencies below have explicit evidence. Nothing is inferred and nothing is marked ready by default: this is the same honesty
// device as Activation's production-readiness report.
//
// A dependency is closed only by EVIDENCE ISSUED BY A VERIFICATION in this package (pre-c2-probes.js, benchmark.js): a real probe that ran
// (resolver conformance, real-font shaping, bidi, deterministic rasterization, a real PNG path, an approved non-empty expression system) or a
// benchmark that was actually RUN. A string, a hand-made object or a "RUNNABLE" report is not evidence and is refused. Infrastructure
// existing never opens C2: the architect-selected campaign benchmark must have actually been run.
// CJK line breaking is DEFERRED by decision: it is documented, it does not block C2, and it must not be claimed as supported.

import { CI_ERROR as E, PRE_C2_DEPENDENCY as D } from './constants.js';
import { deepFreeze, fail, isPlainObject, ref } from './validation.js';

// Evidence issued by a verification. Registration is module-private to the package (the index does not re-export it): an object that was
// not registered here is not evidence, whatever it says.
const ISSUED = new WeakSet();
export function registerEvidence(evidence) {
  ISSUED.add(evidence);
  return evidence;
}

export const PRE_C2_DEPENDENCIES = deepFreeze([
  {
    id: D.RESOURCE_RESOLVER,
    blocking: true,
    summary: 'The common Socle Resource Resolver with FORMAT capability, implementing resolve(ref, tenant) -> { ref, kind, merchant_id, version?, status, metadata? } for subjects, assets, claims, fonts and formats (a FORMAT carries canvas {width, height, unit}, medium, safe_zones, forbidden_zones, production_constraints; the aspect ratio is derived; channel and placement stay Marketing deliverable facts). It also turns an asset reference into an ephemeral payload for a RESOLVED render. C1 defines only the boundary.',
  },
  {
    id: D.BRAND_EXPRESSION_SYSTEM,
    blocking: true,
    summary: 'Brand Memory V1.1 `expression_system`: photography, product_presentation, composition, layout_principles, illustration, iconography, motion, locale_overrides. Until it exists C1 invents none of those values and falls back to no generic or "premium" style.',
  },
  {
    id: D.REAL_FONT_METRICS,
    blocking: true,
    summary: 'Font metrics generated from the real font files (advance widths, ascent, descent, kerning) and proof that the typography engine agrees with a real font renderer.',
  },
  {
    id: D.COMPLEX_SCRIPT_SHAPING,
    blocking: true,
    summary: 'Real shaping for complex scripts (joining, ligatures, marks) so that Arabic text can be measured, not only laid out.',
  },
  {
    id: D.ARABIC_BIDI_RTL_VERIFICATION,
    blocking: true,
    summary: 'Arabic / bidirectional / RTL verification: mixed-direction runs, digits, punctuation, logical alignment and the mirrored recipes checked against a real renderer.',
  },
  {
    id: D.DETERMINISTIC_RASTERIZER,
    blocking: true,
    summary: 'A deterministic rasterizer (same document and fonts -> same pixels, across runs and machines).',
  },
  {
    id: D.REAL_PNG_RENDER_PATH,
    blocking: true,
    summary: 'A real PNG render path from the DesignDocument (today renderPng answers { supported: false } without an injected rasterizer; no PNG is ever faked).',
  },
  {
    id: D.REAL_CAMPAIGN_BENCHMARK,
    blocking: true,
    summary: 'C2 provider work stays blocked until a real campaign benchmark exists: the architect-selected benchmark is kept as configuration data under benchmarks/creative-intelligence/ (product fidelity, exact approved price and claim, exact critical text, brand expression compliance, deterministic typography, preflight PASS, Fidelity gate, Guardian gate). No campaign logic lives in this source.',
  },
  {
    id: D.CJK_LINE_BREAKING,
    blocking: false,
    summary: 'CJK line breaking (no inter-word spaces). DEFERRED: documented as unsupported, not claimed, does not block C2.',
  },
]);

/**
 * @param {object} facts a map { DEPENDENCY_ID: evidence } - the EVIDENCE issued by the verification of that dependency
 * @returns the status of every dependency and whether C2 may start. With no fact at all: C2 is NOT allowed, every blocking dependency open.
 */
export function assessCreativeC2Readiness(facts = {}) {
  if (!isPlainObject(facts)) fail(E.READINESS_INVALID, 'facts must be an object', { field: 'facts' });
  const known = PRE_C2_DEPENDENCIES.map((d) => d.id);
  for (const key of Object.keys(facts)) if (!known.includes(key)) fail(E.READINESS_INVALID, `${key} is not a pre-C2 dependency`, { field: 'facts' });
  const dependencies = PRE_C2_DEPENDENCIES.map((d) => {
    let evidence = null;
    if (facts[d.id] !== undefined) {
      const given = facts[d.id];
      if (!ISSUED.has(given) || given.dependency !== d.id || given.status !== 'VERIFIED') {
        fail(E.READINESS_INVALID, `${d.id}: only evidence issued by its verification closes a dependency (not a reference, not a report that merely says so)`, { field: d.id });
      }
      evidence = ref(given.evidence_ref, `facts.${d.id}.evidence_ref`);
    }
    let status;
    if (evidence) status = 'CLOSED';
    else status = d.blocking ? 'OPEN' : 'DEFERRED';
    return { id: d.id, blocking: d.blocking, status, evidence_ref: evidence, summary: d.summary };
  });
  const open = dependencies.filter((d) => d.status === 'OPEN').map((d) => d.id);
  const closed = (id) => dependencies.find((d) => d.id === id).status === 'CLOSED';
  return deepFreeze({
    c2_allowed: open.length === 0,
    open_blockers: open,
    dependencies,
    // derived from the evidence of the three typography verifications, never asserted
    typography_production_ready: closed(D.REAL_FONT_METRICS) && closed(D.COMPLEX_SCRIPT_SHAPING) && closed(D.ARABIC_BIDI_RTL_VERIFICATION),
  });
}
