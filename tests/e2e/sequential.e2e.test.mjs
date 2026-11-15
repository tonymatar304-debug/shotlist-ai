// REAL rendering: the sequential renderer (one FFmpeg run per shot, then a join). Checks it is used, that no intermediate
// files are left in FFmpeg's in-memory filesystem, and that a failing shot falls back to the single-pass renderer.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { staticServer, listen, launch, routeRealFfmpeg, FIXTURES } from "./lib.mjs";

const fx = (n) => ({ name: n, mimeType: "video/mp4", buffer: fs.readFileSync(path.join(FIXTURES, n)) });
let web, port, browser;
before(async () => { web = staticServer(); port = await listen(web); browser = await launch(); });
after(async () => { await browser?.close(); web?.close(); });

// Wrap the FFmpeg class (its methods are instance fields) to keep a handle and optionally fail one shot's run.
const hook = (failShot) => {
  const install = () => {
    const O = window.FFmpegWASM.FFmpeg;
    window.FFmpegWASM = { ...window.FFmpegWASM, FFmpeg: class extends O { // the UMD export is a read-only getter: replace the namespace
      constructor(...a) { super(...a); window.__ff = this; window.__engines = (window.__engines || 0) + 1; const exec = this.exec; window.__runs = [];
        this.exec = (args, ...r) => { const out = args[args.length - 1]; window.__runs.push(out);
          return failShot !== null && out === "claqe_shot_" + failShot + ".mkv" ? Promise.resolve(1) : exec(args, ...r); }; }
    } };
  };
  if (window.FFmpegWASM) install(); else document.addEventListener("DOMContentLoaded", install);
};

async function run(failShot) {
  const ctx = await browser.newContext(); await routeRealFfmpeg(ctx);
  const page = await ctx.newPage();
  await page.addInitScript(() => { window.CLAQE_RENDER = "sequential"; });
  await page.addInitScript(hook, failShot);
  await page.goto(`http://localhost:${port}/index.html`);
  await page.setInputFiles("#clips", ["beep-flash-6s.mp4", "blue-3s.mp4"].map(fx));
  await page.waitForFunction(() => !document.getElementById("create").disabled, null, { timeout: 30000 });
  await page.click("#create");
  await page.waitForFunction(() => /Film ready|Export failed/.test(document.getElementById("status").textContent), null, { timeout: 240000 });
  const r = await page.evaluate(async () => {
    const v = document.createElement("video"); v.src = document.getElementById("download").href;
    await new Promise((res) => (v.onloadedmetadata = res));
    let files = null; try { files = (await window.__ff.listDir("/")).map((f) => f.name); } catch (_) { /* engine was reset */ }
    return { status: document.getElementById("status").textContent, renderer: window.__claqeLast.renderer, plan: window.__claqeLast.plan.length,
      runs: window.__runs, files, engines: window.__engines, duration: v.duration,
      total: window.__claqeLast.plan.reduce((s, p) => s + Math.max(1, Math.round(p.duration * 24)), 0) / 24 };
  });
  // Second job in the same tab.
  const href = await page.getAttribute("#download", "href");
  await page.click("#create");
  await page.waitForFunction((b) => /Film ready|Export failed/.test(document.getElementById("status").textContent) && document.getElementById("download").href !== b, href, { timeout: 240000 });
  r.again = await page.evaluate(() => ({ status: document.getElementById("status").textContent, engines: window.__engines }));
  await ctx.close();
  return r;
}

test("sequential renderer: one run per shot + join, intermediates removed afterwards", async () => {
  const r = await run(null);
  assert.match(r.status, /Film ready/);
  assert.equal(r.renderer, "sequential");
  const shots = r.runs.filter((o) => /^claqe_shot_\d+\.mkv$/.test(o));
  assert.equal(shots.length, r.plan, "one FFmpeg run per shot: " + r.runs.join(","));
  assert.equal(r.runs.filter((o) => o === "claqe_film.mp4").length, 1, "one join");
  assert.ok(!r.files.some((f) => /^claqe_(shot|shots|film|music|mark)|^input_/.test(f)), "no leftover files: " + r.files.join(","));
  assert.ok(Math.abs(r.duration - r.total) < 0.06, `duration ${r.duration} vs plan ${r.total}`);
  assert.match(r.again.status, /Film ready/); assert.equal(r.again.engines, 1, "engine reused after a sequential job");
});

test("a failing shot falls back to the single-pass renderer; the film is still made and nothing is left behind", async () => {
  const r = await run(1);
  assert.match(r.status, /Film ready/);
  assert.equal(r.renderer, "single (fallback)");
  assert.ok(!r.runs.includes("claqe_shot_2.mkv"), "stops at the failing shot");
  assert.equal(r.files, null, "engine reset after the single-pass fallback (its heap may stay at peak)");
  assert.ok(Math.abs(r.duration - r.total) < 0.06, `duration ${r.duration} vs plan ${r.total}`);
  assert.match(r.again.status, /Film ready/); assert.equal(r.again.engines, 2, "next job gets a fresh engine");
});
