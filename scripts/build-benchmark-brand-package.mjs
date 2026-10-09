// Derives a benchmark brand package (Brand Identity -> Snapshot -> Core -> Memory) through the REAL Branding governance functions.
//
// Generic: nothing here knows a merchant. The merchant's data is the `inputs` of a package file under benchmarks/creative-intelligence/.
// The package stores its inputs AND the outputs they produced; verifyBrandPackage re-derives the outputs from the inputs and compares, so a
// package cannot drift from the governed flow and a re-run can never mint a new brand_id (the brand_id is an INPUT, minted once).
//
//   node scripts/build-benchmark-brand-package.mjs <package.json>            # verify only (default; writes nothing)
//   node scripts/build-benchmark-brand-package.mjs <package.json> --write    # refresh the outputs from the inputs (never the inputs)

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  approveBrandCore, approveBrandMemory, buildBrandContext, buildBrandCoreProposal, buildBrandIdentity, buildBrandMemoryDraft,
  normalizeBrandSnapshot, proposeBrandMemoryRevision, submitBrandMemoryForReview,
} from '../src/branding/index.js';

const plain = (value) => JSON.parse(JSON.stringify(value));

/** @param {object} inputs the package inputs  @param {object} expression the owner-approved expression_system content */
export function buildBrandPackage(inputs, expression) {
  const tenant = { merchantId: inputs.merchant_id, source: 'env' };
  const brand = buildBrandIdentity({
    tenant,
    brandId: inputs.brand.brand_id,
    name: inputs.brand.name,
    createdAt: inputs.brand.created_at,
    defaultLocale: inputs.brand.default_locale,
    supportedLocales: inputs.brand.supported_locales,
    parentBrandId: inputs.brand.parent_brand_id,
  });
  const snapshot = normalizeBrandSnapshot({ ...inputs.snapshot, merchant_id: inputs.merchant_id, brand_id: brand.brand_id });
  const actor = { ...inputs.approver, merchant_id: inputs.merchant_id };

  const proposal = buildBrandCoreProposal({
    id: inputs.core.id, tenant, brand, createdAt: inputs.core.created_at, snapshot, decisions: inputs.core.decisions,
  });
  const coreApproval = approveBrandCore({
    proposal: proposal.core, snapshot, tenant, brand, resolvedActor: actor, approvedAt: inputs.core.approved_at, note: inputs.core.approval_note,
  });

  const draft = buildBrandMemoryDraft({
    tenant, brand, id: inputs.memory.id, createdAt: inputs.memory.created_at, core: coreApproval.approvedCore,
    content: { ...inputs.memory.content, expression_system: expression },
  });
  const reviewed = submitBrandMemoryForReview({ memory: draft.memory, core: coreApproval.approvedCore, tenant, brand });
  const memoryApproval = approveBrandMemory({
    memory: reviewed, core: coreApproval.approvedCore, tenant, brand, resolvedActor: actor, approvedAt: inputs.memory.approved_at, note: inputs.memory.approval_note,
  });

  // an optional governed REVISION of the approved Memory: v1 stays untouched and becomes SUPERSEDED, v2 is the approved successor
  let current = memoryApproval;
  let revisionReview = null;
  let revisionApproval = null;
  if (inputs.memory_revision) {
    const r = inputs.memory_revision;
    const revision = proposeBrandMemoryRevision({
      approvedMemory: memoryApproval.approvedMemory, core: coreApproval.approvedCore, tenant, brand, id: r.id, createdAt: r.created_at, changes: r.changes,
    });
    revisionReview = revision.memory;
    revisionApproval = approveBrandMemory({
      memory: revision.memory, core: coreApproval.approvedCore, tenant, brand, resolvedActor: actor, activeMemory: memoryApproval.approvedMemory, approvedAt: r.approved_at, note: r.approval_note,
    });
    current = revisionApproval;
  }
  const context = buildBrandContext({
    tenant, brand, core: coreApproval.approvedCore, memory: current.approvedMemory, snapshot,
  });

  return {
    tenant,
    brand,
    snapshot,
    core: coreApproval.approvedCore,
    coreEvent: coreApproval.decisionEvent,
    memory: current.approvedMemory,
    memoryEvent: current.decisionEvent,
    memoryV1: memoryApproval.approvedMemory,
    context,
    outputs: plain({
      brand,
      snapshot,
      approved_core: coreApproval.approvedCore,
      core_decision_event: coreApproval.decisionEvent,
      // approved_memory is the CURRENT approved Memory (the revision when there is one); v1 is kept as approved, and as superseded once revised
      approved_memory: current.approvedMemory,
      memory_decision_event: current.decisionEvent,
      ...(revisionApproval ? {
        memory_v1_approved: memoryApproval.approvedMemory,
        memory_v1_decision_event: memoryApproval.decisionEvent,
        memory_v1_superseded: revisionApproval.supersededMemory,
        memory_revision_review_required: revisionReview,
      } : {}),
    }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [file, flag] = process.argv.slice(2);
  if (!file) throw new Error('usage: node scripts/build-benchmark-brand-package.mjs <package.json> [--write]');
  const pkg = JSON.parse(readFileSync(file, 'utf8'));
  const expression = JSON.parse(readFileSync(new URL(`../${pkg.inputs.expression_file}`, import.meta.url), 'utf8')).expression_system;
  const built = buildBrandPackage(pkg.inputs, expression);
  if (flag === '--write') {
    writeFileSync(file, `${JSON.stringify({ ...pkg, outputs: built.outputs }, null, 2)}\n`);
    console.log('outputs refreshed; brand_id unchanged:', pkg.inputs.brand.brand_id);
  } else {
    const same = JSON.stringify(built.outputs) === JSON.stringify(pkg.outputs);
    console.log(same ? 'package verified' : 'PACKAGE DIFFERS FROM ITS INPUTS');
    process.exit(same ? 0 : 1);
  }
}
