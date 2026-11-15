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

test("matching pulls a dark and a bright shot part-way toward the film, within limits", () => {
  const looks = L.matchLooks([shot(0.2, [0.2, 0.2, 0.2]), shot(0.45, [0.45, 0.45, 0.45]), shot(0.5, [0.5, 0.5, 0.5]), shot(0.75, [0.75, 0.75, 0.75])], "dynamic");
  const g = looks.map((l) => l.gamma);
  assert.ok(g[0] > 1.1 && g[0] <= L.LIMIT.gamma[1] + 1e-9, "dark shot brightened " + g[0]);
  assert.ok(g[3] < 0.95 && g[3] >= L.LIMIT.gamma[0] - 1e-9, "bright shot darkened " + g[3]);
  // Part-way, not all the way: resulting means stay apart (shots keep their own character).
  const out = [0.2, 0.75].map((y, i) => Math.pow(y, 1 / g[i * 3]));
  assert.ok(out[0] < out[1] - 0.15, "not flattened: " + out.map((x) => x.toFixed(2)));
});

test("colour cast: a warm shot is cooled relative to the film, capped; colourful shots are left alone", () => {
  const n = shot(0.45, [0.45, 0.45, 0.45]), warm = shot(0.45, [0.6, 0.45, 0.3], 0.2), vivid = shot(0.45, [0.6, 0.45, 0.3], 0.45);
  const [, , w] = L.matchLooks([n, n, warm], "dynamic");
  assert.ok(w.balance.rm < 0 && w.balance.bm > 0, JSON.stringify(w.balance));
  assert.ok(Math.abs(w.balance.rm) <= L.LIMIT.cast + 1e-9 && Math.abs(w.balance.bm - (L.STYLES.dynamic.balance.bm || 0)) <= L.LIMIT.cast + 1e-9);
  const [, , v] = L.matchLooks([n, n, vivid], "dynamic");
  assert.equal(v.balance.rm, undefined, "vivid shot keeps its colour");
  assert.ok(v.saturation <= 1.0001, "vivid shot never saturated further: " + v.saturation);
});

test("contrast: matched only when shots have real tonal range", () => {
  const lo = L.matchLooks([shot(0.4, [0.4, 0.4, 0.4], 0.2, 0.01), shot(0.4, [0.4, 0.4, 0.4], 0.2, 0.015)], "dynamic");
  lo.forEach((l) => assert.equal(l.contrast, L.STYLES.dynamic.contrast));
  const hi = L.matchLooks([shot(0.4, [0.4, 0.4, 0.4], 0.2, 0.1), shot(0.4, [0.4, 0.4, 0.4], 0.2, 0.2), shot(0.4, [0.4, 0.4, 0.4], 0.2, 0.3)], "dynamic");
  assert.ok(hi[0].contrast > L.STYLES.dynamic.contrast && hi[2].contrast < L.STYLES.dynamic.contrast && hi[1].contrast === L.STYLES.dynamic.contrast);
});

test("flat frames (titles, solid colours) and unknown shots get only the style look", () => {
  const flat = { ...shot(0.1, [0.9, 0.1, 0.1], 0.8, 0), flat: true };
  const looks = L.matchLooks([flat, shot(0.5, [0.5, 0.5, 0.5]), shot(0.3, [0.3, 0.3, 0.3]), null], "vintage");
  for (const i of [0, 3]) assert.deepEqual(looks[i], L.matchLooks([null], "vintage")[0]);
});

test("lookFilter: eq always, colorbalance only when needed; looks differ by style", () => {
  const f = L.lookFilter({ contrast: 1.1, saturation: 1, gamma: 1, balance: {} });
  assert.equal(f, "eq=contrast=1.1:saturation=1:gamma=1");
  const c = L.lookFilter(L.matchLooks([null], "cinematic")[0]);
  assert.match(c, /^eq=contrast=1\.06:saturation=0\.92:gamma=0\.98,colorbalance=rs=-0\.02:bs=0\.04:rh=0\.03:bh=-0\.03$/);
  const all = ["cinematic", "dynamic", "vintage"].map((s) => L.lookFilter(L.matchLooks([null], s)[0]));
  assert.equal(new Set(all).size, 3);
});
