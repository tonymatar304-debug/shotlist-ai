# CLAQE roadmap

The working plan for `/claqe`. Claude updates it after every verified commit. The user approves milestones by changing their status to **Approved**. Tasks marked **[needs approval]** or **[blocked]** are never started automatically.

## Status

| | |
|---|---|
| Branch | `claude-development` (never `main`) |
| Last verified commit | `57cf294`: phone validation procedure (pushed) + `/claqe` workflow setup (local) |
| Last pushed commit | `7bbb3ca` |
| Last full test run | 2026-11-18 after the review fixes: frontend 127/127, backend 72/72 |
| Current work | **Approved experiment (2026-11-18): editing intelligence + export quality** (below). M8: original-camera HDR/HEVC checks pending (not blocking) |

## Approved experiment: editing intelligence, export quality, colour (2026-11-18)

The user rejected both gym films (cuts random, tripod shake picked as action, cheap-filter colour, poor export). Local, non-paid fixes are done. A real AI test needs approval.

**Root causes (measured on the 3 gym clips):**
- **Editing:**
  - Motion was measured on 96×54 frames squashed to 16:9, with whole-pixel camera tracking. The camera read zero in 97% of samples, so vibration, compression noise and passers-by all counted as subject action.
  - Ranking within each clip inflated small motion.
  - People and hands crossing the lens were the biggest changes, so they ranked as highlights and were even treated as scene cuts.
  - Stacked variety penalties forced clip alternation onto empty frames.
  - Semantic AI was never active (no API base or Turnstile key configured, `CLAQE_VISION` opt-in). It saw only 12 single stills, which can't separate setup, action and walk-off.
- **Export:**
  - 360×640 output, below the 464–576 px sources: an 8–12 dB loss.
  - zoompan reset every frame: no zoom, only a soft resample (−27% detail).
  - x264 ultrafast CRF 28 Baseline with deblocking off: visible 8×8 blocks (block-edge ratio 1.20–1.24).
- **Colour:** the grade darkened by 4–7 levels and crushed shadows. The teal/orange split-tone made it look like a filter. Shot matching darkened a well-exposed clip. No colour tags.

**Done (local, unit-tested; review fixes applied):**
- **Analysis:**
  - Block motion field on aspect-correct 128 px frames: a coarse global shift (±12 px), then per-block sub-pixel search. Camera and subject motion are separated.
  - Jitter flag for vibration.
  - Transient flag for something crossing the lens: not a highlight, not a cut.
  - Motion scored mostly on absolute size.
  - Planner quality floor and gentler variety penalties.
- **Export:**
  - Film size taken from the footage: the largest clip's short side, 360–720 px (540 max on phones and low-memory devices).
  - zoompan removed.
  - x264 veryfast CRF 21 High profile with BT.709 tags.
  - The watermark scales with the film.
- **Colour:**
  - Tone curve (lutyuv) with black and white points pinned; the S-curve is faded out on dark shots.
  - No split-tone. Dynamic uses vibrance instead of saturation.
  - Exposure matching only outside 0.10–0.70 mean luma. Contrast and saturation matching only ever raise.
  - Explicit BT.709 matrices around the RGB filters (no-op round trip: ΔE 0.02–0.07, against 0.5–1.4 before).
  - **Bug found:** FFmpeg 5.1 `colorbalance` midtone terms (`rm`/`gm`/`bm`) are a no-op on every pixel format (measured; shadows and highlights work). Shot-to-shot white-balance matching had therefore never had any effect. It now uses `colorchannelmixer` channel gains (e2e: warm cast R−B 0.230 → 0.200), and Vintage's warmth moved to shadows and highlights.
- **Semantic v2 ("timeline"):**
  - One time-labelled contact sheet per clip. The model segments the whole clip into setup, action, peak, rest, ending, transition, handling or irrelevant, plus key moments. The planner never uses handling or irrelevant footage.
  - Worker `/vision` accepts `version: 2` (`src/timeline.js`) with capped inputs and output, a priced-model-only `VISION_MODEL` dev override, and full accounting of budget overruns.
  - Mock-tested only. `manual/real-timeline.mjs` does a free dry run, or one paid call per model with `CLAQE_CONFIRM_PAID=yes`.

**Measured (gym clips, Edge on this PC):**

| | Before | After |
|---|---|---|
| Output | 360×640 Baseline, ~0.9 Mb/s, untagged | 576×1024 High, ~1.7 Mb/s, BT.709 |
| Block-edge ratio (source ≈ 1.01) | 1.20–1.24 | 1.04–1.08 |
| PSNR vs source, grade included | 21–22 dB | 26–27 dB (SSIM 0.90) |
| Cinematic ΔE vs source | 3.6 | 2.7 |
| Render (30 s film) | ~57 s | ~145 s |
| Peak browser memory | ~640–680 MB | ~745 MB |

