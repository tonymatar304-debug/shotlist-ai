// Turnstile expiry / error / reset behaviour of index.html, with a fake widget and simulated time (page.clock).
// Fast: FFmpeg is stubbed (rendering is covered by render.e2e.test.mjs). No network, no real Turnstile.
import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { staticServer, listen, launch } from "./lib.mjs";
import { routeTurnstileStub, solveTurnstile, fireTurnstile, routeApi, newApiState, openUrl, FFMPEG_STUB, DURATION_STUB } from "./mocks.mjs";

let web, port, browser, ctx, page, api;
const CLIPS = [{ name: "a_5.2s.mp4", mimeType: "video/mp4", buffer: Buffer.alloc(2048) }, { name: "b_8.0s.mp4", mimeType: "video/mp4", buffer: Buffer.alloc(2048) }];

before(async () => { web = staticServer(); port = await listen(web); browser = await launch(); });
after(async () => { await browser?.close(); web?.close(); });
beforeEach(async () => {
  api = newApiState();
  ctx = await browser.newContext();
  await ctx.addInitScript(DURATION_STUB);
  await ctx.route(/\/vendor\/ffmpeg\/ffmpeg\.js/, (r) => r.fulfill({ contentType: "text/javascript", body: FFMPEG_STUB }));
  await ctx.route(/cdn\.jsdelivr\.net|fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ contentType: "text/plain", body: "x" }));
  await routeTurnstileStub(ctx); await routeApi(ctx, api);
  page = await ctx.newPage();
  await page.clock.install(); // simulated time: fastForward() fires the widget's 300 s expiry instantly
  await page.goto(openUrl(port, true));
  await page.setInputFiles("#clips", CLIPS);
  await page.waitForFunction(() => !document.getElementById("create").disabled, null, { timeout: 15000 });
  await page.click('button[data-plan="ai"]');
});
afterEach(async () => { await ctx?.close(); });

const status = () => page.textContent("#status");
const waitStatus = (re, t = 20000) => page.waitForFunction((s) => new RegExp(s).test(document.getElementById("status").textContent), re.source, { timeout: t });
const widgetShown = () => page.waitForFunction(() => window.__ts && window.__ts.renders > 0 && !document.getElementById("turnstileBox").hidden);
const ts = () => page.evaluate(() => ({ renders: window.__ts ? window.__ts.renders : 0, resets: window.__ts ? window.__ts.resets : 0 }));
const generated = () => api.calls.some((c) => c.path === "/generate");

test("token expires while waiting (simulated 5 min) → told to redo the check; a fresh token then succeeds", async () => {
  await page.click("#create");
  await widgetShown();
  await page.clock.fastForward(301000);
  await waitStatus(/check expired/);
  assert.equal(await page.isDisabled("#create"), true); // still waiting, nothing sent
  assert.equal(api.calls.some((c) => c.path === "/pass"), false);
  await solveTurnstile(page, "fresh-token");
  await waitStatus(/Film ready/);
  assert.deepEqual(api.tokens, ["fresh-token"]); // the expired token was never sent
});

test("widget timeout-callback → message, still waiting, then solving works", async () => {
  await page.click("#create"); await widgetShown();
  await fireTurnstile(page, "timeout-callback");
  await waitStatus(/timed out/);
  await solveTurnstile(page, "t2");
  await waitStatus(/Film ready/);
});

test("widget error-callback → actionable error, widget closed, create re-enabled; retry re-arms the same widget", async () => {
  await page.click("#create"); await widgetShown();
  await fireTurnstile(page, "error-callback");
  await waitStatus(/couldn't complete/);
  assert.equal(await page.isHidden("#turnstileBox"), true);
  assert.equal(await page.isDisabled("#create"), false);
  assert.match(await status(), /Browser preview/);
  assert.equal(generated(), false);
  const before = await ts();
  await page.click("#create"); await widgetShown();
  await solveTurnstile(page, "t3");
  await waitStatus(/Film ready/);
  const after = await ts();
  assert.equal(after.renders, before.renders); // not re-rendered (no duplicate widgets)
  assert.ok(after.resets > before.resets);      // reset instead
});

test("server rejects the token twice (expired/duplicate) → fresh challenge each time, then a clear failure", async () => {
  api.passFailuresLeft = 5;
  await page.click("#create"); await widgetShown();
  await solveTurnstile(page, "bad1");
  await waitStatus(/Human verification failed/);
  await page.waitForFunction(() => window.__ts.resets >= 2 && !document.getElementById("turnstileBox").hidden); // re-armed for a second try
  await solveTurnstile(page, "bad2");
  await waitStatus(/Human verification failed[\s\S]*Browser preview/);
  assert.deepEqual(api.tokens, ["bad1", "bad2"]);
  assert.equal(generated(), false);
  assert.equal(await page.isDisabled("#create"), false);
  assert.equal(await page.isHidden("#turnstileBox"), true);
});

test("tokens are single-use: widget is closed and reset after a successful /pass", async () => {
  await page.click("#create"); await widgetShown();
  await solveTurnstile(page, "t4");
  await waitStatus(/Film ready/);
  assert.equal(await page.isHidden("#turnstileBox"), true);
  assert.ok((await ts()).resets >= 1);
});

test("pass cookie already valid → no widget at all", async () => {
  api.passed = true;
  await page.click("#create");
  await waitStatus(/Film ready/);
  assert.equal((await ts()).renders, 0);
  assert.deepEqual(api.tokens, []);
});

test("pass expires between /status and /generate (401) → asks for the check again, nothing rendered", async () => {
  api.passed = true; api.generate401 = true;
  await page.click("#create");
  await waitStatus(/human check/);
  assert.equal(await page.isDisabled("#create"), false);
  assert.equal(await page.evaluate(() => (window.__ffmpegCalls || []).length), 0);
});
