// Turnstile failure scenarios using Cloudflare's official dummy secrets (siteverify is called; it is free).
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { startWorker, client, TS } from "./helpers.mjs";

describe("Turnstile always-fail secret", async () => {
  const w = await startWorker({ turnstileSecret: TS.ALWAYS_FAIL });
  after(() => w.stop());
  test("/pass is refused and no cookie is set", async () => {
    const c = client(w.base);
    const r = await c.call("/pass", { method: "POST", json: { turnstileToken: TS.TOKEN } });
    assert.equal(r.status, 403);
    assert.equal(r.setCookie, null);
    assert.equal(r.data.ok, false);
    assert.equal((await c.call("/status")).data.pass.valid, false);
    assert.equal((await c.call("/generate", { method: "POST", json: { clips: [{ duration: 5 }, { duration: 5 }] } })).status, 401);
  });
});

describe("Turnstile already-spent (duplicate) token secret", async () => {
  const w = await startWorker({ turnstileSecret: TS.TOKEN_SPENT });
  after(() => w.stop());
  test("reusing a spent token is refused every time, no cookie", async () => {
    const c = client(w.base);
    for (let i = 0; i < 2; i++) {
      const r = await c.call("/pass", { method: "POST", json: { turnstileToken: TS.TOKEN } });
      assert.equal(r.status, 403, "attempt " + i);
      assert.equal(r.setCookie, null);
    }
  });
});
