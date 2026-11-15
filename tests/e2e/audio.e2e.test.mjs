// REAL original-audio tests: real FFmpeg.wasm render, then the exported MP4 is decoded in Edge (WebAudio for sound,
// <video> seeks for pictures). A/V sync is measured with a beep-and-flash clip: every 60 ms beep must start within
// ~1 frame of its white flash. Slow (~2-4 min). Run: cd tests && npm run e2e
import { test, before, after, beforeEach, afterEach, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { staticServer, listen, launch, routeRealFfmpeg, FIXTURES } from "./lib.mjs";
import { routeTurnstileStub, routeApi, newApiState, openUrl } from "./mocks.mjs";

const fx = (n) => ({ name: n, mimeType: "video/mp4", buffer: fs.readFileSync(path.join(FIXTURES, n)) });
const BEEP = "beep-flash-6s.mp4", RG = "red-green-3s.mp4", BLUE = "blue-3s.mp4"; // BEEP: flash+beep at 0.5, 2.0, 3.5, 5.0 s
const BAD = "bad-audio-6s.mp4", QUIET = "beep-flash-quiet-6s.mp4", TONE = "tone-6s.mp4", MUSIC = "music-120bpm.m4a"; // see make-fixtures.mjs
const SYNC_MS = 42; // one frame at 24 fps
let web, port, browser, ctx, page;

before(async () => { web = staticServer(); port = await listen(web); browser = await launch(); });
after(async () => { await browser?.close(); web?.close(); });
beforeEach(async () => {
  ctx = await browser.newContext();
  await routeRealFfmpeg(ctx); await routeTurnstileStub(ctx); await routeApi(ctx, newApiState());
  page = await ctx.newPage();
});
afterEach(async () => { await ctx?.close(); });

const fixPlan = async (plan) => {
  await page.addInitScript((p) => { window.__fixedPlan = p; }, plan);
  await page.goto(openUrl(port, false));
  await page.evaluate(() => { const o = window.ClaqeAnalyze.planFilm; window.ClaqeAnalyze.planFilm = (c, s, f) => ({ ...o(c, s, f), plan: window.__fixedPlan }); });
};
const addClips = async (files) => { await page.setInputFiles("#clips", files.map(fx)); await page.waitForFunction(() => !document.getElementById("create").disabled, null, { timeout: 20000 }); };
const render = async () => {
  const before = await page.getAttribute("#download", "href");
  const t0 = Date.now();
  await page.click("#create");
  await page.waitForFunction((b) => /Film ready|Export failed/.test(document.getElementById("status").textContent) && document.getElementById("download").href !== b, before, { timeout: 240000 });
  assert.match(await page.textContent("#status"), /Film ready/, await page.textContent("#status"));
  return (Date.now() - t0) / 1000;
};

// Decode the export: audio onsets (|x| > 0.1 after >= 0.2 s quiet), and for each onset the first bright video frame nearby.
// highpass: run the decoded sound through 2 x 700 Hz high-pass first (removes the 60/330 Hz test music, keeps the 1 kHz beep).
// bands: [[a, b, hz]] -> amplitude of that frequency in that time range (Goertzel). Also reports the overall sample peak.
async function measure({ silentAt = [], highpass = false, bands = [], ignore = [] } = {}) {
  return page.evaluate(async ({ silentAt, highpass, bands, ignore }) => {
    const href = document.getElementById("download").href, buf = await (await fetch(href)).arrayBuffer();
    const latin = new TextDecoder("latin1").decode(new Uint8Array(buf));
    const out = { hasAudioTrack: /soun/.test(latin) && /mp4a/.test(latin), onsets: [], flashes: [], offsetsMs: [], silentRms: [] };
    const v = document.createElement("video"); v.muted = true; v.src = href; v.preload = "auto";
    await new Promise((r, j) => { v.onloadedmetadata = r; v.onerror = () => j(new Error("not playable")); });
    out.duration = v.duration;
    if (!out.hasAudioTrack) return out;
    const ab = await new OfflineAudioContext(1, 1, 48000).decodeAudioData(buf.slice(0));
    const raw = ab.getChannelData(0), sr = ab.sampleRate; out.audioDuration = ab.duration; out.channels = ab.numberOfChannels;
    out.peak = 0; for (let c = 0; c < ab.numberOfChannels; c++) for (const x of ab.getChannelData(c)) out.peak = Math.max(out.peak, Math.abs(x));
    out.bands = bands.map(([a, b, hz]) => { const i0 = Math.floor(a * sr), i1 = Math.min(raw.length, Math.floor(b * sr)), w = 2 * Math.PI * hz / sr; let re = 0, im = 0; for (let i = i0; i < i1; i++) { re += raw[i] * Math.cos(w * i); im -= raw[i] * Math.sin(w * i); } return 2 * Math.hypot(re, im) / Math.max(1, i1 - i0); });
    let ch = raw;
    if (highpass) {
      const oc = new OfflineAudioContext(1, raw.length, sr), s = oc.createBufferSource(), b = oc.createBuffer(1, raw.length, sr); b.copyToChannel(raw, 0); s.buffer = b;
      const f1 = oc.createBiquadFilter(), f2 = oc.createBiquadFilter(); f1.type = f2.type = "highpass"; f1.frequency.value = f2.frequency.value = 700;
      s.connect(f1); f1.connect(f2); f2.connect(oc.destination); s.start(); ch = (await oc.startRendering()).getChannelData(0);
    }
    out.beepPeaks = [];
    let quiet = 1e9; for (let i = 0; i < ch.length; i++) { if (Math.abs(ch[i]) > 0.05) { if (quiet >= 0.2 * sr && !ignore.some(([a, b]) => i / sr >= a && i / sr <= b)) out.onsets.push(i / sr); quiet = 0; } else quiet++; }
    for (const t of out.onsets) { let p = 0; for (let i = Math.round(t * sr); i < Math.min(ch.length, (t + 0.06) * sr); i++) p = Math.max(p, Math.abs(ch[i])); out.beepPeaks.push(p); }
    for (const [a, b] of silentAt) { let s = 0, n = 0; for (let i = Math.floor(a * sr); i < b * sr && i < ch.length; i++) { s += ch[i] * ch[i]; n++; } out.silentRms.push(Math.sqrt(s / Math.max(1, n))); }
    const c = document.createElement("canvas"); c.width = 32; c.height = 32; const g = c.getContext("2d", { willReadFrequently: true });
    const bright = async (k) => { // luma of frame k (seek to its centre; re-read until the painted frame is stable)
      v.currentTime = (k + 0.5) / 24; await new Promise((r) => (v.onseeked = r));
      let prev = -1; for (let n = 0; n < 12; n++) { await new Promise((r) => setTimeout(r, 50)); g.drawImage(v, 0, 0, 32, 32); const d = g.getImageData(8, 8, 16, 16).data; let y = 0; for (let i = 0; i < d.length; i += 4) y += (d[i] + d[i + 1] + d[i + 2]) / 3; y /= d.length / 4; if (Math.abs(y - prev) < 3) return y; prev = y; }
      return prev;
    };
    for (const t of out.onsets) {
      let found = null;
      for (let k = Math.max(0, Math.floor((t - 0.3) * 24)); k <= Math.ceil((t + 0.3) * 24) && found === null; k++) if ((await bright(k)) > 140) found = k / 24;
      out.flashes.push(found); out.offsetsMs.push(found === null ? null : Math.round((t - found) * 1000));
    }
    return out;
  }, { silentAt, highpass, bands, ignore });
}
const lastPlan = () => page.evaluate(() => window.__claqeLast.plan);
const bounds = (plan) => { let t = 0; return plan.map((p) => { const d = Math.round(p.duration * 24) / 24, r = [t, t + d]; t += d; return r; }); };
const dB = (a, b) => 20 * Math.log10(a / b);
const checkSync = (m, n) => {
  console.log(`# A/V offsets (audio - video, ms): ${JSON.stringify(m.offsetsMs)}; duration video ${m.duration.toFixed(3)} s, audio ${m.audioDuration?.toFixed(3)} s`);
  assert.ok(m.hasAudioTrack, "export has an AAC audio track");
  assert.equal(m.onsets.length, n, "beeps found: " + JSON.stringify(m.onsets));
  for (const o of m.offsetsMs) assert.ok(o !== null && Math.abs(o) <= SYNC_MS, "offset " + o + " ms");
  assert.ok(Math.abs(m.audioDuration - m.duration) < 0.1, `audio ${m.audioDuration} vs video ${m.duration}`);
};

describe("original audio", () => {
  test("mixed audio/silent clips, reordered + repeated source: audio kept, in sync, silent shots silent; re-render stays in sync", async () => {
    // shots: BEEP 1.75-3.0 (beep at +0.25) | BLUE silent | BEEP 0.25-1.5 (earlier part, +0.25) | RG silent | BEEP 3.25-4.5 (+0.25)
    await fixPlan([{ src: 0, start: 1.75, duration: 1.25 }, { src: 1, start: 0.5, duration: 1 }, { src: 0, start: 0.25, duration: 1.25 }, { src: 2, start: 0.2, duration: 1 }, { src: 0, start: 3.25, duration: 1.25 }]);
    await addClips([BEEP, BLUE, RG]);
    const secs = await render();
    const m = await measure({ silentAt: [[1.3, 2.2], [3.55, 4.45]] });
    console.log(`# mixed 5-shot render ${secs.toFixed(1)} s; beeps at ${JSON.stringify(m.onsets.map((t) => +t.toFixed(3)))}; silent-shot RMS ${JSON.stringify(m.silentRms.map((x) => +x.toFixed(5)))}`);
    checkSync(m, 3);
    assert.deepEqual(m.onsets.map((t) => Math.round(t * 100) / 100), [0.25, 2.5, 4.75]); // each beep where its shot puts it
    assert.ok(Math.abs(m.duration - 5.75) < 0.1, "duration " + m.duration);
    for (const r of m.silentRms) assert.ok(r < 0.005, "silent shot RMS " + r);
    assert.equal(m.channels, 2); // mono source upmixed to stereo AAC
    assert.match(await page.textContent("#resultNote"), /Original clip audio kept \(silent clips stay silent\)/);
    await page.click('button[data-style="dynamic"]'); await page.click('button[data-format="landscape"]');
    await render();
    checkSync(await measure(), 3);
  });

  test("shot starts/lengths NOT on frame boundaries stay within one frame", async () => {
    await fixPlan([{ src: 0, start: 1.83, duration: 1.3 }, { src: 0, start: 0.31, duration: 1.37 }, { src: 0, start: 4.61, duration: 1.13 }]);
    await addClips([BEEP, BLUE]);
    await render();
    checkSync(await measure(), 3);
  });

  test("real planner on a clip with sound: every kept beep lands on its flash", async () => {
    await page.goto(openUrl(port, false));
    await addClips([BEEP, BLUE]);
    await render();
    const m = await measure();
    assert.ok(m.onsets.length >= 1, "at least one beep in the film");
    checkSync(m, m.onsets.length);
  });

  test("undecodable audio stream: export still succeeds, that clip plays silent, the other clip's sound stays in sync", async () => {
    await fixPlan([{ src: 0, start: 1.75, duration: 1.25 }, { src: 1, start: 1.75, duration: 1.25 }, { src: 2, start: 0.5, duration: 1 }, { src: 1, start: 3.25, duration: 1.25 }]);
    await addClips([BAD, BEEP, BLUE]);
    await render();
    const m = await measure({ silentAt: [[0.05, 1.2]] });
    checkSync(m, 2);
    assert.deepEqual(m.onsets.map((t) => Math.round(t * 100) / 100), [1.5, 3.75]); // only the readable clip beeps
    assert.ok(m.silentRms[0] < 0.005, "bad clip silent");
    assert.match(await page.textContent("#resultNote"), /Clip 1's sound couldn't be read, so it plays silent\./);
  });

  test("undecodable audio is the only sound: video-only film, no error", async () => {
    await page.goto(openUrl(port, false));
    await addClips([BAD, BLUE]);
    await render();
    const m = await measure();
    assert.equal(m.hasAudioTrack, false);
    assert.match(await page.textContent("#resultNote"), /Clip 1's sound couldn't be read/);
  });

  test("volume levelling: a clip 20 dB quieter is brought close to the loud one, no clipping, sync kept", async () => {
    await fixPlan([{ src: 0, start: 1.75, duration: 1.25 }, { src: 1, start: 1.75, duration: 1.25 }, { src: 0, start: 0.25, duration: 1.25 }, { src: 1, start: 0.25, duration: 1.25 }]);
    await addClips([BEEP, QUIET]);
    await render();
    const m = await measure();
    checkSync(m, 4);
    const diff = dB((m.beepPeaks[0] + m.beepPeaks[2]) / 2, (m.beepPeaks[1] + m.beepPeaks[3]) / 2);
    console.log(`# levelling: source difference 20.0 dB -> film ${diff.toFixed(1)} dB; peaks ${JSON.stringify(m.beepPeaks.map((p) => +p.toFixed(3)))}; sample peak ${m.peak.toFixed(3)}`);
    assert.ok(Math.abs(diff) <= 6, "difference after levelling " + diff);
    assert.ok(m.peak <= 0.99, "no clipping, peak " + m.peak);
    assert.match(await page.textContent("#resultNote"), /volume levelled/);
  });

  test("music: beat-aligned cuts, ducking under clip sound, fades, no clipping, sync kept; re-render too", async () => {
    // BEEP | BLUE (silent) | TONE (continuous clip sound) | BEEP | BLUE
    await fixPlan([{ src: 0, start: 1.75, duration: 1.25 }, { src: 1, start: 0.2, duration: 2.2 }, { src: 2, start: 0.5, duration: 2.5 }, { src: 0, start: 3.25, duration: 1.25 }]);
    await addClips([BEEP, BLUE, TONE]);
    await page.setInputFiles("#music", path.join(FIXTURES, MUSIC));
    await page.waitForFunction(() => /BPM|no clear beat|no steady beat|can't be read/.test(document.getElementById("musicNote").textContent), null, { timeout: 20000 });
    const note = await page.textContent("#musicNote");
    assert.match(note, /steady beat, ~120 BPM/, note);
    for (const style of ["cinematic", "dynamic"]) {
      if (style === "dynamic") await page.click('button[data-style="dynamic"]');
      await render();
      const plan = await lastPlan(), b = bounds(plan), end = b[b.length - 1][1];
      // music beats in film time: its first sound (0.4 s) is the film start, then every 0.5 s
      const grid = (t) => Math.abs(((t - 0.01) % 0.5 + 0.5) % 0.5 - (((t - 0.01) % 0.5 + 0.5) % 0.5 > 0.25 ? 0.5 : 0));
      const offs = b.slice(0, -1).map(([, t]) => Math.round(grid(t) * 1000));
      console.log(`# ${style} music cuts at ${JSON.stringify(b.slice(0, -1).map(([, t]) => +t.toFixed(3)))} s; distance to beat (ms) ${JSON.stringify(offs)}; note: ${(await page.textContent("#resultNote")).match(/Music:[^.]*\./)}`);
      assert.ok(offs.every((o) => o <= 37), "cuts on beats (<= half a frame of rounding + 15 ms): " + offs);
      const [blue, tone] = [b[1], b[2]], mid = (r, pad) => [r[0] + pad, r[1] - pad, 330];
      // the TONE shot's own 1 kHz sound passes the high-pass: only the beep shots are checked for sync
      const m = await measure({ highpass: true, ignore: [[tone[0] - 0.05, tone[1] + 0.05]], bands: [mid(blue, 0.45), mid(tone, 0.6), [0, 0.12, 330], [0.9, 1.1, 330], [end - 0.15, end, 330]] });
      checkSync(m, 2);
      const [mBlue, mTone, mHead, mOne, mTail] = m.bands, duck = dB(mBlue, mTone);
      console.log(`# ${style} music level: over silent clip ${mBlue.toFixed(3)}, under clip sound ${mTone.toFixed(3)} (ducked ${duck.toFixed(1)} dB); fade-in ${mHead.toFixed(3)} -> ${mOne.toFixed(3)}; last 150 ms ${mTail.toFixed(3)}; sample peak ${m.peak.toFixed(3)}`);
      assert.ok(mBlue > 0.02, "music audible over the silent clip");
      assert.ok(duck >= 6, "ducked " + duck + " dB");
      assert.ok(mHead < mOne * 0.6 && mTail < mBlue * 0.5, "fades");
      assert.ok(m.peak <= 0.99, "no clipping " + m.peak);
    }
  });

  test("music with all-silent clips: music becomes the soundtrack", async () => {
    await page.goto(openUrl(port, false));
    await addClips([RG, BLUE]);
    await page.setInputFiles("#music", path.join(FIXTURES, MUSIC));
    await page.waitForFunction(() => /BPM/.test(document.getElementById("musicNote").textContent), null, { timeout: 20000 });
    await render();
    const m = await measure({ bands: [[1, 2, 330]] });
    assert.ok(m.hasAudioTrack && m.bands[0] > 0.05, "music present " + m.bands[0]);
    assert.ok(Math.abs(m.audioDuration - m.duration) < 0.1);
    assert.match(await page.textContent("#resultNote"), /Music: \d+ of \d+ cuts on the beat \(~120 BPM\)\./);
  });

  test("all-silent clips: no audio track, render unchanged", async () => {
    await page.goto(openUrl(port, false));
    await addClips([RG, BLUE]);
    await render();
    const m = await measure();
    assert.equal(m.hasAudioTrack, false);
    assert.ok(Math.abs(m.duration - 5.6) < 0.25, "duration " + m.duration);
    assert.doesNotMatch(await page.textContent("#resultNote"), /audio/);
  });
});
