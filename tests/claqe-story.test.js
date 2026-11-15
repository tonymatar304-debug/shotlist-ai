// Story-aware ordering with MOCKED AI observations (no network, no paid API).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const A = require("../claqe-analyze.js"), V = require("../claqe-vision.js");

function mk(t, look) { const hist = new Array(16).fill(0); hist[Math.round(look * 15)] = 1; return { t, bright: 0.5, contrast: 0.2, sharp: 0.01 + (t % 3) * 0.002, hist, tiny: new Array(576).fill(look * 255), motion: 0.03, pan: 0, resid: 0.02 + (t % 4) * 0.005, scene: 0 }; }
const clip = (d, look = 0.5) => { const s = []; for (let t = 0.5; t < d - 0.1; t += 1) s.push(mk(t, look)); return { duration: d, samples: A.linkScenes(s) }; };
const clips = () => [clip(20, 0.3), clip(20, 0.5), clip(20, 0.7)];
// obs: { "ci@t": {role, importance, confidence, ...} } -> validated reply applied to the clips
function withObs(cs, obs) {
  const req = { version: 1, style: "cinematic", filmSeconds: 30, clips: cs.map((c, ci) => ({ index: ci, duration: c.duration, frames: [] })) };
  Object.keys(obs).forEach((k, n) => { const [ci, t] = k.split("@").map(Number); req.clips[ci].frames.push({ id: "c" + ci + "f" + n, t, local: 0.5 }); });
  const frames = Object.entries(obs).map(([k, o], n) => { const [ci, t] = k.split("@").map(Number); return { id: "c" + ci + "f" + n, t, importance: 0.8, confidence: 0.9, subject: "s", action: "a", shotType: "medium", usable: true, role: "filler", ...o }; });
  const v = V.validateVisionResponse({ version: 1, frames }, req); assert.ok(v, "mock reply valid");
  V.applyVision(cs, req, v); return cs;
}
const plan = (cs, style) => A.planFilm(cs, style, 30);
const clipSeq = (p) => p.plan.map((x) => x.src).filter((s, i, a) => i === 0 || a[i - 1] !== s).join("");
function valid(p, cs, min = 25) {
  assert.ok(p.total <= 30.5 && p.total >= min, "total " + p.total);
  for (const x of p.plan) { assert.ok(x.duration >= 1 && x.start >= 0 && x.start + x.duration <= cs[x.src].duration + 1e-9); for (const r of A.sceneRanges(cs[x.src])) assert.ok(!(x.start < r.end - 0.2 && x.start + x.duration > r.end + 0.2 && r.end < cs[x.src].duration), "crosses cut"); }
  for (const x of p.plan) for (const y of p.plan) if (x !== y && x.src === y.src) assert.ok(x.start >= y.start + y.duration - 1e-9 || y.start >= x.start + x.duration - 1e-9, "overlap");
}
const chronological = (p, ci) => { const s = p.plan.filter((x) => x.src === ci).map((x) => x.start); return s.every((t, i) => !i || t > s[i - 1]); };

test("no observations: exactly the local plan for every style (fallback)", () => {
  for (const style of ["cinematic", "dynamic", "vintage"]) {
    const p = plan(clips(), style); assert.equal(p.semantic, false); assert.ok(p.plan.every((x) => x.role === undefined)); valid(p, clips());
  }
  assert.equal(clipSeq(plan(clips(), "cinematic")), "012");
});

test("cinematic arc: AI opener clip first, highlight builds, closer clip last (not upload order)", () => {
  const cs = withObs(clips(), { "2@5.5": { role: "opener", importance: 0.9 }, "1@8.5": { role: "highlight", importance: 0.95 }, "0@10.5": { role: "closer", importance: 0.85 } });
  const p = plan(cs, "cinematic"); valid(p, cs);
  assert.equal(p.semantic, true); assert.equal(clipSeq(p), "210");
  assert.equal(p.plan[0].src, 2); assert.equal(p.plan[p.plan.length - 1].src, 0);
  assert.ok(p.plan.some((x) => x.role === "highlight" && x.src === 1));
});

test("a progression (bud -> open -> bloom) stays chronological in every style; its bloom closes when it can", () => {
  const obs = { "1@1.5": { role: "opener", importance: 0.7, subject: "bud" }, "1@9.5": { role: "highlight", importance: 0.8 }, "1@17.5": { role: "closer", importance: 0.9, subject: "bloom" } };
  assert.equal(A.clipStory(withObs(clips(), obs)[1]).progression, true);
  for (const style of ["cinematic", "dynamic", "vintage"]) {
    const cs = withObs(clips(), obs), p = plan(cs, style); valid(p, cs);
    assert.ok(chronological(p, 1), style + ": bloom clip out of order " + JSON.stringify(p.plan.filter((x) => x.src === 1)));
    if (style !== "vintage") { assert.equal(p.plan[0].src, 1, style + " opens on the bud"); assert.equal(p.plan[p.plan.length - 1].src, 1, style + " ends on the bloom"); }
  }
});

