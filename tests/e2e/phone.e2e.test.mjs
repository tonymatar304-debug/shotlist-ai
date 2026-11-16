// REAL rendering of phone-style footage (fixtures from make-phone-fixtures.mjs): HDR (HLG / PQ, 10-bit .mov) is detected and
// tone mapped to SDR, SDR is never touched, portrait (rotation metadata) comes out upright, variable frame rate stays in sync,
// and the single-pass fallback converts HDR the same way. Colours are compared inside one film: the HDR shots of the test
// chart must match the SDR shot of the same chart (all get the same style look, so it cancels out).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { staticServer, listen, launch, routeRealFfmpeg, FIXTURES } from "./lib.mjs";
import { PATCHES, COLS, lab, dE2000 } from "./phone-chart.mjs";

const fx = (n) => ({ name: n, mimeType: n.endsWith(".mov") ? "video/quicktime" : "video/mp4", buffer: fs.readFileSync(path.join(FIXTURES, n)) });
const HLG = "hlg-prores-4s.mov", PQ = "pq-prores-4s.mov", SDR10 = "sdr10-prores-4s.mov", PORTRAIT = "hlg-prores-portrait-4s.mov", VFR = "vfr-h264-6s.mp4";
let web, port, browser;
before(async () => { web = staticServer(); port = await listen(web); browser = await launch(); });
after(async () => { await browser?.close(); web?.close(); });

// Render a fixed plan; records every FFmpeg command. init: extra window settings (CLAQE_RENDER, CLAQE_TONEMAP, ...).
async function render(clips, plan, { init = {}, format = "landscape" } = {}) {
  const ctx = await browser.newContext(); await routeRealFfmpeg(ctx);
  const page = await ctx.newPage();
  await page.addInitScript(({ plan, init }) => {
    Object.assign(window, init, { __fixedPlan: plan, CLAQE_MATCH: false });
    const wrap = () => { const O = window.FFmpegWASM.FFmpeg; window.__cmds = [];
      window.FFmpegWASM = { ...window.FFmpegWASM, FFmpeg: class extends O { constructor(...a) { super(...a); const e = this.exec; this.exec = (args, ...r) => { window.__cmds.push(args.slice()); return e(args, ...r); }; } } }; };
    if (window.FFmpegWASM) wrap(); else document.addEventListener("DOMContentLoaded", wrap);
  }, { plan, init });
  await page.goto(`http://localhost:${port}/index.html`);
  // Fixed plan. Edge can't decode ProRes pictures, so its browser-side analysis is stubbed here (the real fallback for that
  // case is covered by the "still used" tests below).
  await page.evaluate(() => { window.ClaqeAnalyze.planFilm = (_, style) => ({ source: "local-analysis", style, plan: window.__fixedPlan, total: 0 });
    window.ClaqeAnalyze.analyzeClip = async (_, duration) => ({ duration, samples: [] }); });
  await page.click(`button[data-format="${format}"]`);
  await page.setInputFiles("#clips", clips.map(fx));
  await page.waitForFunction(() => !document.getElementById("create").disabled, null, { timeout: 30000 });
  const t0 = Date.now(); await page.click("#create");
  await page.waitForFunction(() => /Film ready|Export failed/.test(document.getElementById("status").textContent), null, { timeout: 240000 });
  const secs = (Date.now() - t0) / 1000;
  assert.match(await page.textContent("#status"), /Film ready/, await page.textContent("#status"));
  return { ctx, page, secs, last: await page.evaluate(() => ({ renderer: window.__claqeLast.renderer, video: window.__claqeLast.video, cluts: window.__claqeLast.cluts, cmds: window.__cmds, note: document.getElementById("resultNote").textContent })) };
}
// RGB (0..1) averaged over a small box, from the exported film at time t, drawn at its own size.
const grab = (page, t, boxes) => page.evaluate(async ({ t, boxes }) => {
  const v = document.createElement("video"); v.muted = true; v.src = document.getElementById("download").href;
  await new Promise((r) => (v.onloadeddata = r)); v.currentTime = t; await new Promise((r) => (v.onseeked = r)); await new Promise((r) => setTimeout(r, 150));
  const c = document.createElement("canvas"); c.width = v.videoWidth; c.height = v.videoHeight; const g = c.getContext("2d"); g.drawImage(v, 0, 0);
  return { w: v.videoWidth, h: v.videoHeight, px: boxes.map(([x, y, r]) => { const d = g.getImageData(x - r, y - r, 2 * r, 2 * r).data, s = [0, 0, 0];
    for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) s[k] += d[i + k]; return s.map((x) => x / (d.length / 4) / 255); }) };
}, { t, boxes });
// Patch centres of the 640x360 chart (the output is 640x360 too: scale/crop are identity, zoompan zooms <= 6 % about the centre).
const centres = PATCHES.map((_, i) => { const x = (i % COLS) * 80 + 40, y = Math.floor(i / COLS) * 120 + 60; return [Math.round(320 + (x - 320) * 1.02), Math.round(180 + (y - 180) * 1.02), 8]; });
const sdrPatches = PATCHES.map((p, i) => (p.sdr ? i : -1)).filter((i) => i >= 0);
const compare = (a, b) => { const d = sdrPatches.map((i) => dE2000(lab(a[i]), lab(b[i]))); return { mean: d.reduce((s, x) => s + x, 0) / d.length, skin: PATCHES.map((p, i) => (p.skin ? dE2000(lab(a[i]), lab(b[i])) : null)).filter((x) => x !== null), max: Math.max(...d) }; };
// shots of 1 s from the middle of each clip (no flash inside): SDR | HLG | PQ | SDR (the last one carries the fade-out)
const PLAN = [{ src: 0, start: 0.7, duration: 1 }, { src: 1, start: 0.7, duration: 1 }, { src: 2, start: 0.7, duration: 1 }, { src: 0, start: 2.2, duration: 1 }];

