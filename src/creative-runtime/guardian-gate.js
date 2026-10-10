import { evaluateBrandGuardian } from '../branding/index.js';
import { buildCandidateManifest } from '../creative-intelligence/production.js';

// Brand Guardian as a deterministic gate of the creative runtime. It judges the candidate's DECLARED facts (colours, families, text, claims, the Fidelity gate result) against the
// brand's approved hard rules; it is never replaced, softened or overridden by a language-model critic, and it is evaluated on EVERY candidate the runtime produces. The runtime
// calls `evaluate({ document, fonts, fidelityGate })`; a missing gate is a configuration error the runtime reports, never a silent pass.

/** @param {object} deps { tenant, brandContext, evaluatedAt, targetRef } from the approved Brand Memory flow */
export function createBrandGuardianGate({ tenant, brandContext, evaluatedAt, targetRef }) {
  if (!tenant || !brandContext || typeof evaluatedAt !== 'string' || typeof targetRef !== 'string') throw new TypeError('a Brand Guardian gate needs a tenant, a Brand Context, an evaluation instant and a target');
  return Object.freeze({
    evaluate({ document, fonts, fidelityGate }) {
      const report = evaluateBrandGuardian({
        tenant, brandContext, candidateManifest: buildCandidateManifest({ document, fonts, fidelityGate }), targetRef, evaluatedAt,
      });
      return Object.freeze({
        report_id: report.id,
        outcome: report.outcome,
        hard_outcome: report.hard_outcome,
        rule_results: Object.freeze(report.rule_results.map((r) => Object.freeze({ rule_id: r.rule_id, outcome: r.outcome }))),
      });
    },
  });
}
