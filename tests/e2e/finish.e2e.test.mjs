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

// Mean luma (0..1) of the centre of the given frame numbers of the exported film.
async function frameLuma(page, frames) {
  return page.evaluate(async (frames) => {
    const film = new Uint8Array(await (await fetch(document.getElementById("download").href)).arrayBuffer());
    const base = "https://cdn.jsdelivr.net/npm/", blob = async (u, t) => URL.createObjectURL(new Blob([await (await fetch(u)).arrayBuffer()], { type: t }));
    const ff = new window.FFmpegWASM.FFmpeg();
    await ff.load({ coreURL: await blob(base + "@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.js", "text/javascript"), wasmURL: await blob(base + "@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.wasm", "application/wasm") });
    await ff.writeFile("f.mp4", film);
    const want = [...new Set(frames)].sort((a, b) => a - b);
    await ff.exec(["-i", "f.mp4", "-vf", "select='" + want.map((n) => "eq(n," + n + ")").join("+") + "',crop=iw/2:ih/2,scale=16:16", "-vsync", "0", "-f", "rawvideo", "-pix_fmt", "gray", "o.raw"]);
    const raw = await ff.readFile("o.raw"), out = {};
    want.forEach((n, k) => { let s = 0; for (let i = 0; i < 256; i++) s += raw[k * 256 + i]; out[n] = s / 256 / 255; });
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
