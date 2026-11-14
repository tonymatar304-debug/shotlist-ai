// Vision contract tests: mock responses only. No network, no paid API.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const A = require("../claqe-analyze.js"), V = require("../claqe-vision.js"), { createClient } = require("../claqe-api.js");

function mk(t, o = {}) { const look = o.look ?? 0.5, hist = new Array(16).fill(0); hist[Math.round(look * 15)] = 1; return { t, bright: o.bright ?? look, contrast: 0.2, sharp: o.sharp ?? 0.01, hist, tiny: new Array(576).fill(look * 255), motion: o.motion ?? 0.03, pan: 0, resid: o.resid ?? 0.02, scene: 0 }; }
const clip = (d, f = () => ({})) => { const s = []; for (let t = 0.5; t < d - 0.1; t += 1) s.push(mk(t, f(t))); return { duration: d, samples: A.linkScenes(s) }; };
const setup = (cs = [clip(40), clip(30)], style = "cinematic") => { cs.forEach((c) => A.scoreClip(c, style)); return { cs, req: V.buildVisionRequest(cs, { style, filmSeconds: 12 }) }; };
const covers = (p, ci, a, b) => p.plan.some((x) => x.src === ci && x.start < b && x.start + x.duration > a);

test("frame choice: <= 12, >= 2 per clip, timestamps inside clips, varied, skips black frames, deterministic", () => {
  const dark = clip(30, (t) => (t < 6 ? { bright: 0.01, look: 0.02 } : { look: 0.3 + (t % 7) / 14 }));
  const { cs, req } = setup([clip(60, (t) => ({ look: 0.2 + (t % 11) / 14 })), dark, clip(20), clip(45), clip(10)]);
  const ids = V.frameIds(req); assert.ok(ids.length <= 12 && ids.length >= 10, "frames " + ids.length);
  for (const c of req.clips) { assert.ok(c.frames.length >= 2, "clip " + c.index); c.frames.forEach((f, i, a) => { assert.ok(f.t > 0 && f.t < c.duration); if (i) assert.ok(f.t - a[i - 1].t >= 2 - 1e-9); }); }
  assert.ok(req.clips[1].frames.every((f) => f.t > 6), "no frame from the black opening");
  assert.ok(new Set(req.clips[0].frames.map((f) => Math.round(f.t / 10))).size >= 3, "spread across a 60 s clip, not clustered");
  assert.deepEqual(req, V.buildVisionRequest(cs, { style: "cinematic", filmSeconds: 12 }));
  assert.ok(JSON.stringify(req).length < 3000); assert.deepEqual(Object.keys(req.clips[0].frames[0]).sort(), ["id", "local", "t"]);
});

test("validation: unknown ids, wrong timestamps, junk values, markup, duplicates and mostly-bad replies", () => {
  const { req } = setup(), good = V.mockVision(req), ids = V.frameIds(req);
  for (const bad of [null, "x", { version: 2, frames: [] }, { version: 1, frames: [{ id: "zzz", t: 1, importance: 1 }] }]) assert.equal(V.validateVisionResponse(bad, req), null);
  const nasty = { ...good, frames: good.frames.map((f, i) => (i === 0 ? { ...f, importance: 9, subject: "<b>x</b>" + "x".repeat(500), shotType: "bogus", role: "ruler" } : i === 1 ? { ...f, t: f.t + 5 } : i === 2 ? { ...f, id: ids[0] } : f)).concat([{ id: "evil", t: 1, importance: 1 }]) };
  const v = V.validateVisionResponse(nasty, req);
  assert.equal(v.frames[0].importance, 1); assert.ok(v.frames[0].subject.length <= 60 && !/[<>]/.test(v.frames[0].subject)); assert.equal(v.frames[0].shotType, "other"); assert.equal(v.frames[0].role, "filler");
  assert.ok(!v.frames.some((f) => f.id === ids[1]), "unsupported timestamp rejected"); assert.equal(v.frames.length, ids.length - 2);
});

test("client and Worker validators agree on the same replies (contract parity)", async () => {
  const W = await import("../shotlist-api-dev/src/vision.js"), { req } = setup(), good = V.mockVision(req);
  const cases = [good, { ...good, frames: good.frames.map((f, i) => (i % 2 ? { ...f, t: f.t + 1 } : f)) }, { ...good, frames: good.frames.slice(0, 2) }, { ...good, frames: good.frames.map((f) => ({ ...f, importance: 5, confidence: -3, subject: "<a>" + f.subject })) }, "nope", { version: 1, frames: "x" }];
  for (const c of cases) assert.deepEqual(V.validateVisionResponse(c, req), W.validateVisionOutput(c, req));
});

