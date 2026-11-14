import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { startWorker, startMockAnthropic, client, TS } from "./helpers.mjs";

let w, mock;
const CLIPS = [{ duration: 5 }, { duration: 8 }];
const GOOD = { clips: CLIPS, style: "dynamic", targetSeconds: 20 };
const planBody = (order, usage = { input_tokens: 1000, output_tokens: 200 }) => ({ content: [{ type: "text", text: JSON.stringify({ order }) }], usage });
const GOOD_PLAN = [{ index: 1, start: 0, duration: 6 }, { index: 0, start: 0.5, duration: 4 }];

before(async () => {
  mock = await startMockAnthropic();
  w = await startWorker({ turnstileSecret: TS.ALWAYS_PASS, anthropicUrl: mock.url });
});
after(async () => { await w?.stop(); await mock?.close(); });

async function withPass() {
  const c = client(w.base);
  const r = await c.call("/pass", { method: "POST", json: { turnstileToken: TS.TOKEN } });
  assert.equal(r.status, 200);
  return c;
}

describe("CORS", () => {
  test("preflight for allowed origin", async () => {
    const r = await client(w.base).call("/pass", { method: "OPTIONS" });
    assert.equal(r.status, 204);
    assert.equal(r.headers.get("access-control-allow-origin"), "https://claqe.com");
    assert.equal(r.headers.get("access-control-allow-credentials"), "true");
  });
  for (const o of ["https://evil.com", "https://www.claqe.com", "http://claqe.com"]) {
    test("rejects origin " + o, async () => {
      const r = await client(w.base).call("/status", { origin: o });
      assert.equal(r.status, 403);
      assert.equal(r.headers.get("access-control-allow-origin"), null);
    });
  }
});

describe("/pass and cookie", () => {
  test("rejects missing token, malformed JSON and GET", async () => {
    const c = client(w.base);
    assert.equal((await c.call("/pass", { method: "POST", json: {} })).status, 403);
    assert.equal((await c.call("/pass", { method: "POST", raw: "nope" })).status, 403);
    assert.equal((await c.call("/pass")).status, 403);
  });
  test("issues a cookie with the right attributes", async () => {
    const r = await client(w.base).call("/pass", { method: "POST", json: { turnstileToken: TS.TOKEN } });
    assert.equal(r.status, 200);
    for (const a of ["slai_pass=", "HttpOnly", "Secure", "SameSite=None", "Path=/", "Max-Age=2592000"]) assert.ok(r.setCookie.includes(a), a);
  });
});

describe("/status", () => {
  test("valid / missing / tampered / expired cookie", async () => {
    const c = await withPass();
    assert.equal((await c.call("/status")).data.pass.valid, true);
    assert.equal((await c.call("/status", { useCookie: false })).data.pass.valid, false);
    const good = c.cookie;
    c.cookie = good + "x";
    assert.equal((await c.call("/status")).data.pass.valid, false);
    c.cookie = "slai_pass=a.1.b";
    assert.equal((await c.call("/status")).data.pass.valid, false);
  });
});

describe("/generate validation", () => {
  const bad = {
    "bad JSON": { raw: "nope" }, "null body": { raw: "null" }, "array body": { raw: "[]" },
    "1 clip": { json: { clips: [{ duration: 5 }] } },
    "6 clips": { json: { clips: Array(6).fill({ duration: 5 }) } },
    "clip over 60s": { json: { clips: [{ duration: 61 }, { duration: 5 }] } },
    "over 180s combined": { json: { clips: Array(4).fill({ duration: 50 }) } },
    "string duration": { json: { clips: [{ duration: "5" }, { duration: 5 }] } },
    "null clips": { json: { clips: [null, null] } },
    "NaN-like duration": { raw: '{"clips":[{"duration":1e999},{"duration":5}]}' },
    "too short": { json: { clips: [{ duration: 0.5 }, { duration: 5 }] } },
  };
  test("requires a pass", async () => {
    assert.equal((await client(w.base).call("/generate", { method: "POST", json: GOOD })).status, 401);
  });
  for (const [name, req] of Object.entries(bad)) {
    test("400 for " + name, async () => {
      const c = await withPass();
      assert.equal((await c.call("/generate", { method: "POST", ...req })).status, 400);
    });
  }
});

