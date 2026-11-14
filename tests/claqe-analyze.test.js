// Planner/feature tests on synthetic timelines: pure functions, no browser, no network.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const A = require("../claqe-analyze.js");

// Synthetic sample: `look` (0..1) sets brightness/colour distribution; other fields are the measured signals.
function mk(t, o = {}) {
  const look = o.look ?? 0.5, hist = new Array(16).fill(0); hist[Math.min(15, Math.round(look * 15))] = 0.7; hist[Math.min(15, Math.round(look * 15) + 1)] = 0.3;
  return { t, bright: look, contrast: o.contrast ?? 0.2, sharp: o.sharp ?? 0.01, hist, tiny: new Array(576).fill(look * 255), motion: o.motion ?? 0.02, pan: o.pan ?? 0, resid: o.resid ?? 0.01, scene: 0 };
}
const clip = (duration, f) => { const s = []; for (let t = 0.5; t < duration - 0.1; t += 1) s.push(mk(t, f(t))); return { duration, samples: A.linkScenes(s) }; };
const burstAt = (a, b) => (t) => (t >= a && t <= b ? { sharp: 0.03, resid: 0.12, motion: 0.15, look: 0.55 } : { sharp: 0.005, resid: 0.005, motion: 0.01, look: 0.5 });
const overlaps = (p, ci, a, b) => p.plan.some((x) => x.src === ci && x.start < b && x.start + x.duration > a);

test("different footage -> different decisions (action moves, plan follows)", () => {
  const early = A.planFilm([clip(60, burstAt(8, 16)), clip(45, burstAt(8, 14))], "dynamic", 30);
  const late = A.planFilm([clip(60, burstAt(40, 48)), clip(45, burstAt(30, 38))], "dynamic", 30);
  assert.ok(overlaps(early, 0, 8, 16) && overlaps(late, 0, 40, 48), "each plan includes its own action");
  assert.ok(!overlaps(late, 0, 8, 16) || !overlaps(early, 0, 40, 48), "and not the other");
  assert.notDeepEqual(early.plan.map((p) => [p.src, p.start]), late.plan.map((p) => [p.src, p.start]));
});

test("30 s film, shots stay inside their clips, no overlap, whole clip is searched (not the first seconds)", () => {
  const clips = [clip(60, burstAt(50, 58)), clip(30, burstAt(20, 26)), clip(12, () => ({}))];
  for (const style of ["cinematic", "dynamic", "vintage"]) {
    const p = A.planFilm(clips, style, 30);
    assert.ok(Math.abs(p.total - 30) < 0.6, style + " total " + p.total);
    for (const x of p.plan) { assert.ok(x.start >= 0 && x.start + x.duration <= clips[x.src].duration, "inside clip"); assert.ok(x.duration >= 1); }
    for (const x of p.plan) for (const y of p.plan) if (x !== y && x.src === y.src) assert.ok(x.start >= y.start + y.duration || y.start >= x.start + x.duration, "no overlap");
    assert.ok(p.plan.some((x) => x.src === 0 && x.start > 30), style + " reaches late footage");
  }
});

test("styles pace differently: dynamic cuts faster and accelerates; cinematic holds longer", () => {
  const clips = [clip(60, burstAt(10, 20)), clip(60, burstAt(30, 40)), clip(40, burstAt(5, 12))];
  const d = A.planFilm(clips, "dynamic", 30), c = A.planFilm(clips, "cinematic", 30), v = A.planFilm(clips, "vintage", 30);
  assert.ok(d.plan.length > v.plan.length && v.plan.length >= c.plan.length, [d, v, c].map((x) => x.plan.length).join("/"));
  const avg = (p) => p.total / p.plan.length; assert.ok(avg(d) < 3 && avg(c) > 4);
  assert.ok(A.shotLengths("dynamic", 30)[0] > A.shotLengths("dynamic", 30)[4], "dynamic accelerates");
  assert.notDeepEqual(d.plan.map((p) => p.duration), c.plan.map((p) => p.duration));
});

test("quality is not just brightness/sharpness: a sharp bright static spot loses to real subject motion in dynamic style", () => {
  const f = (t) => (t >= 5 && t <= 12 ? { look: 0.5, sharp: 0.04, resid: 0.003, motion: 0.005 } : t >= 30 && t <= 37 ? { look: 0.42, sharp: 0.012, resid: 0.15, motion: 0.18 } : { look: 0.5, sharp: 0.008, resid: 0.01, motion: 0.02 });
  const p = A.planFilm([clip(50, f), clip(20, () => ({}))], "dynamic", 12);
  assert.ok(overlaps(p, 0, 30, 37), "motion moment chosen");
});

test("windows never straddle a detected scene cut, and shaky/blurred frames are avoided", () => {
  const c = clip(40, (t) => (t < 20 ? { look: 0.2 } : { look: 0.8 }));
  assert.ok(c.samples.some((s) => s.scene > A.SCENE_T), "cut detected");
  for (const r of A.findRanges(A.scoreClip(c, "cinematic"), "cinematic", 5)) assert.ok(!(r.start < 19.9 && r.start + r.duration > 20.1), "window at " + r.start + " straddles cut");
  const shaky = clip(40, (t) => (t >= 10 && t <= 20 ? { pan: 4, resid: 0.2, motion: 0.3, sharp: 0.0005 } : { sharp: 0.01 }));
  assert.ok(!overlaps(A.planFilm([shaky, clip(40, () => ({}))], "cinematic", 15), 0, 11, 19), "shaky stretch avoided");
});

test("too little footage -> shorter honest film; unknown style -> safe default; deterministic", () => {
  const short = A.planFilm([clip(6, () => ({})), clip(5, () => ({}))], "dynamic", 30);
  assert.ok(short.total <= 10.8 && short.total >= 6, "total " + short.total);
  assert.equal(A.planFilm([clip(30, () => ({})), clip(30, () => ({}))], "nope", 20).style, "cinematic");
  const clips = () => [clip(60, burstAt(10, 20)), clip(45, burstAt(25, 30))];
  assert.deepEqual(A.planFilm(clips(), "vintage", 30), A.planFilm(clips(), "vintage", 30));
});

test("frame features: sharpness, exposure, pan vs subject motion", () => {
  const W = A.W, H = A.H, flat = new Uint8Array(W * H).fill(128), noise = Uint8Array.from({ length: W * H }, (_, i) => (i * 7919) % 256);
  assert.ok(A.stats(noise).sharp > A.stats(flat).sharp * 100 + 0.01); assert.ok(Math.abs(A.stats(flat).bright - 0.5) < 0.01);
  const shifted = new Uint8Array(W * H); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) shifted[y * W + x] = noise[y * W + Math.min(W - 1, x + 3)];
  const pan = A.pairMotion(noise, shifted); assert.ok(pan.pan >= 2.5 && pan.resid < pan.mad / 2, JSON.stringify(pan));      // camera move: aligns away
  const other = Uint8Array.from({ length: W * H }, (_, i) => (i * 104729) % 256), chaos = A.pairMotion(noise, other);
  assert.ok(chaos.resid > 0.1, JSON.stringify(chaos));                                                                       // unrelated frames: residual stays high
});
