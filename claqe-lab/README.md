# CLAQE rendering lab (development only)

This is an experimental browser-based video editor proof of concept. It is isolated in branch claqe-v1-dev at claqe-lab/index.html. The live website, Cloudflare Workers, D1, DNS and main branch are unchanged.

## Goal
Test whether 2–4 short clips can be joined and exported as an actual MP4, including basic color grades (Cinematic/Dynamic/Vintage), subtle per-clip zoom, fade cuts, portrait/landscape crops and an embedded CLAQE watermark, with output under 30 seconds.

This lab is NOT AI-powered. It follows fixed editing rules and the original clip order, and does not interpret video content or generate creative scene-specific editing decisions. Output has no audio. Fades are applied within shots, not overlapping transitions.

## How to test
1. Switch to branch claqe-v1-dev.
2. Download or clone the repo and serve it with a local HTTP server, for example: python -m http.server 8000
3. Open http://localhost:8000/claqe-lab/
4. Use Chrome or Edge on desktop; choose 2–4 short MP4 clips.
5. Select style and aspect, click Create my film, and inspect/download the output if encoding succeeds.

Do not merge or deploy the lab yet. The video engine JavaScript and WebAssembly are loaded from jsDelivr. Network is needed for first load. Processing happens in the browser and may be slow or fail on some devices or unusual source codecs. Files are not uploaded to a server.

## Technical notes
- FFmpeg.wasm 0.12.15 and FFmpeg core 0.12.10 are loaded from a CDN.
- Uses trim, scale, crop, zoompan, eq, fade, concat, overlay and libx264.
- Output is deliberately low-resolution (360x640 or 640x360), silent and watermarked.
- Client-side upload and export limits are not secure; enforce them server-side in production.
- END-TO-END BROWSER TESTING IS NOT YET COMPLETE. A representative FFmpeg filtergraph was tested in a local native FFmpeg runtime; browser loading and exporting may require fixes.

## Next steps
1. Verify browser end-to-end export with real phone footage; debug issues.
2. Add audio, real transitions, and reliable processing across devices.
3. Decide between an affordable hosted rendering service and dedicated video processing.
4. Add footage understanding and genuinely individualized edits; no fixed sequences.
5. Add limited CLAQE Touches and production quotas before launch.
