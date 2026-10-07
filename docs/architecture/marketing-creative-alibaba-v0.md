# Nordla Marketing + Creative — Alibaba Model Studio V0

Status: EXPERIMENTAL PROVIDER INTEGRATION

This integration does not activate dynamic multi-model routing. Provider/model selection remains explicit.

## Why Alibaba is integrated now

Nordla keeps an ownership-first strategy, but it does not sacrifice professional creative quality merely to avoid a small API cost.

Alibaba Model Studio is integrated as a premium pay-as-you-go provider candidate while local/free models continue to be benchmarked.

## V0 provider roles

- Marketing/content reasoning: `qwen3.8-max`
- Premium image generation/editing candidate: `qwen-image-3.0-pro`
- Premium video generation/editing candidate: `wan3.0-video`

The exact models remain evidence-sensitive and replaceable.

## Region

V0 is pinned to Germany (Frankfurt), `eu-central-1`.

Model, endpoint and API key must belong to the same region.

## Official endpoints used

Text:
`POST https://{WorkspaceId}.eu-central-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions`

Image:
`POST https://{WorkspaceId}.eu-central-1.maas.aliyuncs.com/compatible-mode/v1/images/generations`

Wan 3.0 create task:
`POST https://{WorkspaceId}.eu-central-1.maas.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis`

Wan task status:
`GET https://{WorkspaceId}.eu-central-1.maas.aliyuncs.com/api/v1/tasks/{task_id}`

## Security / privacy gates

- API key is read only from environment configuration.
- V0 rejects non-Frankfurt regions.
- Provider error messages are sanitized instead of echoing provider bodies/secrets.
- Any media sent to Wan 3.0 must carry explicit `external_share_allowed=true` in the caller input. That flag is removed before the provider request.
- Customer/private face assets remain local unless a later explicit policy permits external processing.
- Provider result URLs are temporary and must be copied to Nordla-controlled storage before expiry.

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

The code is installed and unit-tested with mocked provider calls. Live calls require:

- `ALIBABA_MODEL_STUDIO_API_KEY`
- `ALIBABA_MODEL_STUDIO_WORKSPACE_ID`

No credential is stored in Git.
