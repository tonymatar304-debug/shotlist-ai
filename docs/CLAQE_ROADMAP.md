# CLAQE roadmap

The working plan for `/claqe`. Claude updates it after every verified commit. The user approves milestones by changing their status to **Approved**. Tasks marked **[needs approval]** or **[blocked]** are never started automatically.

## Status

| | |
|---|---|
| Branch | `claude-development` (never `main`) |
| Last verified commit | `57cf294`: phone validation procedure (pushed) + `/claqe` workflow setup (local) |
| Last pushed commit | `57cf294` |
| Last full test run | 2026-11-16 on `57cf294`: frontend 114/114, backend 64/64 (+5 guard unit tests added with the setup) |
| Current milestone | **M8 Real phone footage validation** (Approved, blocked: waiting for the user's clips) |

## Current approved milestone: M8 Real phone footage validation

Goal: prove CLAQE handles original iPhone and Android recordings: HEVC, HDR, orientation, audio, colour accuracy and export reliability. Procedure: `docs/PHONE_FOOTAGE_TESTING.md`.

- [ ] **[blocked: needs the user's clips]** Run `tests/e2e/phone-check.mjs` on each clip (iPhone HDR on/off, portrait, 4K, low light, ProRes; Android SDR, HDR10, 4K60) and fill in the results table.
- [ ] Settle the HLG shadow convention using the iPhone's own SDR export: display-light (current, lighter shadows) or scene-light (BT.2408 reference). Change it only if real footage shows a clear mismatch (mean RGB shift).
- [ ] Measure HEVC decode time and memory for real 1080p and 4K clips (render-bench and the phone-check render time).
- [ ] Full-app runs with 3–5 real clips, twice in a row: no failures, every clip used.
- [ ] Fix any defects found, with a regression test or fixture for each, kept small and out of Git if the source footage is personal.
- [ ] Write up the results in this file.

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
