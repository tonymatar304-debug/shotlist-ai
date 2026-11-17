// REAL rendering: visual finishing. Frame-exact checks on the exported MP4 (decoded by FFmpeg.wasm, not <video> seeking):
// hard cuts (no dip to black at any internal cut), a fade from black at the start and to black at the end only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { staticServer, listen, launch, routeRealFfmpeg, FIXTURES } from "./lib.mjs";

const fx = (n) => ({ name: n, mimeType: "video/mp4", buffer: fs.readFileSync(path.join(FIXTURES, n)) });
let web, port, browser;
before(async () => { web = staticServer(); port = await listen(web); browser = await launch(); });
after(async () => { await browser?.close(); web?.close(); });

const frameLuma = async (page, frames) => (await frameRGB(page, frames)).map((p) => p.y);
// Mean colour (0..1: y, r, g, b) of the centre of the given frame numbers of the exported film.
async function frameRGB(page, frames) {
  return page.evaluate(async (frames) => {
    const film = new Uint8Array(await (await fetch(document.getElementById("download").href)).arrayBuffer());
    const base = "https://cdn.jsdelivr.net/npm/", blob = async (u, t) => URL.createObjectURL(new Blob([await (await fetch(u)).arrayBuffer()], { type: t }));
    const ff = new window.FFmpegWASM.FFmpeg();
    await ff.load({ coreURL: await blob(base + "@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.js", "text/javascript"), wasmURL: await blob(base + "@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.wasm", "application/wasm") });
    await ff.writeFile("f.mp4", film);
    const want = [...new Set(frames)].sort((a, b) => a - b);
    await ff.exec(["-i", "f.mp4", "-vf", "select='" + want.map((n) => "eq(n," + n + ")").join("+") + "',crop=iw/2:ih/2,scale=16:16", "-vsync", "0", "-f", "rawvideo", "-pix_fmt", "rgb24", "o.raw"]);
    const raw = await ff.readFile("o.raw"), out = {};
    want.forEach((n, k) => { let r = 0, g = 0, b = 0; for (let i = 0; i < 256; i++) { const o = (k * 256 + i) * 3; r += raw[o]; g += raw[o + 1]; b += raw[o + 2]; }
      r /= 256 * 255; g /= 256 * 255; b /= 256 * 255; out[n] = { y: 0.2126 * r + 0.7152 * g + 0.0722 * b, r, g, b }; });
    ff.terminate();
    return frames.map((n) => out[n]);
  }, frames);
}

test("hard cuts between shots; fade in from black at the start and out to black at the end only", async () => {
  const ctx = await browser.newContext(); await routeRealFfmpeg(ctx);
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${port}/index.html`);
  for (const style of ["cinematic", "vintage"]) {
    await page.click(`button[data-style="${style}"]`);
    if (style === "cinematic") {
      await page.setInputFiles("#clips", ["yellow-3s.mp4", "hd-yellow-3s.mp4", "gray-20s.mp4"].map(fx));
      await page.waitForFunction(() => !document.getElementById("create").disabled, null, { timeout: 30000 });
    }
    const before = await page.getAttribute("#download", "href");
    await page.click("#create");
    await page.waitForFunction((b) => /Film ready|Export failed/.test(document.getElementById("status").textContent) && document.getElementById("download").href !== b, before, { timeout: 240000 });
    assert.match(await page.textContent("#status"), /Film ready/);
    const plan = await page.evaluate(() => window.__claqeLast.plan.map((p) => Math.max(1, Math.round(p.duration * 24))));
    assert.ok(plan.length >= 3, "several shots: " + plan);
    const starts = plan.reduce((a, n) => [...a, a.at(-1) + n], [0]), total = starts.pop();
    const cuts = starts.slice(1).flatMap((s) => [s - 1, s]);                     // the two frames touching each cut
    const mids = starts.map((s, i) => s + (plan[i] >> 1));
    const y = await frameLuma(page, [0, ...cuts, ...mids, total - 1]);
    const first = y[0], cut = y.slice(1, 1 + cuts.length), mid = y.slice(1 + cuts.length, -1), last = y.at(-1);
    console.log(`# ${style}: first ${first.toFixed(3)}, cut frames ${cut.map((v) => v.toFixed(2)).join(" ")}, middles ${mid.map((v) => v.toFixed(2)).join(" ")}, last ${last.toFixed(3)}`);
    assert.ok(first < 0.08, "film starts from black");
    assert.ok(last < 0.08, "film ends on black");
    const minMid = Math.min(...mid);
    cut.forEach((v, i) => assert.ok(v > minMid * 0.85, `no dip at cut ${i >> 1}: ${v.toFixed(3)} vs ${minMid.toFixed(3)}`));
  }
  await ctx.close();
});