**Real timeline-vision comparison (2026-11-18, approved one-time test, $0.50 cap):**
- One request per model, same 3 contact sheets (28/20/18 tiles, ~4,650 input tokens).
- Total **$0.0654**:

| Model | Cost | Time | Output tokens |
|---|---|---|---|
| Haiku 5.5 | $0.0010 | 25.6 s | 1,152 |
| Sonnet 5.5 | $0.0185 | 12.8 s | 920 |
| Opus 5.5 | $0.0458 | 19.2 s | 1,361 |

- The runner enforces a hard cap (`CLAQE_MAX_USD`; worst case checked before every request; failed calls counted at worst case).

**Segmentation accuracy (checked against the contact sheets):**
- **Opus:** flagged the passer-by, the empty frames, the hand at 46 s and both walk-offs as handling or irrelevant.
- **Sonnet:** coarser. It missed the passer-by and called the walk-to-camera an "ending".
- **Haiku:** labelled standing up and walking off as the "peak" and misread the exercise.

**AI-directed films** (replayed from the saved replies through the real app; no extra calls):

| Model | Bad shots (handling, walk-in/off) | Render time |
|---|---|---|
| Opus | 0/6 Cinematic, 0/16 Dynamic | 128–134 s |
| Sonnet | 0/6 Cinematic, 3–4/16 Dynamic | 121–141 s |
| Haiku | 1/6 Cinematic, 3/16 Dynamic | 140–148 s |

- Peak browser memory 770–845 MB.
- Planner fix from the test: only model moments rated ≥ 0.6 seed the edit (a "walks toward the camera" moment rated 0.4 had been promoted to a highlight).
- The user judges creative quality. Decisions are relevant now, but pacing still follows fixed shot-length patterns, and the Opus Dynamic edit is 16 rep shots with no setup or finish arc.

**Still open:**
- Choose the production vision model. Opus decided best; Haiku is ~45× cheaper but made wrong calls. Decide after the user's review.
- Pacing that follows the action (cut on rep or phase boundaries) instead of fixed shot-length patterns.
- An e2e test for the timeline path with a real render.
- Measure 540p/720p memory on real phones (M13).

## Current approved milestone: M8 Real phone footage validation

Goal: prove CLAQE handles original iPhone and Android recordings: HEVC, HDR, orientation, audio, colour accuracy and export reliability. Procedure: `docs/PHONE_FOOTAGE_TESTING.md`.

- [x] **Round 1 (2026-11-16): WhatsApp-shared clips.** 4 gym clips, all H.264 Baseline 8-bit SDR (WhatsApp re-encodes them, so these are *not* camera originals). Results below.
- [ ] **[blocked: needs camera originals copied over USB, not WhatsApp]** Run `tests/e2e/phone-check.mjs` on original iPhone clips (HDR on/off, 4K, low light, ProRes) and Android clips (HDR10, 4K60), plus the iPhone's own SDR export of the HDR clip.
- [ ] Settle the HLG shadow convention using the iPhone's own SDR export: display-light (current, lighter shadows) or scene-light (BT.2408 reference). Change it only if real footage shows a clear mismatch (mean RGB shift).
- [ ] Measure HEVC decode time and memory for real 1080p and 4K clips (render-bench and the phone-check render time).
- [x] Full-app runs with 3 real (WhatsApp) clips, twice in a row, repeated 3 times: 6/6 "Film ready", every clip used, 38–82 s per render. Repeat with camera originals.
- [ ] Fix any defects found, with a regression test or fixture for each, kept small and out of Git if the source footage is personal.
- [ ] Write up the results in this file.

### Round 1 results: WhatsApp-shared clips (H.264 SDR)

| clip | size / length | detected | rotation | render s | ΔE mean / p95 vs itself | RGB shift | upright | audio |
|---|---|---|---|---|---|---|---|---|
| 10.33.03 (1) | 11.5 MB / 55 s | 464×832, 50 fps, VFR | 0 | 92 | 2.15 / 7.34 (motion + watermark) | [0,1,3] | yes | −23.7 LUFS |
| 10.33.03 | 8.3 MB / 39 s | 1024×576, 30 fps | 270 | 54 | 1.06 / 2.96 | [0,0,1] | yes | −21.5 LUFS |
| 10.33.04 (1) | 7.6 MB / 36 s | 464×832, 60 fps | 0 | 34–56 | 1.38 / 2.47 | [−1,1,2] | yes | −22.5 LUFS |
| 10.33.04 | 11.2 MB / 65 s | — | — | — | refused: over the 60 s limit (correct) | | | |

