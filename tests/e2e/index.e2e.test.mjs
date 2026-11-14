// Real-browser (Edge) integration tests for index.html <-> claqe-api.js <-> a MOCKED API.
// Real parts: the page, the Turnstile widget (Cloudflare's official TEST site keys, free), CORS/credentials.
// Mocked parts: the CLAQE API (local http server), FFmpeg.wasm (stub that records the command), video metadata.
// No deploy, no remote D1, no Anthropic. Run: cd tests && npm test
import { test, before, after, beforeEach, afterEach, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const KEY_PASS = "1x00000000000000000000AA";          // Cloudflare test site key: always passes
const KEY_INTERACTIVE = "3x00000000000000000000FF";   // Cloudflare test site key: forces an interactive challenge
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

let web, apiServer, browser, webPort, apiPort, api;

function listen(server) { return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port))); }

function freshApi() {
  return { passed: false, passFailuresLeft: 0, cookieBlocked: false, used: 0, limit: 3, quotaConfigured: true, aiEnabled: true,
    calls: [], tokens: [], generateResponse: null };
}
const GOOD_ORDER = [{ index: 1, start: 0.5, duration: 6 }, { index: 0, start: 0.2, duration: 4.5 }];

function handleApi(req, res) {
  const origin = req.headers.origin || "*";
  const cors = { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Credentials": "true", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", Vary: "Origin" };
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = raw ? JSON.parse(raw) : null;
    api.calls.push({ path: req.url, body });
    const send = (status, obj) => { res.writeHead(status, { ...cors, "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.url === "/status") {
      const valid = api.passed && !api.cookieBlocked;
      return send(200, { ok: true, ai_enabled: api.aiEnabled, quota_configured: api.quotaConfigured,
        pass: valid ? { uid: "u1", valid: true } : { valid: false, message: "No valid pass." },
        free: valid && api.quotaConfigured ? { used: api.used, limit: api.limit } : undefined, budget: {} });
    }
    if (req.url === "/pass") {
      if (!body || !body.turnstileToken) return send(403, { ok: false, code: "verification_failed", error: "Human verification failed." });
      api.tokens.push(body.turnstileToken);
      if (api.passFailuresLeft > 0) { api.passFailuresLeft--; return send(403, { ok: false, code: "verification_failed", error: "Human verification failed." }); }
      api.passed = true;
      return send(200, { ok: true, uid: "u1" });
    }
    if (req.url === "/generate") {
      if (!api.passed) return send(401, { ok: false, code: "pass_required", error: "No valid pass." });
      if (api.generateResponse === "drop") return req.socket.destroy();
      if (api.generateResponse) return send(api.generateResponse.status, api.generateResponse.body);
      api.used++;
      return send(200, { ok: true, plan: { order: GOOD_ORDER, style: body.style, targetSeconds: body.targetSeconds }, usedFallback: false, passUsage: "1/30" });
    }
    send(404, { ok: false, error: "Unknown path" });
  });
}

before(async () => {
  web = http.createServer((req, res) => {
    const file = path.join(ROOT, decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+$/, "index.html"));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  apiServer = http.createServer(handleApi);
  webPort = await listen(web);
  apiPort = await listen(apiServer);
  browser = await chromium.launch({ channel: "msedge", headless: true });
});
after(async () => { await browser?.close(); web?.close(); apiServer?.close(); });

const FFMPEG_STUB = `window.FFmpegWASM={FFmpeg:class{on(){}async load(){}async writeFile(){}async exec(c){(window.__ffmpegCalls=window.__ffmpegCalls||[]).push(c);return window.__ffmpegExit||0}async readFile(){return new Uint8Array(4096)}async deleteFile(){}}};`;
// Stand-in for video metadata: duration is encoded in the file name (e.g. a_5.2s.mp4); real decoding is not under test.
const DURATION_STUB = `(()=>{const names=new Map(),orig=URL.createObjectURL.bind(URL);
URL.createObjectURL=o=>{const u=orig(o);if(o&&o.name)names.set(u,o.name);return u};
HTMLVideoElement.prototype.load=function(){const s=this.getAttribute("src");if(!s||!names.has(s))return;
const m=/_(\\d+(?:\\.\\d+)?)s\\./.exec(names.get(s));if(!m)return;Object.defineProperty(this,"duration",{value:parseFloat(m[1]),configurable:true});
setTimeout(()=>this.onloadedmetadata&&this.onloadedmetadata(),0)}})();`;
const CLIPS = [{ name: "a_5.2s.mp4", mimeType: "video/mp4", buffer: Buffer.alloc(2048) }, { name: "b_8.0s.mp4", mimeType: "video/mp4", buffer: Buffer.alloc(2048) }];

let ctx, page;
beforeEach(async () => {
  api = freshApi();
  ctx = await browser.newContext();
  await ctx.addInitScript(DURATION_STUB);
  await ctx.route(/\/vendor\/ffmpeg\/ffmpeg\.js/, (route) => route.fulfill({ contentType: "text/javascript", body: FFMPEG_STUB }));
  await ctx.route(/cdn\.jsdelivr\.net/, (route) => route.fulfill({ contentType: "text/plain", body: "x" }));
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.fulfill({ contentType: "text/css", body: "" }));
  page = await ctx.newPage();
});
afterEach(async () => { await ctx?.close(); });