describe("/generate with mocked Anthropic (no real API)", () => {
  test("success: returns the model's plan, logs usage, settles budget", async () => {
    const c = await withPass();
    mock.calls.length = 0;
    mock.respond(200, planBody(GOOD_PLAN));
    const r = await c.call("/generate", { method: "POST", json: GOOD });
    assert.equal(r.status, 200);
    assert.equal(r.data.usedFallback, false);
    assert.deepEqual(r.data.plan.order, GOOD_PLAN);
    assert.equal(r.data.plan.style, "dynamic");
    assert.equal(r.data.passUsage, "1/30");
    assert.equal(mock.calls.length, 1);
    assert.equal(mock.calls[0].headers["x-api-key"], "mock-key-not-real");
    const rows = w.sql("SELECT model, input_tokens, output_tokens, status FROM usage_log ORDER BY id DESC LIMIT 1");
    assert.deepEqual(rows[0], { model: "claude-haiku-5-5", input_tokens: 1000, output_tokens: 200, status: "ok" });
    // 1000 in * $0.10/M + 200 out * $0.50/M = $0.0002 (reservation refunded down to real cost)
    const used = Number((await c.call("/status")).data.budget.daily_used);
    assert.ok(used >= 0.0002 - 1e-9, "daily_used " + used);
  });
  for (const [name, order] of [["duplicate index", [{ index: 0, start: 0, duration: 4 }, { index: 0, start: 0, duration: 4 }]], ["overlong total", [{ index: 0, start: 0, duration: 5 }, { index: 1, start: 0, duration: 8 }].map((x) => ({ ...x, duration: x.duration + 20 }))], ["not an array", "oops"]]) {
    test("falls back on invalid model plan: " + name, async () => {
      const c = await withPass();
      mock.respond(200, planBody(order));
      const r = await c.call("/generate", { method: "POST", json: GOOD });
      assert.equal(r.status, 200);
      assert.equal(r.data.usedFallback, true);
      assert.equal(r.data.plan.order.length, 2);
    });
  }
  test("falls back when model replies with non-JSON text", async () => {
    const c = await withPass();
    mock.respond(200, { content: [{ type: "text", text: "sorry, no" }], usage: { input_tokens: 10, output_tokens: 5 } });
    const r = await c.call("/generate", { method: "POST", json: GOOD });
    assert.equal(r.status, 200);
    assert.equal(r.data.usedFallback, true);
  });
  test("upstream error: 502 and reservation fully released", async () => {
    const c = await withPass();
    const before = Number((await c.call("/status")).data.budget.daily_used);
    mock.respond(500, { error: { message: "mock outage" } });
    const r = await c.call("/generate", { method: "POST", json: GOOD });
    assert.equal(r.status, 502);
    assert.ok(!JSON.stringify(r.data).includes("mock outage"), "must not leak upstream message");
    assert.equal(Number((await c.call("/status")).data.budget.daily_used), before);
  });
});

describe("rate limits", () => {
  test("malformed requests do not consume the pass allowance", async () => {
    const c = await withPass();
    mock.respond(200, planBody(GOOD_PLAN));
    for (let i = 0; i < 10; i++) assert.equal((await c.call("/generate", { method: "POST", raw: "nope" })).status, 400);
    for (let i = 0; i < 5; i++) assert.equal((await c.call("/generate", { method: "POST", json: { clips: [null, null] } })).status, 400);
    const r = await c.call("/generate", { method: "POST", json: GOOD });
    assert.equal(r.status, 200);
    assert.equal(r.data.passUsage, "1/30"); // only the one valid request counted
  });
  test("pass limit: 30 valid requests allowed, 31st gets 429", async () => {
    const c = await withPass();
    mock.respond(200, planBody(GOOD_PLAN));
    w.sql("UPDATE settings SET value='1000' WHERE key='free_monthly_limit'"); // isolate the pass limit from the free quota
    try {
    // Rotate IPs so the per-IP limit is not what trips.
    for (let i = 1; i <= 30; i++) assert.equal((await c.call("/generate", { method: "POST", json: GOOD, ipOverride: `10.2.${i}.1` })).status, 200, "request " + i);
    assert.equal((await c.call("/generate", { method: "POST", json: GOOD, ipOverride: "10.2.99.1" })).status, 429);
    } finally { w.sql("UPDATE settings SET value='3' WHERE key='free_monthly_limit'"); }
  });
  test("IP limit still counts malformed requests (abuse protection)", async () => {
    const attacker = "10.3.0.1";
    const passes = [];
    for (let i = 0; i < 4; i++) passes.push(await withPass()); // several passes behind one IP
    let first429 = 0;
    for (let i = 1; i <= 70 && !first429; i++) {
      const r = await passes[i % 4].call("/generate", { method: "POST", raw: "nope", ipOverride: attacker });
      if (r.status === 429) first429 = i; else assert.equal(r.status, 400);
    }
    assert.equal(first429, 61); // IP_LIMIT = 60
  });
});

