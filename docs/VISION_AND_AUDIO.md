# CLAQE: semantic vision and audio plan (design; nothing here calls a paid API)

## 1. Where local analysis stops
`claqe-analyze.js` measures exposure, detail, subject motion, camera pan/shake, scene cuts and look distinctiveness. It cannot know **what** is in a shot,
so it cannot tell a title card from a scene, a face from a wall, or the moment a ball is caught from a person standing still. Real clips showed it correctly
skips fades/black frames and never cuts across a scene change, but it ranks title cards and credits as "distinct looks".

## 2. Vision pipeline (prototype in `claqe-vision.js`, mock-tested)
1. Local analysis runs first (free, on-device) -> `pickFrameTimes` picks <= 12 moments per film (interest peaks, scene starts, even coverage).
2. `buildVisionRequest` -> JSON with durations, times, local scores only (no file names / user ids). `captureFrames` makes <= 512 px JPEGs (~25 KB each, ~300 KB per film).
3. **One** call per film to a new Worker route (`/vision`, not built): same pass cookie, Turnstile, free-quota and budget ledger as `/generate`; the model replies in the schema below.
4. `validateVisionResponse` treats the reply as untrusted (known ids only, clamped numbers, cleaned strings, rejects mostly-bad replies).
5. `applyVision` attaches `importance / role / caption` to nearby samples (<= 2.5 s, never across a scene cut). `planFilm` blends it with the local score
   (<= 50 %), so local quality signals still matter and the SAME planner and FFmpeg renderer produce the film. Semantic captions become the shot reasons.
6. Failure at any step -> the local plan, labelled "local analysis (not AI)". "AI vision" is only shown when a validated model reply was used.

Response schema (v1): `{version:1, story, frames:[{id, importance 0..1, subject, action, setting, mood, shotType: wide|medium|close|detail|aerial|title|other, usable, issues[], role: opener|highlight|closer|filler|avoid}]}`.

What vision adds: subject and action ("child blows out candles"), narrative role (opener/closer), unusable or boring-but-bright frames, duplicates of the same subject, titles/credits.

## 3. Cost control (verify current prices before enabling; none enabled)
- One call per film, <= 12 small images + ~1 KB JSON, small fast model. Cost per film ~ (images x tokens per image + text) x model price; compute from the provider's current price list.
- Cache by hash of (file size, name-free content sample, style, frame times) in the browser; re-renders and style changes reuse it. Style change needs no new call (style only changes planner weights).
- Counts as one "AI edit" against `free_monthly_limit` and the daily/monthly budget ledger; refunded on failure (as `/generate`).
- Frames leave the device -> explicit consent text before the first call; frames are not stored by the Worker.
- Needs approval before: building `/vision`, any real model call, any deploy.

## 4. Audio (renderer currently drops audio: `-an`)
- **Stage 1, keep original sound:** per shot `[src:a]atrim=start:duration,asetpts=PTS-STARTPTS,afade in/out`; clips without audio use `anullsrc`; join with `concat` (v=1:a=1) or 0.15 s `acrossfade`. Re-verify A/V sync with a beep+flash fixture (cut points must match to < 40 ms). Needs `-c:a aac`; memory impact to be measured.
- **Stage 2, music:** user supplies a track (no licensed library yet). Browser decodes it with Web Audio, finds onsets/tempo locally, and the planner gets a `beatGrid`: cut times snap to the nearest beat within +-0.25 s (shot lengths adjust, total stays 30 s). Original audio is ducked (-12 dB) under music, or dropped for "music only".
- **Stage 3, semantic + audio:** speech/laughter windows (from vision role or local energy) are protected from cuts and from ducking.