async function open({ ai = true, key = KEY_PASS } = {}) {
  const q = ai ? `?api=http://127.0.0.1:${apiPort}&tskey=${key}` : "";
  await page.goto(`http://localhost:${webPort}/index.html${q}`);
}
async function addClips() {
  await page.setInputFiles("#clips", CLIPS);
  await page.waitForFunction(() => !document.getElementById("create").disabled, null, { timeout: 15000 });
}
const text = (sel) => page.textContent(sel);
const waitStatus = (re, timeout = 45000) => page.waitForFunction((s) => new RegExp(s).test(document.getElementById("status").textContent), re.source, { timeout });
const graph = async () => page.evaluate(() => { const c = window.__ffmpegCalls && window.__ffmpegCalls[0]; return c ? c[c.indexOf("-filter_complex") + 1] : null; });
const ffmpegRuns = () => page.evaluate(() => (window.__ffmpegCalls || []).length);
const resultVisible = () => page.evaluate(() => getComputedStyle(document.getElementById("result")).display !== "none");

describe("browser preview (no API configured)", () => {
  test("AI controls hidden; upload → style → create → preview → export works, labelled as preview", async () => {
    await open({ ai: false });
    assert.equal(await page.isHidden("#aiBox"), true);
    await addClips();
    await page.click('button[data-style="vintage"]');
    await page.click("#create");
    await waitStatus(/Film ready/);
    assert.equal(await resultVisible(), true);
    assert.match(await page.getAttribute("#download", "href"), /^blob:/);
    assert.match(await text("#resultNote"), /^Preview export/);
    assert.ok(!/AI/.test(await text("#resultNote")));
    assert.match(await graph(), /^\[0:v\]trim/);
    assert.match(await graph(), /saturation=0\.78/); // vintage grade applied
    assert.equal(api.calls.length, 0);
  });
  test("renderer failure shows an actionable error and no result", async () => {
    await open({ ai: false });
    await addClips();
    await page.evaluate(() => (window.__ffmpegExit = 1));
    await page.click("#create");
    await waitStatus(/Export failed/);
    assert.equal(await resultVisible(), false);
    assert.equal(await page.isDisabled("#create"), false);
  });
});

describe("product limits", () => {
  const f = (n) => ({ name: n, mimeType: "video/mp4", buffer: Buffer.alloc(2048) });
  test("a clip longer than 60 s is refused with an actionable note", async () => {
    await open({ ai: false });
    await page.setInputFiles("#clips", [f("a_61s.mp4"), f("b_8.0s.mp4")]);
    await page.waitForFunction(() => /up to 60 seconds/.test(document.getElementById("renderNote").textContent), null, { timeout: 15000 });
    assert.equal(await page.isDisabled("#create"), true);
  });
  test("more than 3 minutes of combined footage is refused", async () => {
    await open({ ai: false });
    await page.setInputFiles("#clips", [f("a_50s.mp4"), f("b_50s.mp4"), f("c_50s.mp4"), f("d_50s.mp4")]);
    await page.waitForFunction(() => /3 minutes/.test(document.getElementById("renderNote").textContent), null, { timeout: 15000 });
    assert.equal(await page.isDisabled("#create"), true);
  });
  test("exactly 3 minutes across 5 clips (60 s max each) is accepted", async () => {
    await open({ ai: false });
    await page.setInputFiles("#clips", [f("a_60s.mp4"), f("b_60s.mp4"), f("c_30s.mp4"), f("d_20s.mp4"), f("e_10s.mp4")]);
    await page.waitForFunction(() => !document.getElementById("create").disabled, null, { timeout: 15000 });
  });
});