describe("users and free monthly limit", () => {
  const gen = (c) => c.call("/generate", { method: "POST", json: GOOD });
  const uidOf = async (c) => (await c.call("/status")).data.pass.uid;
  test("/pass registers the user as free/active", async () => {
    const c = await withPass();
    const [u] = w.sql("SELECT plan, status, created_at FROM users WHERE id='" + (await uidOf(c)) + "'");
    assert.equal(u.plan, "free"); assert.equal(u.status, "active"); assert.ok(u.created_at > 0);
  });
  test("3 successful generations allowed, 4th is 429 free_limit without calling upstream", async () => {
    const c = await withPass();
    mock.respond(200, planBody(GOOD_PLAN));
    for (let i = 0; i < 3; i++) assert.equal((await gen(c)).status, 200);
    const calls = mock.calls.length;
    const r = await gen(c);
    assert.equal(r.status, 429); assert.equal(r.data.code, "free_limit");
    assert.equal(mock.calls.length, calls);
    assert.deepEqual((await c.call("/status")).data.free, { used: 3, limit: 3 });
  });
  test("quota is per user", async () => {
    const a = await withPass(), b = await withPass();
    mock.respond(200, planBody(GOOD_PLAN));
    for (let i = 0; i < 3; i++) await gen(a);
    assert.equal((await gen(a)).status, 429);
    assert.equal((await gen(b)).status, 200);
  });
  test("failed upstream calls and malformed requests do not use quota", async () => {
    const c = await withPass();
    mock.respond(500, { error: { message: "x" } });
    for (let i = 0; i < 4; i++) assert.equal((await gen(c)).status, 502);
    for (let i = 0; i < 4; i++) assert.equal((await c.call("/generate", { method: "POST", raw: "nope" })).status, 400);
    mock.respond(200, planBody(GOOD_PLAN));
    assert.equal((await gen(c)).status, 200);
    assert.equal((await c.call("/status")).data.free.used, 1);
  });
  test("blocked user gets 403; paid plan is not capped by the free limit", async () => {
    const blocked = await withPass(), paid = await withPass();
    mock.respond(200, planBody(GOOD_PLAN));
    w.sql("UPDATE users SET status='blocked' WHERE id='" + (await uidOf(blocked)) + "'");
    assert.equal((await gen(blocked)).status, 403);
    w.sql("UPDATE users SET plan='paid' WHERE id='" + (await uidOf(paid)) + "'");
    for (let i = 0; i < 5; i++) assert.equal((await gen(paid)).status, 200);
  });
  for (const [name, setup] of [["missing", "DELETE FROM settings WHERE key='free_monthly_limit'"], ["non-numeric", "UPDATE settings SET value='abc' WHERE key='free_monthly_limit'"], ["negative", "UPDATE settings SET value='-1' WHERE key='free_monthly_limit'"], ["empty", "UPDATE settings SET value='' WHERE key='free_monthly_limit'"]]) {
    test("fail closed for free users when free_monthly_limit is " + name, async () => {
      const c = await withPass();
      mock.respond(200, planBody(GOOD_PLAN));
      const calls = mock.calls.length;
      w.sql(setup);
      try {
        const r = await gen(c);
        assert.equal(r.status, 503); assert.equal(r.data.code, "quota_unconfigured");
        assert.equal(mock.calls.length, calls); // no upstream (paid) call
        assert.equal((await c.call("/status")).data.quota_configured, false);
      } finally { w.sql("DELETE FROM settings WHERE key='free_monthly_limit'"); w.sql("INSERT INTO settings (key, value) VALUES ('free_monthly_limit','3')"); }
    });
  }
});

describe("schema (matches verified remote schema)", () => {
  test("tables and indexes exist locally", () => {
    const names = w.sql("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").map((r) => r.name).sort();
    assert.deepEqual(names, ["budget_ledger", "idx_usage_ts", "idx_usage_user_ts", "rate_limits", "settings", "usage_log", "users"]);
  });
  test("usage_log rows written by the Worker satisfy NOT NULL constraints", async () => {
    const c = await withPass();
    mock.respond(200, planBody(GOOD_PLAN));
    assert.equal((await c.call("/generate", { method: "POST", json: GOOD })).status, 200);
    const [row] = w.sql("SELECT ts, status, error FROM usage_log ORDER BY id DESC LIMIT 1");
    assert.ok(row.ts > 0 && row.status === "ok" && row.error === null);
  });
});

describe("misc", () => {
  test("unknown path 404 and /test health", async () => {
    const c = client(w.base);
    assert.equal((await c.call("/nope")).status, 404);
    assert.equal((await c.call("/test")).data.ok, true);
  });
  test("generation disabled setting returns 403", async () => {
    const c = await withPass();
    w.sql("UPDATE settings SET value='0' WHERE key='ai_enabled'"); // local temp DB only
    try { assert.equal((await c.call("/generate", { method: "POST", json: GOOD })).status, 403); }
    finally { w.sql("UPDATE settings SET value='1' WHERE key='ai_enabled'"); }
  });
});