Findings:
- SDR footage passes through unchanged: mean ΔE is under 3, and the remaining difference comes from motion and the watermark, not colour.
- Rotation 270 and variable frame rate are handled; audio is decoded and levelled.
- `phone-check` used to time out on a refused clip; it now prints CLAQE's refusal note.
- HEVC and HDR aren't covered yet, because WhatsApp strips them.

## Remaining priorities (not yet approved: the user approves each milestone)

1. **M9 WORKERFS lazy loading:** validate it on real phone files (iOS Safari, Android Chrome) for memory, speed and failure fallback; enable by default only after approval. Keep the upload limits unchanged until then.
2. **M10 Real-music beat test:** 6–8 Free Music Archive CC0 tracks (licences verified; files kept out of Git), with librosa as an independent reference in an isolated Python environment (not a runtime dependency); measure cut-on-beat accuracy.
3. **M11 Purposeful visual effects and polish:** motion-aware zooms, restrained style effects, dissolves last; keep the minimal UI; budget about 15% render time and about 50 MB memory.
4. **M12 Faster 4K/HEVC:** WebCodecs decode path for H.264 (feasible without a demuxer; about 3× faster per 4K shot, limited by pixel readback), HEVC where the device supports it.
5. **M13 Real-device testing → mobile app:** device matrix, iOS memory limits, then app packaging options.

## Known bugs, limits and blockers

- HEVC decoding in FFmpeg.wasm is slow, and on PCs without HEVC support the browser can't preview HEVC (CLAQE then uses the basic edit plan and tells the user).
- HLG → SDR shadows come out lighter than the BT.2408 scene-light reference (black 27 vs 14 on the test chart). Waiting on real-footage comparison.
- Dolby Vision profile 5 can't be converted (detected and noted). This FFmpeg build has no AV1 decoder.
- libx265 can't run in single-threaded FFmpeg.wasm (HEVC test fixtures can't be generated locally).
- Audio can end up to 6 ms short of the video on the last frame (mkv intermediate timestamps); this doesn't affect sync.
- The memory floor is about 680 MB (1080p) and about 950 MB (4K), which is borderline for iOS Safari.
- The Real-music beat test is blocked until the user downloads the FMA tracks.
- **Fixed (test-only):** the backend test "pass limit: 30 valid requests allowed, 31st gets 429" failed intermittently (seen 1 in 2 runs on 2026-11-16: 200 instead of 429).
  - Cause: rate-limit windows are fixed 600 s buckets aligned to the clock (`src/worker.js`). A test run crossing a 10-minute boundary resets the counter, about 1.3% of runs. The IP-limit test has the same exposure.
  - Fix: both tests now wait for a window with at least 60 s left (`freshRateWindow` in `test/helpers.mjs`).
  - Added tests: the window logic is unit-tested with a fixed clock, the constant is checked against the worker, and a regression test shows a full count in the previous window doesn't block the current one.
  - The worker's clock can't be mocked (it runs in a `wrangler dev` subprocess), so production code is unchanged.

## Completed milestones

| Milestone | Commits | Result |
|---|---|---|
| M0 Site, mobile clip intake | `0d99bac`…`ebfd930` | Homepage, lab, mobile multi-select |
| M1 Backend quotas + AI edit plan | `b9f21a6`, `22e947c` | Cloudflare Worker (dev), Turnstile, free quotas, backend tests |
| M2 Renderer verified, footage-aware planner, vision | `421ff86`…`10756ba` | Local analysis planner, AI vision (mock-tested), story ordering |
| M3 Renderer audio + sync | `b51b015`, `466d1e3` | Original audio, frame-exact shots, beep/flash sync tests |
| M4 Audio reliability, beat-aware music | `29975cd` | Levelling, ducking, cuts on beats |
| M5 Cinematic finishing (phases 1–2) | `3215019`, `dd4fdcf`, `92072ca` | Hard cuts, start/end fades, shot matching, refined looks |
| M6 Sequential renderer | `b5da88c`, `708a415` | Peak 4K×16 2554→947 MB, pixel-identical, single pass as fallback |
| M7 Phone footage support | `33feec6`, `57cf294` | HDR detection + CLUT tone mapping (ΔE ≈ 2 vs SDR), browser-decode fallbacks, portrait/VFR verified, phone-check tool |

## Next recommended milestone

After M8: **M9 WORKERFS lazy loading** on real phone files. It removes the per-clip in-memory copy, which matters for 300–450 MB phone clips and is the prerequisite for ever raising the upload limits.
