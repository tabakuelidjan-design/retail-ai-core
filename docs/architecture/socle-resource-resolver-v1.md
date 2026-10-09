# Socle common resource resolver — contract (V1)

- **Status:** COMPLETE (PRE-C2 technical foundation, pushed at `d182e86`). **Code:** `src/resources/` · **Tests:** `test/resources-resolver.test.js`, `test/creative-intelligence-production.test.js`.

One resolver for every resource a domain references by an opaque `scheme://name`. There is no Format Resolver, no Font Resolver, no Asset Resolver:
those are kinds of the same resolver.

## Shape

```text
createCommonResourceResolver({ adapters }) -> { resolve(ref, tenant), require(ref, kinds, tenant), loadPayload(ref, tenant), adapters, asBoundaryResolver() }
adapter: { adapter_id, supported_kinds, resolve(ref, tenant) }   (createStaticResourceAdapter for owners that hold records)
resolution: { ref, kind, merchant_id, version, status, metadata, provenance:{ adapter_id, evidence_ref, content_hash, resolver_version } }
```

- **Kinds:** PRODUCT, CATEGORY, COLLECTION, SUBJECT_OTHER, ASSET, CLAIM, FONT, FORMAT, POLICY. **Statuses:** ACTIVE, UNRESOLVED, REVOKED, EXPIRED, RESTRICTED.
- The **owner adapter decides the kind**; the text of a reference never does (`product://x` may be a CATEGORY). An adapter answering for a kind it did not declare is refused.
- **Zero** adapter matches → `UNRESOLVED` (no kind, never READY). **More than one** → `RES_CONFLICT`; the resolver never picks. An adapter outage is a refusal, not "not found".
- **Tenancy:** a resource of another merchant is refused. Only **FONT** and **FORMAT** may be platform-level (`merchant_id: null`); a merchant-less ASSET is refused.
- **Evidence:** an ACTIVE resource without an `evidence_ref` is refused. REVOKED / EXPIRED / RESTRICTED are returned as such and are never usable (`require`).
- **No location is an identity:** a raw URL, path or data URI is refused as a reference and inside metadata.

## Metadata (strict, per kind)

| Kind | Metadata |
|---|---|
| FORMAT | exactly `{canvas:{width,height,unit}, medium, safe_zones, forbidden_zones, production_constraints}` (`unit` px / mm / pt). **No** `aspect_ratio` (derived), **no** channel, **no** placement — those are Marketing facts. The Creative intake accepts `px` only and converts nothing. |
| FONT | `{family, style, weight, version, format, content_hash, license_ref}` |
| ASSET | `{media_type, width_px, height_px, content_hash, origin (MERCHANT_PROVIDED / GENERATED / SYNTHETIC), approval_ref}` |
| CLAIM | `{approved_wording, approval_ref}` — the wording AND the reference of its approval |
| others | free, location-free metadata |

## Payloads

Only ASSET and FONT have bytes. `loadPayload` returns them **ephemerally** and verifies the sha-256 against the content hash the owner declared
(`RES_PAYLOAD_HASH_MISMATCH`). Bytes never enter a DesignDocument, a Brand Memory or a persisted record.

## Consumers

`asBoundaryResolver()` satisfies the C1 Creative consumer boundary (`resolveIntakeResources`) unchanged. `loadRealFont` (Creative production
typography) is `FONT` resolution → payload → hash check → HarfBuzz face. The HABB benchmark binds PRODUCT, ASSET, CLAIM, FORMAT and FONT through this
one resolver; nothing in `src/` knows the merchant.