test("semantic plans: avoid and highlight are honoured, plan stays valid for the renderer, and it moves with the footage", () => {
  const base = (() => { const { cs } = setup(); return A.planFilm(cs, "cinematic", 12); })();
  const { cs, req } = setup(), fr = req.clips[0].frames, hl = fr[fr.length - 1], bad = fr.find((f) => covers(base, 0, f.t - 0.1, f.t + 0.1)) || fr[0];
  const resp = V.validateVisionResponse(V.mockVision(req, { [hl.id]: { importance: 1, role: "highlight", subject: "dog", action: "standing in a field" }, [bad.id]: { role: "avoid", shotType: "title", importance: 0 } }), req);
  V.applyVision(cs, req, resp); const p = A.planFilm(cs, "cinematic", 12);
  assert.ok(covers(p, 0, hl.t - 1.5, hl.t + 1.5)); assert.ok(p.plan.some((x) => x.reason === "dog – standing in a field"));
  if (bad.id !== hl.id) assert.ok(!covers(p, 0, bad.t - 0.4, bad.t + 0.4));
  assert.ok(Math.abs(p.total - 12) < 0.6 && p.plan.every((x) => Number.isFinite(x.start) && x.duration >= 1 && x.start >= 0 && x.start + x.duration <= cs[x.src].duration));
  assert.notDeepEqual(p.plan.map((x) => [x.src, x.start]), base.plan.map((x) => [x.src, x.start]));
  const other = setup([clip(40, (t) => ({ look: 0.7 - (t % 5) / 20, resid: t > 25 ? 0.12 : 0.01, motion: t > 25 ? 0.2 : 0.01 })), clip(30)]);
  V.applyVision(other.cs, other.req, V.validateVisionResponse(V.mockVision(other.req, {}), other.req));
  assert.notDeepEqual(A.planFilm(other.cs, "dynamic", 12).plan.map((x) => [x.src, x.start]), A.planFilm(cs, "dynamic", 12).plan.map((x) => [x.src, x.start]));
});

test("honesty: low-confidence observations give no caption and little influence; nothing is invented", () => {
  const { cs, req } = setup(), f0 = req.clips[0].frames[0];
  const v = V.validateVisionResponse(V.mockVision(req, { [f0.id]: { confidence: 0.2, subject: "a wolf", action: "attacking", importance: 1, role: "highlight" } }), req);
  V.applyVision(cs, req, v);
  const near = cs[0].samples.filter((s) => s.sem && Math.abs(s.t - f0.t) < 1);
  assert.ok(near.length && near.every((s) => s.sem.caption === "" && s.sem.w <= 0.55), "no caption, weak weight at confidence 0.2");
  const p = A.planFilm(cs, "cinematic", 12); assert.ok(!p.plan.some((x) => /wolf|attack/.test(x.reason)), "unsure claims never reach the UI");
});

test("semantic influence is local: no leak across a scene cut or beyond 2.5 s", () => {
  const c = clip(40); c.samples.forEach((s) => { if (s.t > 20) { s.hist = new Array(16).fill(0); s.hist[3] = 1; s.tiny = new Array(576).fill(40); } }); A.linkScenes(c.samples); A.scoreClip(c, "dynamic");
  const req = { version: 1, clips: [{ index: 0, duration: 40, frames: [{ id: "c0f0", t: 19.5, local: 0.5 }] }] };
  V.applyVision([c], req, { version: 1, frames: [{ id: "c0f0", t: 19.5, importance: 1, confidence: 1, role: "highlight", usable: true, shotType: "medium", subject: "", action: "" }] });
  assert.ok(c.samples.some((s) => s.t > 17.5 && s.t < 19.6 && s.sem)); assert.ok(!c.samples.some((s) => s.t > 20 && s.sem)); assert.ok(!c.samples.some((s) => s.t < 16.9 && s.sem));
});

test("client vision(): posts request+images with credentials; errors never yield a vision", async () => {
  const calls = []; const f = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ ok: true, vision: { version: 1, frames: [] } }) }; };
  const c = createClient({ baseUrl: "http://127.0.0.1:8787", fetch: f }), r = await c.vision({ request: { version: 1 }, images: [{ id: "c0f0", data: "AAA" }] });
  assert.equal(r.ok, true); assert.equal(calls[0].url, "http://127.0.0.1:8787/vision"); assert.equal(calls[0].init.credentials, "include");
  assert.deepEqual(JSON.parse(calls[0].init.body), { request: { version: 1 }, images: [{ id: "c0f0", data: "AAA" }] });
  const bad = await createClient({ baseUrl: "http://127.0.0.1:8787", fetch: async () => ({ ok: false, status: 502, json: async () => ({ ok: false, code: "vision_unusable" }) }) }).vision({ request: {}, images: [] });
  assert.equal(bad.ok, false); assert.equal(bad.code, "vision_unusable"); assert.equal(bad.vision, undefined);
});