async function hdrVsSdr(init) {
  const r = await render([SDR10, HLG, PQ], PLAN, { init });
  const at = async (shot) => (await grab(r.page, shot + 0.55, centres)).px;
  const [sdr, hlg, pq] = [await at(0), await at(1), await at(2)];
  await r.ctx.close();
  return { ...r, hlg: compare(sdr, hlg), pq: compare(sdr, pq) };
}

test("HDR (HLG, PQ) is detected and tone mapped to match SDR; SDR is never touched", async () => {
  const r = await hdrVsSdr({});
  const v = r.last.video;
  assert.deepEqual(v.map((x) => x.hdr), [null, "hlg", "pq"]);
  assert.deepEqual(v.map((x) => [x.primaries, x.transfer, x.bitDepth]), [["bt709", "bt709", 10], ["bt2020", "arib-std-b67", 10], ["bt2020", "smpte2084", 10]]);
  assert.deepEqual(Object.keys(r.last.cluts).sort(), ["hlg_bt2020", "pq_bt2020"]); assert.ok(Object.values(r.last.cluts).every(Boolean), "CLUTs built");
  const shots = r.last.cmds.filter((c) => /^claqe_shot_\d+\.mkv$/.test(c.at(-1))), graph = (c) => c[c.indexOf("-filter_complex") + 1];
  assert.equal(shots.length, 4);
  for (const k of [0, 3]) assert.doesNotMatch(graph(shots[k]), /haldclut|zscale|tonemap|in_color_matrix/, "SDR shot " + k + " untouched");
  for (const k of [1, 2]) assert.match(graph(shots[k]), /haldclut=interp=tetrahedral/, "HDR shot " + k + " uses the CLUT");
  console.log(`# HDR vs SDR chart, dE2000 mean/max/skin: HLG ${r.hlg.mean.toFixed(2)}/${r.hlg.max.toFixed(2)}/${r.hlg.skin.map((x) => x.toFixed(2))}, PQ ${r.pq.mean.toFixed(2)}/${r.pq.max.toFixed(2)}/${r.pq.skin.map((x) => x.toFixed(2))}; render ${r.secs.toFixed(1)} s`);
  for (const m of [r.hlg, r.pq]) { assert.ok(m.mean < 3, "mean dE " + m.mean); assert.ok(Math.max(...m.skin) < 3, "skin dE " + m.skin); }
  assert.match(r.last.note, /HDR footage converted to standard range/);
});

test("without tone mapping the same HDR shots are visibly off (control), and the direct fallback chain matches the CLUT", async () => {
  const off = await hdrVsSdr({ CLAQE_TONEMAP: false }), direct = await hdrVsSdr({ CLAQE_TONEMAP: "direct" });
  console.log(`# control (no tone map) dE mean HLG ${off.hlg.mean.toFixed(2)}, PQ ${off.pq.mean.toFixed(2)}; direct chain HLG ${direct.hlg.mean.toFixed(2)}, PQ ${direct.pq.mean.toFixed(2)}`);
  assert.ok(off.hlg.mean > 5 && off.pq.mean > 8, "control must show the problem");
  assert.ok(direct.hlg.mean < 3 && direct.pq.mean < 3);
  assert.deepEqual(direct.last.cluts, { hlg_bt2020: null, pq_bt2020: null });
});

test("single-pass fallback renderer tone maps HDR too", async () => {
  const r = await hdrVsSdr({ CLAQE_RENDER: "single" });
  console.log(`# single-pass: dE mean HLG ${r.hlg.mean.toFixed(2)}, PQ ${r.pq.mean.toFixed(2)}`);
  assert.equal(r.last.renderer, "single");
  assert.ok(r.hlg.mean < 3 && r.pq.mean < 3);
});