describe("AI edit plan", () => {
  test("happy path: Turnstile (official test key) → /pass → /status → /generate; plan order drives the render", async () => {
    await open();
    assert.equal(await page.isVisible("#aiBox"), true);
    await addClips();
    await page.click('button[data-plan="ai"]');
    await page.click('button[data-style="dynamic"]');
    await page.click("#create");
    await waitStatus(/Film ready/);
    assert.deepEqual(api.calls.map((c) => c.path).filter((p, i, a) => a.indexOf(p) === i).sort(), ["/generate", "/pass", "/status"]);
    assert.ok(api.tokens.length === 1 && api.tokens[0].length > 10, "real Turnstile token was sent to /pass");
    const gen = api.calls.find((c) => c.path === "/generate").body;
    assert.deepEqual(gen.clips, [{ duration: 5.2 }, { duration: 8 }]); // only durations leave the browser
    assert.equal(gen.style, "dynamic");
    assert.match(await graph(), /^\[1:v\]trim=start=0\.5:duration=6.*\[0:v\]trim=start=0\.2:duration=4\.5/); // AI order+trim drive FFmpeg
    assert.match(await text("#resultNote"), /AI-assisted edit plan/);
    assert.match(await text("#status"), /follow the AI edit plan/);
    await page.waitForFunction(() => /1 of 3 free AI edits used/.test(document.getElementById("aiNote").textContent));
    assert.equal(await page.isHidden("#turnstileBox"), true);
  });
  test("failed token (verification_failed) is retried with a fresh Turnstile token", async () => {
    api.passFailuresLeft = 1;
    await open(); await addClips();
    await page.click('button[data-plan="ai"]'); await page.click("#create");
    await waitStatus(/Film ready/);
    assert.equal(api.tokens.length, 2); // second /pass used a token from the re-armed widget (test keys always return the same dummy token)
    assert.match(await text("#status"), /Film ready/);
  });
  test("server fallback plan is never labelled as AI", async () => {
    api.generateResponse = { status: 200, body: { ok: true, usedFallback: true, plan: { order: GOOD_ORDER } } };
    await open(); await addClips();
    await page.click('button[data-plan="ai"]'); await page.click("#create");
    await waitStatus(/Film ready/);
    assert.match(await text("#resultNote"), /not AI-edited/);
    assert.ok(!/AI-assisted/.test(await text("#resultNote")));
    assert.match(await text("#status"), /not AI-edited/);
  });
  test("interactive challenge can be cancelled → browser preview still works, no AI claim", async () => {
    await open({ key: KEY_INTERACTIVE }); await addClips();
    await page.click('button[data-plan="ai"]'); await page.click("#create");
    await waitStatus(/complete the human check/);
    await page.waitForFunction(() => !document.getElementById("turnstileBox").hidden); // widget appears only when verification is needed
    await page.click('button[data-plan="preview"]');
    await waitStatus(/Human check cancelled/);
    assert.equal(await page.isHidden("#turnstileBox"), true);
    assert.equal(await page.isDisabled("#create"), false);
    assert.ok(!api.calls.some((c) => c.path === "/generate"));
    await page.click("#create");
    await waitStatus(/Film ready/);
    assert.match(await text("#resultNote"), /Browser preview · no AI/);
  });
  test("cookie blocked by the browser: actionable error, no generate call", async () => {
    api.cookieBlocked = true;
    await open(); await addClips();
    await page.click('button[data-plan="ai"]'); await page.click("#create");
    await waitStatus(/blocked the CLAQE verification cookie/);
    assert.ok(!api.calls.some((c) => c.path === "/generate"));
    assert.equal(await ffmpegRuns(), 0);
  });

  const failures = [
    ["free quota already used", (a) => { a.passed = true; a.used = 3; }, /free AI edits/, false],
    ["quota not configured (fail closed)", (a) => { a.passed = true; a.quotaConfigured = false; }, /temporarily unavailable/, false],
    ["AI disabled", (a) => { a.passed = true; a.aiEnabled = false; }, /paused/, false],
    ["server rejects with free_limit", (a) => { a.passed = true; a.generateResponse = { status: 429, body: { ok: false, code: "free_limit" } }; }, /free AI edits/, true],
    ["upstream AI outage", (a) => { a.passed = true; a.generateResponse = { status: 502, body: { ok: false, code: "ai_unavailable" } }; }, /was not used/, true],
    ["daily budget reached", (a) => { a.passed = true; a.generateResponse = { status: 402, body: { ok: false, code: "budget_daily" } }; }, /today/, true],
    ["network failure", (a) => { a.passed = true; a.generateResponse = "drop"; }, /Couldn't reach the CLAQE server/, true],
    ["unusable plan (duplicate indices)", (a) => { a.passed = true; a.generateResponse = { status: 200, body: { ok: true, usedFallback: false, plan: { order: [{ index: 0, start: 0, duration: 4 }, { index: 0, start: 0, duration: 4 }] } } }; }, /wasn't usable/, true],
  ];
  for (const [name, setup, re, calledGenerate] of failures) {
    test("failure: " + name + " → clear message, no render, no fake AI success", async () => {
      setup(api);
      await open(); await addClips();
      await page.click('button[data-plan="ai"]'); await page.click("#create");
      await waitStatus(re, 20000);
      assert.match(await text("#status"), /Choose .Browser preview./);
      assert.equal(api.calls.some((c) => c.path === "/generate"), calledGenerate);
      assert.equal(await ffmpegRuns(), 0);
      assert.equal(await resultVisible(), false);
      assert.equal(await page.isDisabled("#create"), false);
      // The user can still make an honestly-labelled preview afterwards.
      await page.click('button[data-plan="preview"]'); await page.click("#create");
      await waitStatus(/Film ready/);
      assert.match(await text("#resultNote"), /Browser preview · no AI/);
      assert.match(await graph(), /^\[0:v\]trim/);
    });
  }
  test("AI plan fetched but render fails: no 'AI' success shown", async () => {
    await open(); await addClips();
    await page.click('button[data-plan="ai"]');
    await page.evaluate(() => (window.__ffmpegExit = 1));
    await page.click("#create");
    await waitStatus(/Export failed/);
    assert.equal(await resultVisible(), false);
    assert.ok(!/Film ready/.test(await text("#status")));
  });
});
