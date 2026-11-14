// Semantic-vision flow in the REAL page with REAL video decoding/rendering. The model is a MOCK (st.vision): no network, no paid API.
// Proves: frames are really captured (small JPEGs, <= 12), a validated reply steers the real export, bad replies fall back to local analysis.
import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { staticServer, listen, launch, routeRealFfmpeg, FIXTURES } from "./lib.mjs";
import { routeTurnstileStub, solveTurnstile, routeApi, newApiState, openUrl } from "./mocks.mjs";

const V = createRequire(import.meta.url)("../../claqe-vision.js");
const fx = (n) => ({ name: n, mimeType: "video/mp4", buffer: fs.readFileSync(path.join(FIXTURES, n)) });
const SB = "still-then-busy-20s.mp4", GRAY = "gray-20s.mp4";
let web, port, browser, ctx, page, api;
before(async () => { web = staticServer(); port = await listen(web); browser = await launch(); });
after(async () => { await browser?.close(); web?.close(); });
beforeEach(async () => {
  api = newApiState(); ctx = await browser.newContext(); await routeRealFfmpeg(ctx); await routeTurnstileStub(ctx); await routeApi(ctx, api);
  await ctx.addInitScript(() => { window.CLAQE_VISION = true; window.CLAQE_LIMITS = { filmSeconds: 7 }; });
  page = await ctx.newPage();
});
afterEach(async () => { await ctx?.close(); });

const shots = (note) => [...note.matchAll(/clip (\d) (\d+):(\d\d)–(\d+):(\d\d)/g)].map((m) => ({ src: +m[1] - 1, start: +m[2] * 60 + +m[3], end: +m[4] * 60 + +m[5] }));
const secondsIn = (sh, src, a, b) => sh.filter((s) => s.src === src).reduce((t, s) => t + Math.max(0, Math.min(s.end, b) - Math.max(s.start, a)), 0);
async function run() {
  await page.goto(openUrl(port, true));
  await page.setInputFiles("#clips", [fx(SB), fx(GRAY)]);
  await page.waitForFunction(() => !document.getElementById("create").disabled, null, { timeout: 20000 });
  await page.click('button[data-plan="ai"]'); await page.click('button[data-style="cinematic"]');
  await page.click("#create"); await solveTurnstile(page);
  await page.waitForFunction(() => /Film ready|Export failed/.test(document.getElementById("status").textContent) || /blocked|used all|unavailable/i.test(document.getElementById("status").textContent), null, { timeout: 420000 });
  return { status: await page.textContent("#status"), note: await page.textContent("#resultNote") };
}
// Mock model: favour frames by time range, using the same shapes the real contract defines.
const model = (rule) => (body) => {
  const rules = {}; for (const c of body.request.clips) for (const f of c.frames) rules[f.id] = rule(c.index, f.t);
  return [200, { ok: true, vision: V.mockVision(body.request, rules), passUsage: "1/30" }];
};

test("a validated semantic reply steers the real export; the same footage with a different reply gives different shots", async () => {
  api.vision = model((ci, t) => (ci === 0 && t < 10 ? { importance: 1, role: "highlight", subject: "a test card", action: "static colour bars" } : { importance: 0.05, role: "filler" }));
  const a = await run();
  assert.match(a.status, /Film ready/); assert.match(a.status, /AI model described sampled frames/); assert.match(a.note, /^AI-assisted edit: an AI model described sampled frames/);
  const call = api.calls.find((c) => c.path === "/vision").body;
  assert.ok(call.images.length >= 4 && call.images.length <= 12, "frames sent: " + call.images.length);
  console.log(`# vision request: ${call.images.length} frames, avg ${Math.round(call.images.reduce((n, i) => n + i.data.length * 0.75, 0) / call.images.length / 1024)} KB each, total body ${Math.round(JSON.stringify(call).length / 1024)} KB`);
  assert.equal(call.images.length, call.request.clips.reduce((n, c) => n + c.frames.length, 0));
  for (const im of call.images) { assert.ok(im.data.startsWith("/9j/") && im.data.length <= 70000, "small JPEG"); assert.ok(!/data:|file|\.mp4/.test(im.data.slice(0, 30))); }
  assert.ok(!/\.mp4|file/i.test(JSON.stringify(call.request)), "no file names in the request");
  for (const c of call.request.clips) for (const f of c.frames) assert.ok(f.t >= 0 && f.t <= c.duration);
  assert.ok(!api.calls.some((c) => c.path === "/generate"), "vision path makes no /generate call"); assert.equal(api.used, 1, "one film = one free edit");
  const first = shots(a.note); assert.ok(secondsIn(first, 0, 0, 10) > secondsIn(first, 0, 10, 20), "reply favouring the still half wins over the busy half: " + a.note);
  assert.match(a.note, /a test card – static colour bars/);

  await ctx.close(); ctx = await browser.newContext(); await routeRealFfmpeg(ctx); await routeTurnstileStub(ctx); api = newApiState(); await routeApi(ctx, api);
  await ctx.addInitScript(() => { window.CLAQE_VISION = true; window.CLAQE_LIMITS = { filmSeconds: 7 }; }); page = await ctx.newPage();
  api.vision = model((ci, t) => (ci === 0 && t > 10 ? { importance: 1, role: "highlight", subject: "a moving pattern", action: "numbers counting" } : { importance: 0.05, role: "filler" }));
  const b = await run(); const second = shots(b.note);
  assert.ok(secondsIn(second, 0, 10, 20) > secondsIn(second, 0, 0, 10), "reply favouring the busy half wins: " + b.note);
  assert.notDeepEqual(first, second);
});

test("unusable or failed AI vision falls back to local analysis, honestly labelled", async () => {
  for (const reply of [[502, { ok: false, code: "vision_unusable" }], [502, { ok: false, code: "ai_unavailable" }], [200, { ok: true, vision: { version: 1, frames: [{ id: "zz", t: 1, importance: 1 }] } }]]) {
    ctx = await browser.newContext(); await routeRealFfmpeg(ctx); await routeTurnstileStub(ctx); api = newApiState(); await routeApi(ctx, api);
    await ctx.addInitScript(() => { window.CLAQE_VISION = true; window.CLAQE_LIMITS = { filmSeconds: 7 }; }); page = await ctx.newPage();
    api.vision = () => reply; const r = await run();
    assert.match(r.status, /Film ready/); assert.match(r.status, /not by AI/);
    assert.match(r.note, /^Footage-aware edit from local video analysis \(not AI\)/); assert.doesNotMatch(r.note, /AI-assisted/);
    assert.match(r.note, /Used local footage analysis instead/); await ctx.close();
  }
  ctx = await browser.newContext(); // afterEach closes it
});

test("quota/budget refusals are shown, not silently replaced by a film", async () => {
  api.vision = () => [429, { ok: false, code: "free_limit" }];
  await page.goto(openUrl(port, true)); await page.setInputFiles("#clips", [fx(SB), fx(GRAY)]);
  await page.waitForFunction(() => !document.getElementById("create").disabled, null, { timeout: 20000 });
  await page.click('button[data-plan="ai"]'); await page.click("#create"); await solveTurnstile(page);
  await page.waitForFunction(() => /free AI edits/.test(document.getElementById("status").textContent), null, { timeout: 120000 });
  assert.equal(await page.isVisible("#result"), false);
});
