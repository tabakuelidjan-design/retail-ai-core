# ADR 0007 (PROPOSED, not accepted) — Standing tenant media-processing policy, and a limited exception to NDR-D02

Status: **PROPOSED**. Nothing here changes `NORDLA-DECISION-REGISTER.md` or `NORDLA-DEFERRED.md`. Only the owner can accept it.
Date: 2026-11-02. Author: Claude (engineering proposal). Code: branch `fix/creative-production-v1-audit-20261102`.

## Part A — Standing tenant media-processing policy

### Context
Owner rule (2026-11-02): **Nordla never asks a customer to select, confirm or approve the source product photo before a creation.** The customer chooses a product and asks for a creation; only the finished output is presented for acceptance, revision or rejection.
The Creative Production V1 trial uses per-photo authorization records bound to one SHA-256 and switched on by hand (`revoked: false`). That is a valid operator control for one trial; in a customer workflow it would become a per-photo approval before every creation.

### Proposal
1. **Separate image selection from data-processing authorization.** Selection is internal (`src/creative-autonomy/product-media.js`): exact Shopify variant by immutable IDs, verified image, full decode, same-variant fallback.
2. **Authorization is given once per tenant** as a `TENANT_MEDIA_PROCESSING_POLICY` (`src/creative-autonomy/media-processing-policy.js`) that states:
   - the tenant (merchant ID, optionally the verified shop ID); who accepted it and when; validity window; revocation;
   - the covered sources: **only the tenant's own catalog media read through the verified connector**, with the tenant's attestation that its catalog product images show no people;
   - each processing line: provider, region, scope (`EU` / `GLOBAL`) and the explicit declaration of possible cross-border processing (refused if a `GLOBAL` line does not declare it), purpose, operations;
   - retention as published by the provider (zero-data-retention only with evidence);
   - spend caps per run and per month (EUR);
   - `audit.journal_required: true`.
3. **Per run**, the policy derives in memory the narrow per-photo `EXTERNAL_MEDIA_AUTHORIZATION` the existing guards already enforce (exact SHA-256, provider, region, purpose, one operation), checks it with `assessScopedExternalMediaUse`, and appends a journal entry (source SHA, media ID, policy ID and version, authorization ID, provider, region, scope, operation, run ID, run ceiling) **before** any provider is built.
4. **Fail closed** on: no policy, invalid policy, revoked or out-of-window policy, another tenant or shop, a source that is not verified catalog media, a processing line not covered, a run ceiling above the per-run cap, or month-to-date plus ceiling above the monthly cap.

### What it is NOT
- Not a bypass of privacy, personal-data or supplier-licensing obligations. **Customer uploads, images with people, private or personal media are refused** (`SOURCE_REQUIRES_SPECIFIC_CONSENT`) and need their own service-level consent mechanism. That mechanism is not built here.
- Not a statement that the provider processes data where its scope says: `EU` / `GLOBAL` is the configured declaration; the policy records it, it does not prove it.
- Not an authorization to spend: the caps bound spending once spending is allowed (Part B).

### Open obligations (owner / legal)
- Wording and acceptance flow of the tenant policy (onboarding), and where it is stored (today: an object passed to the entrypoint).
- Whether the tenant attestation "no people in catalog product images" is enough, or a local face/person detector must run first.
- Supplier image rights: catalog images uploaded by the merchant may be supplier images. The policy covers processing by Nordla's providers, not the merchant's licence to use the supplier's image.

## Part B — Limited exception to NDR-D02 for ONE offline-prepared trial

### Conflict
`NDR-D02` / `L3-002` keep "C2 provider bake-off, real provider execution … BLOCKED / DEFERRED until HABB CREATIVE BENCHMARK 001 is runnable and used". The first HABB/TYESO scene trial is real provider execution. It cannot run under the register as written.

### Proposed exception (exact scope)
- **One** run of `scripts/creative-autonomy-trial.mjs --execute --scene` for **one** product: TYESO 750 ml, variant Noir, HABB tenant, and for the exact plan ID and code SHA printed by `--plan`.
- Providers: Alibaba Model Studio Frankfurt; text and visual critique in an `EU`-scope workspace; `qwen-image-3.0-pro` image edit in a `GLOBAL`-scope workspace (possible processing outside the EU, declared).
- Sent: the plate (product cut out from the HABB source photo on grey) and the final render for critique. No person, no face, no customer data.
- **Ceiling: EUR 0.50 application-side** (SpendGuard and ledger), one image call (3 variants), one attempt (machine-wide lock). The real invoice is checked by hand in the Alibaba console afterwards.
- No publication. The output is reviewed by the owner.

### Preconditions (all required)
1. A verified 750 ml source photo of the black variant (see `docs/creative-autonomy/tyeso-750ml-media-remediation.md`). **Not met on 2026-11-02.**
2. The free model-list checks pass for both workspaces.
3. `--plan` run on the owner's machine; the owner reads the plan and gives an explicit GO for that plan ID and ceiling.
4. This exception is written into `NORDLA-DECISION-REGISTER.md` by the owner (dated), as a scoped exception to NDR-D02, not a lift of it.

### Rollback / audit
- The attempt registry and the journal (`provider-calls.jsonl`, transmissions) are kept outside git; request IDs are reported.
- Revocation: set the authorization records to `revoked: true` (trial) or `revoked: true` on the tenant policy; no code change needed.
- If the output fails any technical check, nothing is shown as a proposal; nothing is ever published automatically.
