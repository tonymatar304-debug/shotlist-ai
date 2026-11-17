// Footage-aware grading: shot measurement, conservative matching limits, style looks, FFmpeg filter text.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const L = require("../claqe-look.js");

const sample = (t, y, rgb, sat, c = 0.2) => ({ t, bright: y, contrast: c, sharp: 0.01, rgb, sat });
const shot = (y, rgb, sat = 0.2, c = 0.2) => ({ y, c, r: rgb[0], g: rgb[1], b: rgb[2], sat, flat: false });

test("shotStats averages only the samples inside the shot; falls back to the nearest; null without colour data", () => {
  const S = [sample(0.5, 0.2, [0.2, 0.2, 0.2], 0.1), sample(1.5, 0.4, [0.5, 0.4, 0.3], 0.2), sample(2.5, 0.6, [0.6, 0.6, 0.6], 0.3)];
  const a = L.shotStats(S, 1, 2);
  assert.ok(Math.abs(a.y - 0.5) < 1e-9 && Math.abs(a.r - 0.55) < 1e-9 && Math.abs(a.sat - 0.25) < 1e-9);
  assert.equal(L.shotStats(S, 0.8, 0.3).y, 0.2, "nearest sample to the shot middle");
  assert.equal(L.shotStats([{ t: 1, bright: 0.5, contrast: 0.2 }], 0, 2), null);
});

test("matching: identical shots get the plain style look; a single known shot is not matched", () => {
  const s = shot(0.45, [0.45, 0.45, 0.45]);
  for (const style of ["cinematic", "dynamic", "vintage"]) {
    const looks = L.matchLooks([s, s, s], style), st = L.STYLES[style];
    looks.forEach((l) => { assert.equal(l.contrast, st.contrast); assert.equal(l.saturation, st.saturation); assert.equal(l.gamma, st.gamma); });
    assert.deepEqual(L.matchLooks([s, null], style)[0].gamma, st.gamma);
  }
});

test("matching moves only badly exposed shots part-way toward the normal band, within limits", () => {
  const looks = L.matchLooks([shot(0.06, [0.06, 0.06, 0.06]), shot(0.45, [0.45, 0.45, 0.45]), shot(0.5, [0.5, 0.5, 0.5]), shot(0.85, [0.85, 0.85, 0.85])], "dynamic");
  const g = looks.map((l) => l.gamma);
  assert.ok(g[0] > 1.05 && g[0] <= L.LIMIT.gamma[1] + 1e-9, "dark shot brightened " + g[0]);
  assert.ok(g[3] < 0.95 && g[3] >= L.LIMIT.gamma[0] - 1e-9, "bright shot darkened " + g[3]);
  // Part-way, not all the way: resulting means stay apart (shots keep their own character).
  const out = [0.06, 0.85].map((y, i) => Math.pow(y, 1 / g[i * 3]));
  assert.ok(out[0] < out[1] - 0.15, "not flattened: " + out.map((x) => x.toFixed(2)));
  assert.ok(g[1] === 1 && g[2] === 1, "well exposed shots untouched: " + g);
  // gym regression: a well exposed bright shot next to dark ones is no longer pulled darker
  const gym = L.matchLooks([shot(0.15, [0.15, 0.15, 0.17]), shot(0.17, [0.17, 0.17, 0.19]), shot(0.36, [0.37, 0.35, 0.33])], "cinematic");
  assert.ok(gym[2].gamma >= 1, "bright shot kept " + gym[2].gamma);
});

test("tone curve: ends pinned (no crushed blacks or clipped whites), restrained, monotonic, and off for dark shots", () => {
  const f = (c, v) => { const x = Math.min(1, Math.max(0, (v - 16) / 219)); return 16 + 219 * Math.min(1, Math.max(0, x + (c.s || 0) * x * (1 - x) * (2 * x - 1) + (c.toe || 0) * (1 - x) ** 4 - (c.shoulder || 0) * 0.25 * Math.max(0, (x - 0.75) / 0.25) ** 2)); };
  for (const style of ["cinematic", "dynamic", "vintage"]) {
    const c = L.STYLES[style].curve;
    assert.ok(f(c, 16) >= 16 && f(c, 16) <= 16 + 219 * 0.05, style + " black " + f(c, 16));
    assert.ok(f(c, 235) <= 235 && f(c, 235) >= 235 - 219 * 0.03, style + " white " + f(c, 235));
    for (let v = 16; v <= 235; v += 4) assert.ok(Math.abs(f(c, v) - v) <= 219 * 0.045, style + " moves " + v + " by " + (f(c, v) - v).toFixed(1));
    for (let v = 16; v < 235; v++) assert.ok(f(c, v + 1) >= f(c, v), style + " monotonic at " + v);
  }
  const dark = L.matchLooks([shot(0.14, [0.14, 0.14, 0.14]), shot(0.5, [0.5, 0.5, 0.5])], "dynamic");
  assert.equal(dark[0].curve.s, 0, "no S-curve on a dark shot"); assert.equal(dark[1].curve.s, L.STYLES.dynamic.curve.s);
  assert.match(L.curveExpr(L.STYLES.dynamic.curve), /^lutyuv=y='st\(0,clip\(\(val-16\)\/219,0,1\)\);16\+219\*clip\(.+,0,1\)'$/);
});

