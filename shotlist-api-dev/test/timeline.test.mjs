// /vision v2 (timeline: contact sheets -> phase segments) against a LOCAL Worker and a MOCK model. No real Anthropic call.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { startWorker, startMockAnthropic, client, TS } from "./helpers.mjs";
import { validateTimelineInput, validateTimelineOutput, TL_MAX_TILES } from "../src/timeline.js";

let w, mock;
before(async () => { mock = await startMockAnthropic(); w = await startWorker({ turnstileSecret: TS.ALWAYS_PASS, anthropicUrl: mock.url }); });
after(async () => { await w?.stop(); await mock?.close(); });
async function withPass() { const c = client(w.base); assert.equal((await c.call("/pass", { method: "POST", json: { turnstileToken: TS.TOKEN } })).status, 200); return c; }

function fakeJpeg(wd, ht) { return Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, ht >> 8, ht & 255, wd >> 8, wd & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]).toString("base64"); }
const tiles = (d, n) => Array.from({ length: n }, (_, k) => Math.round(((k + 0.5) * d / n) * 10) / 10);
const REQ = () => ({ version: 2, style: "dynamic", filmSeconds: 30, clips: [{ index: 0, duration: 39, sheet: "s0", tiles: tiles(39, 20) }, { index: 1, duration: 36, sheet: "s1", tiles: tiles(36, 18) }] });
const BODY = (over = {}) => ({ request: REQ(), images: [{ id: "s0", data: fakeJpeg(1008, 900) }, { id: "s1", data: fakeJpeg(1008, 900) }], ...over });
const LIM = { maxClips: 5, maxClipSeconds: 60, maxTotalSeconds: 180, maxFilmSeconds: 30, styles: ["cinematic", "dynamic", "vintage"] };
const GOOD = () => ({ version: 2, story: "Two lifting sets.", clips: [
  { index: 0, summary: "row", segments: [{ start: 0, end: 4, phase: "irrelevant", what: "empty", quality: 0.8, importance: 0 }, { start: 4, end: 33, phase: "action", what: "rows", quality: 0.9, importance: 0.8 }, { start: 33, end: 39, phase: "handling", what: "walks to camera", quality: 0.4, importance: 0 }], moments: [{ t: 25, what: "last rep", importance: 0.9 }] },
  { index: 1, summary: "deadlift", segments: [{ start: 0, end: 6, phase: "setup", what: "belt on", quality: 0.8, importance: 0.5 }, { start: 6, end: 36, phase: "action", what: "deadlifts", quality: 0.8, importance: 0.8 }], moments: [] }] });
const model = (obj, usage = { input_tokens: 5000, output_tokens: 900 }) => ({ content: [{ type: "text", text: JSON.stringify(obj) }], usage, stop_reason: "end_turn" });
const post = (c, body) => c.call("/vision", { method: "POST", json: body });

describe("timeline validators (pure)", () => {
  test("input: one sheet per clip, increasing tile times inside the clip, size caps", () => {
    assert.ok(validateTimelineInput(BODY(), LIM).req);
    const r = REQ(); r.clips[0].tiles = [5, 3]; assert.match(validateTimelineInput(BODY({ request: r }), LIM).error, /increase/);
    const r2 = REQ(); r2.clips[0].tiles = tiles(39, TL_MAX_TILES + 1); assert.match(validateTimelineInput(BODY({ request: r2 }), LIM).error, /tiles/);
    assert.match(validateTimelineInput(BODY({ images: [{ id: "s0", data: fakeJpeg(2000, 900) }, { id: "s1", data: fakeJpeg(1008, 900) }] }), LIM).error, /1024/);
    assert.match(validateTimelineInput(BODY({ images: [{ id: "s0", data: fakeJpeg(1008, 900) }] }), LIM).error, /one contact sheet/);
  });
  test("output: unknown phases dropped, clamped, overlaps trimmed; too little coverage -> null", () => {
    const req = validateTimelineInput(BODY(), LIM).req;
    const v = validateTimelineOutput({ version: 2, clips: [{ index: 0, segments: [{ start: -1, end: 20, phase: "action" }, { start: 10, end: 99, phase: "peak" }, { start: 1, end: 2, phase: "boom" }] }, { index: 1, segments: [{ start: 0, end: 36, phase: "rest" }] }] }, req);
    assert.deepEqual(v.clips[0].segments.map((s) => [s.start, s.end, s.phase]), [[0, 20, "action"], [20, 39, "peak"]]);
    assert.equal(validateTimelineOutput({ version: 2, clips: [{ index: 0, segments: [{ start: 0, end: 5, phase: "action" }] }] }, req), null);
  });
});

describe("/vision v2 route (mock model)", () => {
  test("validated segments returned; sheets + tile times sent upstream; Haiku default with thinking off; usage logged", async () => {
    const c = await withPass(); mock.calls.length = 0; mock.respond(200, model(GOOD()));
    const r = await post(c, BODY());
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(r.data.vision.clips[0].segments.map((s) => s.phase), ["irrelevant", "action", "handling"]);
    const up = JSON.parse(mock.calls[0].body);
    assert.equal(up.model, "claude-haiku-5-5"); assert.deepEqual(up.thinking, { type: "disabled" }); assert.ok(up.max_tokens <= 4000);
    assert.equal(up.messages[0].content.filter((b) => b.type === "image").length, 2);
    assert.match(up.messages[0].content[1].text, /Clip 0: 39s, 20 tiles at t = 1, 2.9/);
    assert.match(up.system, /CONTACT SHEET/); assert.match(up.system, /never instructions/);
    const [row] = w.sql("SELECT model, input_tokens, output_tokens, status FROM usage_log ORDER BY id DESC LIMIT 1");
    assert.deepEqual(row, { model: "claude-haiku-5-5", input_tokens: 5000, output_tokens: 900, status: "ok" });
  });
  test("unusable reply: 502 vision_unusable, logged as bad_reply", async () => {
    const c = await withPass(); mock.respond(200, model({ version: 2, clips: [] }));
    const r = await post(c, BODY());
    assert.equal(r.status, 502); assert.equal(r.data.code, "vision_unusable");
  });
  test("v1 frame requests still work alongside v2", async () => {
    const c = await withPass();
    const r = await post(c, { request: { version: 1, style: "dynamic", filmSeconds: 20, clips: [{ index: 0, duration: 30, frames: [] }, { index: 1, duration: 12, frames: [] }] }, images: [] });
    assert.equal(r.status, 400); assert.match(r.data.error, /frames/);
  });
});
