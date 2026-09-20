# Merchant config: HABB

HABB is the pilot merchant. Everything in this directory is **data**, not code, and nothing here may be referenced by the generic retail core directly — the core reads merchant config generically (by merchant ID), it never imports or special-cases `habb`.

## What belongs here (not yet populated — Phase 0 has no config values yet)

- UV printing production costs (ink, consumables, machine time)
- Blank/unprinted product costs
- Operator time assumptions
- Remake/waste rate assumptions
- Any other cost or business-rule input specific to how HABB produces or sells goods

## What does NOT belong here

- Anything that should be true for retailers in general (belongs in the generic core).
- Anything true for "retailers who do in-house production" as a category, not just HABB specifically (belongs in a vertical module, parameterized per merchant — this directory only holds HABB's *values* for those parameters).

No values have been added yet — this directory is a placeholder created during Phase 0 to prove the separation exists, per the "HABB must be configuration, not architecture" requirement.