test("colour cast: a warm shot is cooled relative to the film, capped; colourful shots are left alone", () => {
  const n = shot(0.45, [0.45, 0.45, 0.45]), warm = shot(0.45, [0.6, 0.45, 0.3], 0.2), vivid = shot(0.45, [0.6, 0.45, 0.3], 0.45);
  const [, , w] = L.matchLooks([n, n, warm], "dynamic");
  // white balance as channel gains (FFmpeg 5.1 colorbalance midtones are a no-op), capped at LIMIT.cast of the channel mean
  assert.ok(w.gain.r < 1 && w.gain.b > 1, JSON.stringify(w.gain));
  assert.ok(Math.abs((w.gain.r - 1) * 0.6) <= L.LIMIT.cast + 1e-3 && Math.abs((w.gain.b - 1) * 0.3) <= L.LIMIT.cast + 1e-3);
  assert.match(L.lookFilter(w), /colorchannelmixer=rr=0\.\d+:bb=1\.\d+/);
  assert.ok(!/colorbalance=[^,]*\b[rgb]m=/.test(["cinematic", "dynamic", "vintage"].map((st) => L.lookFilter(L.matchLooks([null], st)[0])).join()), "no midtone colorbalance terms");
  const [, , v] = L.matchLooks([n, n, vivid], "dynamic");
  assert.deepEqual(v.gain, { r: 1, b: 1 }, "vivid shot keeps its colour");
  assert.ok(v.saturation <= 1.0001, "vivid shot never saturated further: " + v.saturation);
});

test("contrast: matched only when shots have real tonal range", () => {
  const lo = L.matchLooks([shot(0.4, [0.4, 0.4, 0.4], 0.2, 0.01), shot(0.4, [0.4, 0.4, 0.4], 0.2, 0.015)], "dynamic");
  lo.forEach((l) => assert.equal(l.contrast, L.STYLES.dynamic.contrast));
  const hi = L.matchLooks([shot(0.4, [0.4, 0.4, 0.4], 0.2, 0.1), shot(0.4, [0.4, 0.4, 0.4], 0.2, 0.2), shot(0.4, [0.4, 0.4, 0.4], 0.2, 0.3)], "dynamic");
  // only ever raised (eq contrast < 1 lifts black): the flattest shot gains a little, the punchiest is left alone
  assert.ok(hi[0].contrast > L.STYLES.dynamic.contrast && hi[2].contrast === L.STYLES.dynamic.contrast && hi[1].contrast === L.STYLES.dynamic.contrast);
  // a deliberately low-key shot (mean 0.16) is not lifted toward the others
  assert.equal(L.matchLooks([shot(0.16, [0.16, 0.16, 0.18]), shot(0.4, [0.4, 0.4, 0.4]), shot(0.45, [0.45, 0.45, 0.45])], "cinematic")[0].gamma, 1);
});

test("flat frames (titles, solid colours) and unknown shots get only the style look", () => {
  const flat = { ...shot(0.1, [0.9, 0.1, 0.1], 0.8, 0), flat: true };
  const looks = L.matchLooks([flat, shot(0.5, [0.5, 0.5, 0.5]), shot(0.3, [0.3, 0.3, 0.3]), null], "vintage");
  for (const i of [0, 3]) assert.deepEqual(looks[i], L.matchLooks([null], "vintage")[0]);
});

test("lookFilter: eq always; RGB steps only when needed, with explicit BT.709 matrices; looks differ by style", () => {
  const f = L.lookFilter({ contrast: 1.1, saturation: 1, gamma: 1, balance: {} });
  assert.equal(f, "eq=contrast=1.1:saturation=1:gamma=1");
  const c = L.lookFilter(L.matchLooks([null], "cinematic")[0]);
  assert.match(c, /^eq=contrast=1:saturation=0\.94:gamma=1,lutyuv=y='.+',scale=in_color_matrix=bt709:in_range=tv,format=gbrp,colorbalance=rh=0\.01:bh=-0\.01,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p$/);
  assert.doesNotMatch(c, /bs=|rs=/, "no teal/orange split tone");
  assert.match(L.lookFilter(L.matchLooks([null], "dynamic")[0]), /vibrance=intensity=0\.12/);
  const all = ["cinematic", "dynamic", "vintage"].map((s) => L.lookFilter(L.matchLooks([null], s)[0]));
  assert.equal(new Set(all).size, 3);
});