// Real app flow (no fixed plan): a clip whose picture this browser can't decode (ProRes in Edge) or that it can't open at all
// (MPEG-TS in Edge) must still be in the film, via FFmpeg (duration) and the basic edit plan, with a note.
for (const [what, clip] of [["picture can't be decoded by the browser", HLG], ["file can't be opened by the browser", "sdr-h264-4s.ts"]]) {
  test(`a clip whose ${what} is still used (FFmpeg fallback)`, async () => {
    const ctx = await browser.newContext(); await routeRealFfmpeg(ctx); const page = await ctx.newPage();
    await page.goto(`http://localhost:${port}/index.html`);
    await page.setInputFiles("#clips", [clip, "tex-bright-4s.mp4"].map((n) => fx(n)));
    await page.waitForFunction(() => !document.getElementById("create").disabled, null, { timeout: 60000 });
    await page.click("#create");
    await page.waitForFunction(() => /Film ready|Export failed/.test(document.getElementById("status").textContent), null, { timeout: 240000 });
    const r = await page.evaluate(() => ({ status: document.getElementById("status").textContent, note: document.getElementById("resultNote").textContent,
      srcs: window.__claqeLast.plan.map((p, i) => (p.src === undefined ? i : p.src)) }));
    await ctx.close();
    assert.match(r.status, /Film ready/); assert.ok(r.srcs.includes(0) && r.srcs.includes(1), "both clips used: " + r.srcs);
    assert.match(r.note, /can't preview one of your clips/);
  });
}

test("portrait iPhone-style clip comes out upright; variable-frame-rate clip stays in sync", async () => {
  // portrait: flash/beep at 0.5 and 3.5 s; VFR: at 0.5, 2.0, 3.5, 5.0 s. Every shot puts one flash 0.25 s in.
  const r = await render([PORTRAIT, VFR], [{ src: 0, start: 0.25, duration: 1 }, { src: 1, start: 1.75, duration: 1 }, { src: 0, start: 3.25, duration: 0.75 }, { src: 1, start: 4.75, duration: 1 }], { format: "vertical" });
  assert.equal(r.last.video[0].rotation, 270); assert.equal(r.last.video[1].vfr, true, "VFR detected: " + JSON.stringify(r.last.video[1]));
  // Upright = rotated 90 degrees clockwise: the chart's top row (grey ramp, dark -> white, left -> right) becomes the right
  // column, running top -> bottom. Output 360x640; the rotated chart (360 wide, 640 high) fills it.
  const col = (await grab(r.page, 0.6, Array.from({ length: 8 }, (_, k) => [360 - 60, Math.round(320 + (k * 80 + 40 - 320) * 1.02), 6]))).px.map((c) => (c[0] + c[1] + c[2]) / 3);
  console.log("# portrait right column (top -> bottom): " + col.map((x) => Math.round(x * 255)).join(" "));
  for (let k = 1; k < 8; k++) assert.ok(col[k] > col[k - 1], "grey ramp runs down the right column");
  // A/V sync: each beep within one frame (42 ms) of its flash.
  const m = await r.page.evaluate(async () => {
    const href = document.getElementById("download").href, buf = await (await fetch(href)).arrayBuffer();
    const ab = await new OfflineAudioContext(1, 1, 48000).decodeAudioData(buf.slice(0)), ch = ab.getChannelData(0), sr = ab.sampleRate, on = [];
    let q = 1e9; for (let i = 0; i < ch.length; i++) { if (Math.abs(ch[i]) > 0.05) { if (q >= 0.2 * sr) on.push(i / sr); q = 0; } else q++; }
    const v = document.createElement("video"); v.muted = true; v.src = href; await new Promise((r) => (v.onloadeddata = r));
    const c = document.createElement("canvas"); c.width = c.height = 16; const g = c.getContext("2d", { willReadFrequently: true });
    const lum = async (k) => { v.currentTime = (k + 0.5) / 24; await new Promise((r) => (v.onseeked = r)); await new Promise((r) => setTimeout(r, 60)); g.drawImage(v, 0, 0, 16, 16); const d = g.getImageData(0, 0, 16, 16).data; let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2]; return s / (d.length / 4) / 3; };
    const off = []; for (const t of on) { let f = null; for (let k = Math.max(0, Math.floor((t - 0.3) * 24)); k <= Math.ceil((t + 0.3) * 24) && f === null; k++) if ((await lum(k)) > 200) f = k / 24; off.push(f === null ? null : Math.round((t - f) * 1000)); }
    return { on, off, duration: v.duration, audio: ab.duration };
  });
  console.log(`# portrait+VFR beeps ${JSON.stringify(m.on.map((t) => +t.toFixed(3)))}, A/V offsets ${JSON.stringify(m.off)} ms; video ${m.duration.toFixed(3)} s, audio ${m.audio.toFixed(3)} s`);
  assert.equal(m.on.length, 4); for (const o of m.off) assert.ok(o !== null && Math.abs(o) <= 42, "offset " + o);
  await r.ctx.close();
});
