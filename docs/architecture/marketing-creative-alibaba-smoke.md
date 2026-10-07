# Alibaba Creative V0 — controlled smoke test

Status: READY FOR CREDENTIAL CONFIGURATION / NOT YET EXECUTED LIVE

Independent pre-smoke review returned **GO FOR SMOKE TEST (conditional)**.

The smoke test exists only to validate the real provider wiring. It is **not** a Creative Fidelity benchmark and must not be used to rank models.

## Fixed sequence

One process, stop on first failure:

1. Qwen 3.8 Max — one text/campaign concept.
2. Qwen Image 3.0 Pro — one 1024x1024 image using one public product reference.
3. Wan 3.0 — one 5-second 720P video using the same public product reference.

Wan creation is called exactly once. Polling resumes from the returned `task_id`; it never recreates the task.

## Hard limits

The script refuses to run with a budget larger than:

- 1.50 EUR total;
- 1 generated image;
- 5 generated video seconds.

Wan uses:

- duration: 5;
- resolution: 720P;
- ratio: adaptive;
- audio: false;
- watermark: false.

## Data policy

The smoke test accepts only a clean, public, non-personal HABB product asset.

The direct image URL must:

- use HTTPS;
- contain no credentials;
- contain no query string or fragment;
- match an explicitly configured hostname in `ALIBABA_SMOKE_ALLOWED_HOSTS`.

Do not use:

- customer uploads;
- personalized faces;
- names or personal text;
- private/signed URLs;
- internal margins or finance data.

## Secrets

Never commit credentials.

Required only in the local process environment:

- `ALIBABA_MODEL_STUDIO_API_KEY`
- `ALIBABA_MODEL_STUDIO_WORKSPACE_ID`
- `ALIBABA_SMOKE_PUBLIC_PRODUCT_URL`
- `ALIBABA_SMOKE_ALLOWED_HOSTS`

Optional:

- `ALIBABA_MODEL_STUDIO_REGION=eu-central-1`

## Output

Journal, downloaded image/video and summary are written under the operating-system temporary directory:

`<tmp>/nordla-alibaba-smoke/<timestamp>/`

Nothing is written to Git.

## Command

After the environment variables are configured:

`npm run marketing-creative:smoke`

After the run, compare the JSONL journal and summary to the Alibaba billing/usage dashboard. Do not register smoke-test outputs as benchmark evidence.
