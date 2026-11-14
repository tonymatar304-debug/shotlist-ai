// Run from the repo root: node --test tests/
// Uses a mocked fetch only: no network, no Worker, no paid API.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { resolveBase, createClient, describeQuota, describeSource, MESSAGES } = require("../claqe-api.js");

const BASE = "http://127.0.0.1:8787";
function mockFetch(status, body, { throws } = {}) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init });
    if (throws) throw new TypeError("Failed to fetch");
    return { ok: status >= 200 && status < 300, status, json: async () => { if (body === undefined) throw new Error("not json"); return body; } };
  };
  f.calls = calls;
  return f;
}
const GEN = { clips: [{ duration: 5, file: "secret.mov" }, { duration: 8 }], style: "dynamic", targetSeconds: 20 };

test("resolveBase: explicit config, localhost ?api=, and refusals", () => {
  assert.equal(resolveBase({ configured: "https://api.claqe.com/" }), "https://api.claqe.com");
  assert.equal(resolveBase({ hostname: "localhost", search: "?api=http://127.0.0.1:8787" }), "http://127.0.0.1:8787");
  assert.equal(resolveBase({ hostname: "claqe.com", search: "?api=https://evil.example" }), null); // live site ignores ?api=
  assert.equal(resolveBase({ configured: "http://evil.example" }), null);                          // plain http only for localhost
  assert.equal(resolveBase({ configured: "javascript:alert(1)" }), null);
  assert.equal(resolveBase({}), null);
  assert.throws(() => createClient({}), /not configured/);
});

test("pass: sends token with credentials, never calls without a token", async () => {
  const f = mockFetch(200, { ok: true, uid: "u1" });
  const c = createClient({ baseUrl: BASE, fetch: f });
  assert.equal((await c.pass("")).code, "verification_failed");
  assert.equal(f.calls.length, 0);
  const r = await c.pass("tok");
  assert.equal(r.ok, true);
  assert.equal(f.calls[0].url, BASE + "/pass");
  assert.equal(f.calls[0].init.credentials, "include");
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { turnstileToken: "tok" });
});

test("generate: only durations are sent; source reflects AI vs server fallback", async () => {
  for (const [usedFallback, source] of [[false, "ai"], [true, "server-fallback"]]) {
    const f = mockFetch(200, { ok: true, plan: { order: [{ index: 0, start: 0, duration: 4 }] }, usedFallback, passUsage: "1/30" });
    const r = await createClient({ baseUrl: BASE, fetch: f }).generate(GEN);
    assert.equal(r.ok, true); assert.equal(r.source, source); assert.equal(r.plan.order.length, 1);
    assert.deepEqual(JSON.parse(f.calls[0].init.body), { clips: [{ duration: 5 }, { duration: 8 }], style: "dynamic", targetSeconds: 20 });
  }
});

test("errors map to actionable text and NEVER yield a plan", async () => {
  const cases = [
    [429, { code: "free_limit" }, /free AI edits/], [503, { code: "quota_unconfigured" }, /unavailable/],
    [402, { code: "budget_daily" }, /today/], [402, { code: "budget_monthly" }, /month/],
    [502, { code: "ai_unavailable" }, /was not used/], [401, { code: "pass_required" }, /human check/],
    [403, { code: "verification_failed" }, /verification failed/], [403, { code: "origin_not_allowed" }, /official address/],
    [429, { code: "rate_limited" }, /Too many/], [403, { code: "ai_disabled" }, /paused/], [400, { code: "invalid_request" }, /2 to 5/],
    [401, { ok: false, error: "No valid pass" }, /human check/], [500, { ok: false }, /server/],
  ];
  for (const [status, body, re] of cases) {
    const r = await createClient({ baseUrl: BASE, fetch: mockFetch(status, { ok: false, ...body }) }).generate(GEN);
    assert.equal(r.ok, false, JSON.stringify(body)); assert.match(r.message, re); assert.equal(r.plan, undefined);
  }
  const net = await createClient({ baseUrl: BASE, fetch: mockFetch(0, null, { throws: true }) }).generate(GEN);
  assert.equal(net.code, "network"); assert.equal(net.retryable, true);
  const html = await createClient({ baseUrl: BASE, fetch: mockFetch(200, undefined) }).status();
  assert.equal(html.code, "bad_response");
  const notOk = await createClient({ baseUrl: BASE, fetch: mockFetch(200, { plan: {} }) }).generate(GEN); // 200 without ok:true
  assert.equal(notOk.ok, false);
});

test("describeQuota never claims availability the server didn't confirm", () => {
  assert.equal(describeQuota(null), "AI status unknown.");
  assert.match(describeQuota({ ok: true, ai_enabled: false }), /paused/);
  assert.match(describeQuota({ ok: true, ai_enabled: true, pass: { valid: false } }), /human check/);
  assert.match(describeQuota({ ok: true, ai_enabled: true, pass: { valid: true }, quota_configured: false }), /unavailable/);
  assert.match(describeQuota({ ok: true, ai_enabled: true, pass: { valid: true } }), /unavailable/); // free missing => not available
  assert.equal(describeQuota({ ok: true, ai_enabled: true, pass: { valid: true }, quota_configured: true, free: { used: 1, limit: 3 } }), "1 of 3 free AI edits used this month");
  assert.match(describeQuota({ ok: true, ai_enabled: true, pass: { valid: true }, quota_configured: true, free: { used: 3, limit: 3 } }), /none left/);
});

test("browser preview and server fallback are never labelled as AI", () => {
  assert.match(describeSource("ai"), /AI-assisted/);
  assert.match(describeSource("server-fallback"), /not AI-edited/);
  assert.match(describeSource("browser-preview"), /no AI/);
  assert.match(describeSource(undefined), /no AI/);
});

test("contract: every error code the Worker can emit has a client message", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "shotlist-api-dev", "src", "worker.js"), "utf8");
  const codes = new Set([...src.matchAll(/code: "([a-z_]+)"/g)].map((m) => m[1]));
  assert.ok(codes.size >= 12, "found " + codes.size);
  for (const code of codes) assert.ok(MESSAGES[code], "missing client message for Worker code: " + code);
});

test("no API key or Anthropic endpoint in any frontend file (key lives only in the Worker)", () => {
  const root = path.join(__dirname, ".."), files = ["index.html", "claqe-api.js", "claqe-analyze.js", "claqe-vision.js", "claqe-config.js"];
  for (const f of files) {
    const src = fs.readFileSync(path.join(root, f), "utf8");
    for (const bad of [/sk-ant-/i, /ANTHROPIC_API_KEY/, /x-api-key/i, /api\.anthropic\.com/i]) assert.ok(!bad.test(src), f + " contains " + bad);
  }
});