test("styles stay different with the same observations (pacing and order)", () => {
  const obs = { "2@5.5": { role: "opener" }, "0@12.5": { role: "highlight", importance: 0.95 }, "1@15.5": { role: "closer" } };
  const [c, d, v] = ["cinematic", "dynamic", "vintage"].map((s) => plan(withObs(clips(), obs), s));
  assert.ok(d.plan.length > v.plan.length && v.plan.length >= c.plan.length);
  assert.notEqual(clipSeq(c), clipSeq(d)); assert.ok(clipSeq(d).length > clipSeq(c).length, "dynamic intercuts clips");
  assert.equal(d.plan[0].src, 2, "dynamic hook = opener"); assert.equal(d.plan[d.plan.length - 1].src, 1, "dynamic lands on closer");
});

test("vintage ignores weak labels that cinematic still uses", () => {
  const weak = { "2@5.5": { role: "opener", importance: 0.6, confidence: 0.55 }, "0@10.5": { role: "closer", importance: 0.6, confidence: 0.55 } };
  assert.equal(clipSeq(plan(withObs(clips(), weak), "vintage")), "012", "vintage keeps upload order");
  assert.equal(plan(withObs(clips(), weak), "cinematic").plan[0].src, 2, "cinematic still opens on the weakly labelled opener");
});

test("unreliable or contradictory observations fall back to the local order", () => {
  const low = plan(withObs(clips(), { "2@5.5": { role: "opener", confidence: 0.3 }, "0@10.5": { role: "closer", confidence: 0.3 } }), "cinematic");
  assert.equal(low.semantic, false); assert.equal(clipSeq(low), "012");
  const cs = withObs(clips(), { "1@2.5": { role: "closer" }, "1@15.5": { role: "opener" } }); // closer BEFORE opener in the same clip
  assert.equal(A.clipStory(cs[1]).conflict, true);
  const p = plan(cs, "cinematic"); assert.equal(p.semantic, false); assert.equal(clipSeq(p), "012"); assert.ok(chronological(p, 1));
});

test("one bad frame does not discard its clip: only that moment is avoided", () => {
  const cs = withObs(clips(), { "0@10.5": { role: "avoid", shotType: "title", importance: 0 } });
  for (const style of ["cinematic", "dynamic", "vintage"]) {
    const p = plan(cs, style); valid(p, cs);
    assert.ok(!p.plan.some((x) => x.src === 0 && x.start < 10.5 && x.start + x.duration > 10.5), style + " uses the title card");
    assert.ok(p.plan.filter((x) => x.src === 0).reduce((t, x) => t + x.duration, 0) >= 4, style + " still uses the rest of clip 0");
  }
});

test("deterministic for the same footage and observations", () => {
  const obs = { "2@5.5": { role: "opener" }, "1@8.5": { role: "highlight" }, "0@10.5": { role: "closer" } };
  for (const style of ["cinematic", "dynamic", "vintage"]) assert.deepEqual(plan(withObs(clips(), obs), style), plan(withObs(clips(), obs), style));
});

test("short clip holding both opener and closer gives two shots: the film opens on the bud and ends on the bloom", () => {
  const short = () => { const c = clip(5.1, 0.6); return c; };
  for (const style of ["cinematic", "dynamic"]) {
    const cs = withObs([clip(20, 0.3), clip(10, 0.5), short()], { "2@2.5": { role: "opener", importance: 0.7 }, "2@4.5": { role: "closer", importance: 0.8 }, "1@4.5": { role: "highlight", importance: 0.85 } });
    const p = plan(cs, style); valid(p, cs, 20); // 35 s of footage: dynamic reaches ~21 s even without AI (0.5 s gaps)
    const flower = p.plan.filter((x) => x.src === 2);
    assert.ok(flower.length >= 2, style + ": bud and bloom are separate shots " + JSON.stringify(flower));
    assert.equal(p.plan[0].src, 2, style + " opens on the bud"); assert.ok(p.plan[0].start <= 2.5 && p.plan[0].start + p.plan[0].duration >= 2.5);
    const last = p.plan[p.plan.length - 1]; assert.equal(last.src, 2, style + " ends on the bloom"); assert.ok(last.start <= 4.5 && last.start + last.duration >= 4.5);
    assert.ok(chronological(p, 2));
  }
});
