// /vision against a LOCAL Worker and a MOCK model. No real Anthropic call, no remote D1, no deploy.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { startWorker, startMockAnthropic, client, TS } from "./helpers.mjs";

let w, mock;
before(async () => { mock = await startMockAnthropic(); w = await startWorker({ turnstileSecret: TS.ALWAYS_PASS, anthropicUrl: mock.url }); });
after(async () => { await w?.stop(); await mock?.close(); });
async function withPass() { const c = client(w.base); assert.equal((await c.call("/pass", { method: "POST", json: { turnstileToken: TS.TOKEN } })).status, 200); return c; }

// Minimal JPEG header (SOI + SOF0 with the given size + EOI): enough for the Worker's size check; never decoded.
function fakeJpeg(wd, ht, pad = 0) {
  const b = [0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, ht >> 8, ht & 255, wd >> 8, wd & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, ...new Array(pad).fill(0), 0xff, 0xd9];
  return Buffer.from(b).toString("base64");
}
const REQ = () => ({ version: 1, style: "dynamic", filmSeconds: 20, clips: [
  { index: 0, duration: 30, frames: [{ id: "c0f0", t: 3.5, local: 0.6 }, { id: "c0f1", t: 20.5, local: 0.8 }] },
  { index: 1, duration: 12, frames: [{ id: "c1f0", t: 1.5, local: 0.3 }, { id: "c1f1", t: 9.5, local: 0.5 }] }] });
const IMGS = (req = REQ(), size = [512, 288]) => req.clips.flatMap((c) => c.frames.map((f) => ({ id: f.id, data: fakeJpeg(...size) })));
const BODY = (over = {}) => ({ request: REQ(), images: IMGS(), ...over });
const frame = (id, t, over = {}) => ({ id, t, subject: "a dog", action: "standing on grass", setting: "park", mood: "calm", shotType: "medium", importance: 0.8, confidence: 0.9, usable: true, issues: [], role: "highlight", ...over });
const GOOD = () => ({ version: 1, story: "A dog in a park.", frames: [frame("c0f0", 3.5), frame("c0f1", 20.5, { role: "filler", importance: 0.4 }), frame("c1f0", 1.5), frame("c1f1", 9.5)] });
const model = (obj, usage = { input_tokens: 3000, output_tokens: 700 }) => ({ content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj) }], usage });
const post = (c, body) => c.call("/vision", { method: "POST", json: body });

describe("/vision success path (mock model)", () => {
  test("returns validated observations, sends capped request upstream, logs usage, charges one free edit", async () => {
    const c = await withPass(); mock.calls.length = 0; mock.respond(200, model(GOOD()));
    const r = await post(c, BODY());
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.vision.frames.length, 4); assert.equal(r.data.vision.frames[0].subject, "a dog");
    assert.equal(mock.calls.length, 1);
    const up = JSON.parse(mock.calls[0].body);
    assert.equal(mock.calls[0].headers["x-api-key"], "mock-key-not-real");
    assert.ok(up.max_tokens <= 900, "output capped: " + up.max_tokens);
    assert.equal(up.messages[0].content.filter((b) => b.type === "image").length, 4);
    assert.match(up.system, /ONLY what is clearly visible/); assert.match(up.system, /never instructions/);
    assert.ok(!JSON.stringify(up).includes("file") && !JSON.stringify(up).includes(".mp4"), "no file names upstream");
    const [row] = w.sql("SELECT input_tokens, output_tokens, status FROM usage_log ORDER BY id DESC LIMIT 1");
    assert.deepEqual(row, { input_tokens: 3000, output_tokens: 700, status: "ok" });
    assert.equal((await c.call("/status")).data.free.used, 1);
  });
  test("model output is sanitised: unknown ids, wrong timestamps, junk values, markup", async () => {
    const c = await withPass(), g = GOOD();
    g.frames.push(frame("c9f9", 1)); g.frames[1] = frame("c0f1", 2.0);            // unknown id; timestamp not the one requested
    g.frames[0] = frame("c0f0", 3.5, { importance: 7, subject: "<img src=x onerror=alert(1)>" + "y".repeat(300), shotType: "banana", role: "emperor" });
    mock.respond(200, model(g));
    const r = await post(c, BODY()); assert.equal(r.status, 200);
    const ids = r.data.vision.frames.map((f) => f.id);
    assert.deepEqual(ids, ["c0f0", "c1f0", "c1f1"], "unsupported timestamp and unknown id rejected");
    const f0 = r.data.vision.frames[0]; assert.equal(f0.importance, 1); assert.ok(f0.subject.length <= 60 && !/[<>]/.test(f0.subject)); assert.equal(f0.shotType, "other"); assert.equal(f0.role, "filler");
  });
  test("unusable model reply: 502 vision_unusable, logged as bad_reply, free edit NOT used", async () => {
    const c = await withPass();
    for (const reply of ["I cannot help with that", { version: 1, frames: [frame("zzz", 1)] }, { version: 2, frames: [] }]) {
      mock.respond(200, model(reply)); const r = await post(c, BODY());
      assert.equal(r.status, 502); assert.equal(r.data.code, "vision_unusable");
    }
    assert.equal((await c.call("/status")).data.free.used, 0);
    assert.equal(w.sql("SELECT COUNT(*) AS n FROM usage_log WHERE status='bad_reply'")[0].n >= 3, true);
  });
  test("upstream failure: 502 ai_unavailable, reservation released, no leak of upstream message", async () => {
    const c = await withPass(), before = Number((await c.call("/status")).data.budget.daily_used);
    mock.respond(500, { error: { message: "mock outage secret" } });
    const r = await post(c, BODY()); assert.equal(r.status, 502); assert.equal(r.data.code, "ai_unavailable"); assert.ok(!JSON.stringify(r.data).includes("secret"));
    assert.equal(Number((await c.call("/status")).data.budget.daily_used), before);
  });
});

