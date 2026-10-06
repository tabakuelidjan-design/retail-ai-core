# ADR 0004: Nordla Canonical Constitution

- **Status:** Accepted
- **Date:** 2026-10-06

## Context

Nordla evolved materially after the Phase 0 architecture. Conversation history, older ADRs and old project instructions now contain multiple generations of the product model. Relying on an LLM's memory or on chronological chat history creates a material risk of silently reverting to obsolete architecture.

The project therefore requires an explicit current source of truth that survives model changes, new sessions and parallel workstreams.

## Decision

The following files are canonical:

1. `NORDLA-CANONICAL-ARCHITECTURE.md`
2. `NORDLA-DECISION-REGISTER.md`
3. `NORDLA-DEFERRED.md`

Before substantial Nordla work, contributors and AI coding assistants must read these files.

`docs/principles/decision-principles.md` operationalizes the ethical/decision principles defined by the Constitution.

Older ADRs and architecture documents remain preserved as historical records. Where they conflict with the canonical documents, the canonical documents take precedence unless a later accepted ADR explicitly supersedes a frozen canonical decision.

No frozen decision may be changed silently.

## Consequences

- New sessions do not rely on conversational memory as the source of truth.
- Parallel agents/assistants share the same architecture baseline.
- Approved but postponed capabilities remain visible.
- Vendor announcements can be evaluated without causing architecture drift.
- Historical documents are not rewritten to pretend the project always had its current architecture.

## Superseded assumptions

This ADR supersedes any interpretation of older project guidance that:
- treats Phase 0 status as the current status;
- prohibits all future specialist agents categorically;
- treats Shopify as the target runtime architecture;
- treats domains as independent decision authorities;
- assumes the old linear pipeline is the complete current operating model.

The useful principles from prior ADRs remain in force where they do not conflict with the Constitution.
