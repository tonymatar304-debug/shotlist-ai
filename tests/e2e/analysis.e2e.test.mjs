// Footage analysis + footage-aware plan with REAL video decoding (Edge) and the REAL renderer. Mocked: nothing but Turnstile/API are unused here.
import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { staticServer, listen, launch, routeRealFfmpeg, FIXTURES } from "./lib.mjs";
import { openUrl } from "./mocks.mjs";

const fx = (n) => ({ name: n, mimeType: "video/mp4", buffer: fs.readFileSync(path.join(FIXTURES, n)) });
const SB = "still-then-busy-20s.mp4", BS = "busy-then-still-20s.mp4", GRAY = "gray-20s.mp4";
let web, port, browser, ctx, page;
before(async () => { web = staticServer(); port = await listen(web); browser = await launch(); });
after(async () => { await browser?.close(); web?.close(); });
beforeEach(async () => { ctx = await browser.newContext(); await routeRealFfmpeg(ctx); page = await ctx.newPage(); page.on("pageerror", (e) => console.log("pageerror:", String(e).slice(0, 200))); });
afterEach(async () => { await ctx?.close(); });

// Shots listed in #resultNote: "clip 1 0:12–0:17 (reason)" -> [{src,start,end}]
const shots = (note) => [...note.matchAll(/clip (\d) (\d+):(\d\d)–(\d+):(\d\d)/g)].map((m) => ({ src: +m[1] - 1, start: +m[2] * 60 + +m[3], end: +m[4] * 60 + +m[5] }));
async function makeFilm(files, style, film = 7) { // 7 s film from 40 s of footage, so the planner must CHOOSE (30 s is covered by unit tests)
  await ctx.addInitScript((f) => { window.CLAQE_LIMITS = { filmSeconds: f }; }, film);
  await page.goto(openUrl(port, false));
  await page.setInputFiles("#clips", files.map(fx));
  await page.waitForFunction(() => !document.getElementById("create").disabled, null, { timeout: 20000 });
  await page.click(`button[data-style="${style}"]`);
  await page.click("#create");
  await page.waitForFunction(() => /Film ready|Export failed/.test(document.getElementById("status").textContent), null, { timeout: 420000 });
  assert.match(await page.textContent("#status"), /Film ready/, await page.textContent("#status"));
  const note = await page.textContent("#resultNote");
  const dur = await page.evaluate(async () => { const v = document.createElement("video"); v.muted = true; v.src = document.getElementById("download").href; await new Promise((r) => (v.onloadedmetadata = r)); return v.duration; });
  return { note, dur, shots: shots(note), status: await page.textContent("#status") };
}
const secondsIn = (sh, src, a, b) => sh.filter((s) => s.src === src).reduce((t, s) => t + Math.max(0, Math.min(s.end, b) - Math.max(s.start, a)), 0);

test("analysis samples the WHOLE clip, finds the scene cut and the motion", async () => {
  await page.goto(openUrl(port, false));
  await page.route("**/fx/*", (r) => r.fulfill({ body: fs.readFileSync(path.join(FIXTURES, new URL(r.request().url()).pathname.split("/").pop())), contentType: "video/mp4" }));
  const a = await page.evaluate(async (n) => {
    const file = new File([await (await fetch("/fx/" + n)).arrayBuffer()], n, { type: "video/mp4" });
    const t0 = performance.now(), r = await ClaqeAnalyze.analyzeClip(file, 20);
    const heap = performance.memory ? performance.memory.usedJSHeapSize / 1048576 : -1;
    return { ms: Math.round(performance.now() - t0), heap, ts: r.samples.map((s) => s.t), cuts: r.samples.filter((s) => s.scene > ClaqeAnalyze.SCENE_T).map((s) => s.t),
      motionA: r.samples.filter((s) => s.t < 9).reduce((m, s) => Math.max(m, s.resid), 0), motionB: r.samples.filter((s) => s.t > 11).reduce((m, s) => Math.max(m, s.resid), 0) };
  }, SB);
  console.log(`# analysis of a 20 s clip: ${a.ms} ms, ${a.ts.length} samples, JS heap ${a.heap.toFixed(0)} MB`);
  assert.ok(a.ts[0] < 1 && a.ts[a.ts.length - 1] > 18.5, "covers whole clip: " + a.ts[0] + ".." + a.ts[a.ts.length - 1]);
  assert.ok(a.ts.length >= 20 && a.ts.length <= 30);
  assert.equal(a.cuts.length, 1); assert.ok(a.cuts[0] > 9 && a.cuts[0] < 11.5, "cut near 10 s: " + a.cuts);
  assert.ok(a.motionB > a.motionA * 3, `busy half has more subject motion (${a.motionA} vs ${a.motionB})`);
});

test("changing the footage changes the editing decisions and the real export follows the plan", async () => {
  const x = await makeFilm([SB, GRAY], "dynamic");
  await ctx.close(); ctx = await browser.newContext(); await routeRealFfmpeg(ctx); page = await ctx.newPage();
  const y = await makeFilm([BS, GRAY], "dynamic");
  console.log("# footage X plan:", x.note.split(" · ")[1]); console.log("# footage Y plan:", y.note.split(" · ")[1]);
  for (const r of [x, y]) { assert.match(r.note, /^Footage-aware edit from local video analysis \(not AI\)/); assert.doesNotMatch(r.note, /AI-assisted/); assert.match(r.status, /not by AI/); }
  assert.ok(secondsIn(x.shots, 0, 10, 20) > secondsIn(x.shots, 0, 0, 10) + 3, "X: favours its busy second half");
  assert.ok(secondsIn(y.shots, 0, 0, 10) > secondsIn(y.shots, 0, 10, 20) + 3, "Y: favours its busy first half");
  assert.notDeepEqual(x.shots, y.shots);
  for (const r of [x, y]) { const planned = r.shots.reduce((t, s) => t + s.end - s.start, 0); assert.ok(Math.abs(r.dur - planned) < 1.5 && r.dur > 4.5 && r.dur <= 8, `export ${r.dur}s vs plan ${planned}s`); assert.ok(r.shots.length >= 3, "dynamic = many shots"); }
});

test("styles change pacing on the same footage (cinematic holds longer than dynamic)", async () => {
  const d = await makeFilm([SB, BS], "dynamic", 10); await ctx.close(); ctx = await browser.newContext(); await routeRealFfmpeg(ctx); page = await ctx.newPage();
  const c = await makeFilm([SB, BS], "cinematic", 10);
  assert.ok(d.shots.length >= c.shots.length + 1, `dynamic ${d.shots.length} shots vs cinematic ${c.shots.length}`);
});