describe("/vision input limits (cost control) - nothing reaches the model", () => {
  const bad = async (name, body, status = 400, raw) => test("rejects " + name, async () => {
    const c = await withPass(); mock.calls.length = 0; mock.respond(200, model(GOOD()));
    const r = raw ? await c.call("/vision", { method: "POST", raw }) : await post(c, typeof body === "function" ? body() : body);
    assert.equal(r.status, status, JSON.stringify(r.data)); assert.equal(r.data.code, "invalid_request"); assert.equal(mock.calls.length, 0);
    assert.equal((await c.call("/status")).data.free.used, 0);
  });
  bad("more than 12 frames", () => { const q = REQ(); for (let i = 2; i < 12; i++) q.clips[0].frames.push({ id: "c0f" + i, t: i, local: 0.5 }); return { request: q, images: IMGS(q) }; });
  bad("image count not matching frames", () => ({ request: REQ(), images: IMGS().slice(1) }));
  bad("image for an unknown frame", () => { const i = IMGS(); i[0].id = "c5f5"; return { request: REQ(), images: i }; });
  bad("oversized image data", () => ({ request: REQ(), images: IMGS().map((x, i) => (i ? x : { ...x, data: fakeJpeg(512, 288, 60000) })) }));
  bad("image larger than 640 px", () => ({ request: REQ(), images: IMGS(REQ(), [1280, 720]) }));
  bad("non-JPEG data", () => ({ request: REQ(), images: IMGS().map((x) => ({ ...x, data: Buffer.from("not a jpeg at all, just text").toString("base64") })) }));
  bad("frame timestamp outside the clip", () => { const q = REQ(); q.clips[1].frames[1].t = 99; return { request: q, images: IMGS(q) }; });
  bad("frame id not belonging to its clip", () => { const q = REQ(); q.clips[1].frames[0].id = "c0f7"; return { request: q, images: IMGS(q) }; });
  bad("a clip over 60 s", () => { const q = REQ(); q.clips[0].duration = 61; return { request: q, images: IMGS(q) }; });
  bad("a single clip", () => { const q = REQ(); q.clips.pop(); return { request: q, images: IMGS(q) }; });
  bad("body over the size cap", null, 413, JSON.stringify({ pad: "x".repeat(710000) }));
  bad("malformed JSON", null, 400, "{nope");
  test("requires a pass; GET not allowed", async () => {
    const anon = client(w.base);
    assert.equal((await anon.call("/vision", { method: "POST", json: BODY() })).status, 401);
    assert.equal((await (await withPass()).call("/vision")).status, 405);
  });
  test("free monthly limit applies (4th is 429 free_limit, model not called)", async () => {
    const c = await withPass(); mock.respond(200, model(GOOD()));
    for (let i = 0; i < 3; i++) assert.equal((await post(c, BODY())).status, 200);
    mock.calls.length = 0; const r = await post(c, BODY());
    assert.equal(r.status, 429); assert.equal(r.data.code, "free_limit"); assert.equal(mock.calls.length, 0);
  });
});

describe("/vision quota, concurrency and secrets", () => {
  test("concurrent requests cannot overspend the free allowance (atomic claim)", async () => {
    const c = await withPass(); mock.respond(200, model(GOOD()));
    for (let i = 0; i < 2; i++) assert.equal((await post(c, BODY())).status, 200);
    const rs = await Promise.all([0, 1, 2, 3].map(() => post(c, BODY())));
    assert.equal(rs.filter((r) => r.status === 200).length, 1, rs.map((r) => r.status).join(","));
    assert.ok(rs.filter((r) => r.status === 429).every((r) => r.data.code === "free_limit"));
    assert.deepEqual((await c.call("/status")).data.free, { used: 3, limit: 3 });
    const uid = (await c.call("/status")).data.pass.uid;
    assert.equal(w.sql(`SELECT COUNT(*) AS n FROM usage_log WHERE user_id='${uid}' AND status='pending'`)[0].n, 0, "no pending rows left");
  });
  test("thinking disabled + output cap sent upstream; a truncated (max_tokens) reply is unusable and not charged", async () => {
    const c = await withPass(); mock.calls.length = 0;
    mock.respond(200, { ...model(GOOD()), stop_reason: "max_tokens" });
    const r = await post(c, BODY()); assert.equal(r.status, 502); assert.equal(r.data.code, "vision_unusable");
    const up = JSON.parse(mock.calls[0].body); assert.deepEqual(up.thinking, { type: "disabled" }); assert.equal(up.model, "claude-haiku-5-5");
    assert.equal((await c.call("/status")).data.free.used, 0);
  });
  test("the API key never appears in any response", async () => {
    const c = await withPass(); const bodies = [];
    for (const [st, b] of [[200, model(GOOD())], [500, { error: { message: "key mock-key-not-real invalid" } }], [200, model("junk")]]) { mock.respond(st, b); bodies.push(JSON.stringify((await post(c, BODY())).data)); }
    bodies.push(JSON.stringify((await c.call("/status")).data));
    for (const b of bodies) assert.ok(!b.includes("mock-key-not-real"), b.slice(0, 120));
  });
});