test("shot matching: a warm cast is reduced (channel gains), well exposed shots keep their exposure; same plan without matching for comparison", async () => {
  const plan = [{ src: 0, start: 0.5, duration: 2 }, { src: 1, start: 0.5, duration: 2 }, { src: 2, start: 0.5, duration: 2 }, { src: 1, start: 2.5, duration: 1.5 }];
  const res = {};
  for (const match of [false, true]) {
    const ctx = await browser.newContext(); await routeRealFfmpeg(ctx);
    const page = await ctx.newPage();
    await page.addInitScript(({ match, plan }) => { window.CLAQE_MATCH = match; window.__fixedPlan = plan; }, { match, plan });
    await page.goto(`http://localhost:${port}/index.html`);
    // fixed plan (the analysis still runs, so the grade sees the footage)
    await page.evaluate(() => { const o = window.ClaqeAnalyze.planFilm; window.ClaqeAnalyze.planFilm = (...a) => ({ ...o(...a), plan: window.__fixedPlan }); });
    await page.click('button[data-style="dynamic"]');
    await page.setInputFiles("#clips", ["tex-dark-4s.mp4", "tex-bright-4s.mp4", "tex-warm-4s.mp4"].map(fx));
    await page.waitForFunction(() => !document.getElementById("create").disabled, null, { timeout: 30000 });
    await page.click("#create");
    await page.waitForFunction(() => /Film ready|Export failed/.test(document.getElementById("status").textContent), null, { timeout: 240000 });
    assert.match(await page.textContent("#status"), /Film ready/);
    const last = await page.evaluate(() => window.__claqeLast);
    assert.deepEqual(last.plan.map((p) => p.src), [0, 1, 2, 1], "fixed plan used");
    const mids = [24, 72, 120, 162]; // middles of the 2 s, 2 s, 2 s, 1.5 s shots
    res[match] = { px: await frameRGB(page, mids), looks: last.looks };
    await ctx.close();
  }
  const sd = (a) => { const m = a.reduce((s, x) => s + x, 0) / a.length; return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length); };
  const [off, on] = [res[false], res[true]], ys = (r) => r.px.map((p) => p.y), rb = (p) => p.r - p.b;
  console.log(`# luma off ${ys(off).map((v) => v.toFixed(3))} on ${ys(on).map((v) => v.toFixed(3))}; warm R-B off ${rb(off.px[2]).toFixed(3)} on ${rb(on.px[2]).toFixed(3)}`);
  console.log(`# looks on: ${on.looks.join(" | ")}`);
  assert.ok(off.looks.every((l) => l === off.looks[0]), "without matching every shot has the same look");
  assert.ok(new Set(on.looks).size >= 3, "matched shots get their own grade");
  // Since 2026-11-18 exposure is kept as filmed inside mean luma 0.10..0.70 (low-key footage stays low-key; only gross
  // errors move). These fixtures (0.15 .. 0.70) are all inside: matching must not pull them toward each other.
  on.px.forEach((p, i) => assert.ok(Math.abs(p.y - off.px[i].y) < 0.03, `shot ${i} exposure kept: ${off.px[i].y.toFixed(3)} -> ${p.y.toFixed(3)}`));
  assert.ok(sd(ys(on)) > sd(ys(off)) * 0.9, "no flattening of the exposure spread");
  assert.ok(rb(on.px[2]) < rb(off.px[2]) - 0.01 && rb(on.px[2]) > 0.02, "warm cast reduced, not removed");
  assert.ok(Math.abs(on.px[1].y - on.px[3].y) < 0.03, "same footage, same grade");
});
