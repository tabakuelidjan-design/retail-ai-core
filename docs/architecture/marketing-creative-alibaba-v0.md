# Nordla Marketing + Creative — Alibaba Model Studio V0

Status: EXPERIMENTAL PROVIDER INTEGRATION

Provider-selection note (2026-10-07): Alibaba is the first controlled provider lane, not the declared winner. See `marketing-creative-provider-benchmark-2026-10-07.md` for the current multi-provider benchmark decision and promotion gates.

This integration does not activate dynamic multi-model routing. Provider/model selection remains explicit.

## Why Alibaba is integrated now

Nordla keeps an ownership-first strategy, but it does not sacrifice professional creative quality merely to avoid a small API cost.

Alibaba Model Studio is integrated as a premium pay-as-you-go provider candidate while local/free models continue to be benchmarked.

## V0 provider roles

- Marketing/content reasoning: `qwen3.8-max`
- Premium image generation/editing candidate: `qwen-image-3.0-pro`
- Premium video generation/editing candidate: `wan3.0-video`

The exact models remain evidence-sensitive and replaceable.

## Region and data locality

The V0 API endpoint is explicitly pinned to Germany (Frankfurt), `eu-central-1`.

This does **not** claim that inference is physically restricted to Germany. Alibaba currently lists these model offerings with Global scope. Nordla therefore treats the provider as an external/global processor for V0 and sends only `PUBLIC` data.

No `EU_CLOUD` or `LOCAL_ONLY` asset, personal data, customer data or face is allowed through the V0 data gate.

Model, endpoint and API key must belong to the configured Frankfurt workspace.

## Official endpoints used

Text:

`POST https://{WorkspaceId}.eu-central-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions`

Text-to-image:

`POST https://{WorkspaceId}.eu-central-1.maas.aliyuncs.com/compatible-mode/v1/images/generations`

Image editing / multimodal references:

`POST https://{WorkspaceId}.eu-central-1.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation`

Wan 3.0 create task:

`POST https://{WorkspaceId}.eu-central-1.maas.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis`

Wan task status:

`GET https://{WorkspaceId}.eu-central-1.maas.aliyuncs.com/api/v1/tasks/{task_id}`

## Security / privacy gates

- API key is read only from `ALIBABA_MODEL_STUDIO_API_KEY`.
- No legacy `DASHSCOPE_API_KEY` fallback is accepted.
- Workspace ID is syntactically validated before URL construction.
- Provider URLs must be HTTPS and end in the Frankfurt Model Studio host.
- HTTP redirects are rejected.
- Provider error bodies are not echoed to logs.
- Text, image and video all require an explicit data classification.
- Alibaba V0 accepts only `PUBLIC` data.
- Personal data and faces are rejected in V0.
- Wan media and image-reference URLs must be credential-free HTTPS URLs.
- Provider result URLs are downloaded immediately to Nordla-controlled storage and only hashes/controlled refs are returned.

## Cost controls

Every paid call requires a shared `SpendGuard`.

The guard can cap:

- total spend per run/campaign;
- number of images;
- video seconds;
- text output tokens.

Reservations happen before the provider call. Unknown or ambiguous cost is not treated as zero.

For smoke testing, the intended total cap is **1.50 EUR**.

## Wan task safety

Wan task creation and polling are separated.

After creation, `task_id` and `request_id` are journaled before polling. Polling tolerates transient provider errors and never recreates the video task automatically.

A polling timeout is recorded as `TIMED_OUT_ACTIVE`, not as a failed creation.

## Provenance / output handling

Provider outputs are downloaded before success is returned.

Nordla records:

- provider/model/region;
- request ID;
- Wan task ID where relevant;
- estimated/actual cost;
- data class;
- output SHA-256;
- success/failure state.

Signed provider URLs and raw provider payloads are not intended for application logs.

Creative Fidelity now also has a durable JSONL ledger option outside Git for benchmark provenance.

## No vendor lock-in

Alibaba is a premium provider lane, not the architecture.

Nordla continues to build:

- deterministic composition;
- Brand Memory / Brand Guardian;
- local/open image generation;
- local smartphone studio;
- print/PLV;
- model-independent provenance and cost accounting.

Local/free models remain eligible wherever they meet the same quality bar.

## Live activation prerequisite

Code may remain installed without a live provider credential.

Before the first real call:

1. independent re-audit of the hardened branch;
2. targeted tests green;
3. dedicated test workspace;
4. dedicated temporary API key;
5. public non-sensitive HABB test asset only;
6. `SpendGuard.maxSpendEur <= 1.50`;
7. no face or personal data;
8. outputs stored outside Git.

Live calls require:

- `ALIBABA_MODEL_STUDIO_API_KEY`
- `ALIBABA_MODEL_STUDIO_WORKSPACE_ID`

No credential is stored in Git.
