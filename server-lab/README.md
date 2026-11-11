# CLAQE — Private cloud-rendering proof of concept

**Status: Code prepared, not deployed; live website untouched.** The code is on branch `claqe-v1-dev` in `server-lab/`. It is a standalone Cloudflare Worker and browser test page; it does not modify or replace the existing `shotlist-api` or `shotlist-api-dev` Workers.

## Why

The existing browser prototype runs FFmpeg on the phone, which fails for normal modern iPhone videos due to file size, memory, and codecs. This test sends large clips directly to the Shotstack Ingest API and renders them via Shotstack's server-side Edit API. It uses Shotstack's **sandbox / stage** environment.

What this test attempts:
- Select 2–4 files, each up to 500 MB, on phone or desktop.
- Obtain signed upload URLs from the Cloudflare Worker without exposing the rendering API key.
- Upload directly from the browser to the rendering provider.
- Poll ingestion readiness, then submit a **real** server-rendered 30-second-or-shorter MP4 edit.
- Apply basic style-dependent effects and show a CLAQE watermark.
- Poll the render and show/download the MP4.

**Not yet AI:** This version follows input clip order and simple editing rules. Content-aware creative direction, automatic highlights, licensed music, preservation/mixing of source audio, remixes and CLAQE Touches are future work.

## Setup (owner only)

1. Create a Shotstack sandbox account/API key at https://shotstack.io/. Check current pricing and credits before creating paid renders.
2. Install Node.js and Wrangler CLI on a development computer, then authenticate Wrangler to Cloudflare.
3. From the repo root, deploy a **new, separate** worker, rather than touching any existing Workers:

   ```sh
   npx wrangler deploy server-lab/worker.js --name claqe-render-dev --compatibility-date 2026-11-11
   npx wrangler secret put SHOTSTACK_API_KEY --name claqe-render-dev
   npx wrangler secret put CLAQE_DEV_TOKEN --name claqe-render-dev
   ```

4. Use a random secret **at least 20 characters** for `CLAQE_DEV_TOKEN`, distinct from existing Worker secrets. Never put the provider key or dev token into GitHub code, URLs, or public HTML.
5. Serve repo files locally, e.g. `python -m http.server 8000`, and open `http://localhost:8000/server-lab/`. Enter the new Worker's HTTPS URL and the secret into the private test page.
6. Choose two smallish clips for the initial test. Confirm upload, ingest, render, preview, and watermark all work before increasing sizes.

**Important:** The Worker allows browser calls from only `https://claqe.com`, `https://www.claqe.com`, `http://localhost:8000` and `http://127.0.0.1:8000`. The temporary signed uploads go directly to Shotstack's storage and may need compatible CORS behavior from that provider.

## Privacy and safety

**Do not make this public as a product.** The dev-only secret is not real user authentication, and this Worker does not have:
- Server-enforced atomic spending caps or per-user monthly quotas;
- Registration, authorization, project ownership, or audit logs;
- Automatic deletion of uploaded sources / rendered outputs;
- Malware scanning, abuse protection, rate limits, or an upload-permit ledger;
- Production-grade secret rotation and hardened browser security.

Shotstack's Ingest API makes uploaded source files available to anyone with the hard-to-guess direct source URL until deleted. Do **not** use confidential videos in this version. Uploaded files will be handled outside your phone by the provider, not privately in R2. Later we can add private Cloudflare R2 storage and signed URLs with a stronger production privacy architecture.

The browser view supports selecting 2–4 videos for this backend, not unlimited clips. The backend validates the number and length of clips and limits each generated video to under 30 seconds. It does not yet validate that the actual file uploaded matches the filename/size asserted while requesting a ticket. That's another reason this version must remain private.

## Verification

- JavaScript syntax of both the Worker and browser test page was checked while authoring.
- **Cloudflare deployment, Shotstack API calls, S3 signed upload CORS, and actual MP4 output are NOT tested yet.**
- No sandbox credits or other charges have been used or authorized during creation.
- Nothing has been changed in Cloudflare, and the public `claqe.com` site remains on the previous mobile upload prototype.

## API endpoints

- `GET /health` - public health response, no credentials.
- `POST /api/upload-ticket` - requests signed upload URL (development token required).
- `GET /api/source-status?id=...` - checks ingest status (development token required).
- `POST /api/render` - creates a stage render from 2–4 ingested sources (development token required).
- `GET /api/status?id=...` - checks render status and returns output URL after completion (development token required).

Every authenticated call uses the `X-CLAQE-DEV-TOKEN` HTTP header.

## Next

Once the private test succeeds, replace the dev token with production accounts; introduce quota reservations and server-side cost controls **before** exposing upload or render tickets to the public. Then add scene understanding and real video-specific creative edits.

References:
- https://shotstack.io/docs/guide/ingesting-footage/sources/
- https://shotstack.io/docs/api/
- https://shotstack.io/pricing/
- https://help.shotstack.io/en/articles/16938396-understanding-the-ingest-api
