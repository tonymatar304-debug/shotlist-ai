# Testing CLAQE with real phone recordings

A local, free procedure for checking iPhone and Android footage in CLAQE. It needs no paid services and makes no uploads; everything runs on your computer.

## 1. Record a small test set (about 10 s each)

Film a scene with a person (skin), a window or the sky (highlights), shade (shadows) and a strong colour. Clap once in view at the start of each clip so you can check sync by eye.

| # | Phone and setting | What it checks |
|---|---|---|
| 1 | iPhone, default camera (HDR Video ON), held upright | HEVC, 10-bit HLG / Dolby Vision 8.4, portrait rotation |
| 2 | iPhone, HDR Video OFF (Settings › Camera › Record Video) | HEVC SDR (must be untouched) |
| 3 | iPhone, landscape, 4K 30 fps | 4K decoding time and memory |
| 4 | iPhone in low light, 1080p | variable frame rate and A/V sync |
| 5 | iPhone 15 Pro or later in ProRes (optional) | ProRes HLG |
| 6 | Android, default camera, held upright | H.264 or HEVC SDR, rotation |
| 7 | Android with HDR10 / HDR10+ video on (if available) | PQ |
| 8 | Android 4K 60 fps | high frame rate |

Keep every clip within CLAQE's limits: 80 MB per clip, 180 MB in total, and at most 60 s.

## 2. Copy the originals without conversion

- **iPhone to PC:** use a USB cable and Windows Photos, or iCloud for Windows with "Download originals". If you AirDrop to a Mac, choose **Options › All Photos Data**. Without it, iOS may convert HDR to SDR and HEVC to H.264.
- **Trusted SDR reference (iPhone):** also export clip 1 converted to SDR by the phone itself. In Photos, Share › Options, turn HDR off (or use "Most Compatible"). Name it like `IMG_0001-sdr.mov`.
- **Android:** use a USB cable (File Transfer mode) and copy from `DCIM/Camera`.

Keep the clips outside the repository (for example `Documents/Projects/claqe-media/phones/`). They must not be committed.

## 3. Run the check (from `tests/`)

```
node e2e/phone-check.mjs <original> [phone's SDR export] [output folder]
```

The tool renders the clip through the real app (sequential renderer, style look neutralised) and prints:

- **detected:** codec, bit depth, primaries / transfer, HDR kind (`hlg`, `pq` or `null` for SDR), Dolby Vision profile, rotation and whether the frame rate is variable;
- **note:** what CLAQE told the user, such as "HDR footage converted to standard range" or the basic-plan note when the browser can't preview the clip;
- **comparison** of one frame against the reference: ΔE2000 mean, median and p95, plus the mean RGB shift. With no reference given, an SDR clip is compared with itself and must stay at ΔE ≈ 0.
- **side-by-side PNG** (CLAQE on the left, reference on the right) in the output folder. By default this is `%TEMP%\claqe-phone-check`.

## 4. What to look for

| Area | Check | Pass |
|---|---|---|
| HEVC | `codec: "hevc"` detected; film produced; note the render time | yes, render completes |
| HDR | iPhone HDR detected as `hlg` (Dolby Vision 8.4 also shows `dolbyVision`); HDR10 as `pq`; note says "HDR footage converted" | yes |
| SDR | `hdr: null`; compared with itself ΔE ≈ 0 (CLAQE never alters it) | ΔE < 1 |
| Colour accuracy | HDR clip vs the phone's own SDR export: ΔE mean and the RGB shift; check skin, shadows and sky in the PNG | mean < 3 very close; 3–6 noticeable; > 6 investigate |
| Orientation | portrait clips upright in the PNG and in the film (rotation 90 or 270 in `detected`) | upright |
| Audio | `audio:` line shows loudness (sound decoded and levelled) | not "none" for clips with sound |
| Sync | the clap sound lands on the frame where the hands meet | within 1 frame (42 ms) |
| Variable frame rate | low-light clip shows `vfr: true` and stays in sync | yes |
| Export reliability | every clip gives "Film ready"; every clip is used, also when the note says the browser couldn't preview it | no failures |

**Full-app run (export reliability):** serve the project folder locally the way you normally do and open `index.html` in Chrome or Edge. Add 3–5 of the clips together (within the limits), create the film twice in a row, then watch it on a phone. Note any "Export failed" message, the time each render takes, and anything that looks or sounds wrong.

## 5. Report back

For each clip, paste the tool output and fill in one line:

```
clip | phone + setting | codec | hdr | rotation | render s | ΔE mean vs phone SDR | RGB shift | upright? | clap in sync? | problems
```

Add the browser and computer you used. For HDR clips, the RGB shift against the phone's SDR export is the key number: it shows whether CLAQE's HLG conversion is brighter or darker in the shadows than Apple's. That is the open tuning question.

## Known limits (current build)

- HEVC decoding depends on FFmpeg.wasm, which is slow: about 4–5× slower than H.264 at the same size. The browser's own HEVC decoder (WebCodecs) is only available where the device supports it (Safari, or Windows with HEVC hardware or the extension).
- Dolby Vision profile 5 (rare on phones) has no compatible base layer. Its colours can't be converted correctly, and CLAQE says so in the note.
- AV1 recordings can't be decoded: this FFmpeg build has no AV1 decoder.
