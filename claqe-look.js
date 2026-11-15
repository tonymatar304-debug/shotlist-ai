/* CLAQE footage-aware grading. Pure functions (Node tests + browser window.ClaqeLook), no network.
 * 1) Measure each shot from the analysis samples it covers (luma, contrast, mean RGB, saturation).
 * 2) Match: pull each shot part-way toward the film's median exposure / contrast / saturation / colour cast,
 *    with tight limits, so shots sit together without all looking identical.
 * 3) Style look on top (same for every shot): gentle contrast/saturation plus a split-tone via colorbalance.
 * Costs one eq (YUV) and at most one colorbalance (RGB) per shot at output size (360x640). */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ClaqeLook = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const median = (a) => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const r3 = (x) => Math.round(x * 1000) / 1000;

  // Style looks. Midtones are left alone (that is where skin sits); colour goes into shadows/highlights only.
  const STYLES = {
    cinematic: { contrast: 1.06, saturation: 0.92, gamma: 0.98, balance: { rs: -0.02, bs: 0.04, rh: 0.03, bh: -0.03 } },
    dynamic: { contrast: 1.1, saturation: 1.08, gamma: 1, balance: { rh: 0.015, bs: 0.015 } },
    vintage: { contrast: 0.94, saturation: 0.8, gamma: 1.03, balance: { rs: 0.03, gs: 0.01, bs: -0.02, rh: 0.03, bh: -0.05 } },
  };
  const LIMIT = { gamma: [0.82, 1.22], contrast: [0.92, 1.1], saturation: [0.9, 1.12], cast: 0.035 };
  const STRENGTH = { exposure: 0.6, contrast: 0.5, saturation: 0.4, cast: 0.5 };
  const MID_WEIGHT = 0.7; // colorbalance midtone weight at mid grey: a midtone value v moves a channel by about 0.7*v

  // Shot statistics from the samples inside [start, start+duration] (nearest sample if none). null without colour data.
  function shotStats(samples, start, duration) {
    const ok = (samples || []).filter((s) => s && s.rgb);
    if (!ok.length) return null;
    let use = ok.filter((s) => s.t >= start - 0.05 && s.t <= start + duration + 0.05);
    if (!use.length) use = [ok.reduce((b, s) => (Math.abs(s.t - start - duration / 2) < Math.abs(b.t - start - duration / 2) ? s : b))];
    const avg = (f) => use.reduce((a, s) => a + f(s), 0) / use.length;
    return { y: avg((s) => s.bright), c: avg((s) => s.contrast), r: avg((s) => s.rgb[0]), g: avg((s) => s.rgb[1]), b: avg((s) => s.rgb[2]), sat: avg((s) => s.sat),
      flat: use.every((s) => s.contrast < 0.02 && s.sharp < 1e-6) };
  }

  // One look per shot. stats[i] may be null (unknown shot: style look only).
  function matchLooks(stats, style) {
    const st = STYLES[style] || STYLES.cinematic;
    const real = stats.filter((s) => s && !s.flat && s.y > 0.03 && s.y < 0.97);
    const target = real.length >= 2 && {
      // Film exposure: its own median, nudged a little toward a normal mid level (never forces night into day).
      y: clamp(median(real.map((s) => s.y)) * 0.8 + 0.42 * 0.2, 0.12, 0.7),
      c: median(real.map((s) => s.c)), sat: median(real.map((s) => s.sat)),
      rg: median(real.map((s) => s.r - s.g)), bg: median(real.map((s) => s.b - s.g)),
    };
    return stats.map((s) => {
      const look = { contrast: st.contrast, saturation: st.saturation, gamma: st.gamma, balance: { ...st.balance } };
      if (!target || !s || s.flat || s.y <= 0.03 || s.y >= 0.97) return finish(look);
      // Exposure via gamma (eq: out = in^(1/gamma)); moving the shot's mean y part-way to the target.
      const want = s.y + (target.y - s.y) * STRENGTH.exposure;
      const dead = (x) => (Math.abs(x - 1) < 0.02 ? 1 : x); // ignore corrections too small to see
      const g = Math.abs(want - s.y) < 0.015 ? 1 : clamp(Math.log(s.y) / Math.log(want), ...LIMIT.gamma);
      // Contrast only between shots that both have real tonal range (low-contrast measurements are noise / haze).
      const c = s.c < 0.04 || target.c < 0.04 ? 1 : dead(clamp(Math.pow(target.c / s.c, STRENGTH.contrast), ...LIMIT.contrast));
      let sat = dead(clamp(Math.pow(target.sat / Math.max(0.02, s.sat), STRENGTH.saturation), ...LIMIT.saturation));
      // Never push an already colourful shot further (protects skin and bright colours from looking unnatural).
      if (s.sat > 0.3) sat = Math.min(sat, 1 / Math.max(1, st.saturation));
      look.gamma *= g; look.contrast *= c; look.saturation *= sat;
      // Colour cast relative to the film's own median cast (keeps an intentional overall tone). Weaker on colourful shots,
      // where a strong colour is usually the content (sky, neon), not a white-balance error.
      const k = STRENGTH.cast * clamp(1 - (s.sat - 0.1) / 0.12, 0, 1) / MID_WEIGHT;
      const dr = clamp(-((s.r - s.g) - target.rg) * k, -LIMIT.cast, LIMIT.cast), db = clamp(-((s.b - s.g) - target.bg) * k, -LIMIT.cast, LIMIT.cast);
      if (dr) look.balance.rm = (look.balance.rm || 0) + dr;
      if (db) look.balance.bm = (look.balance.bm || 0) + db;
      return finish(look);
    });
  }
  function finish(look) {
    look.contrast = r3(look.contrast); look.saturation = r3(look.saturation); look.gamma = r3(look.gamma);
    for (const k of Object.keys(look.balance)) { look.balance[k] = r3(look.balance[k]); if (Math.abs(look.balance[k]) < 0.004) delete look.balance[k]; }
    return look;
  }

  // FFmpeg filter chain for a look (no trailing comma).
  function lookFilter(look) {
    const b = Object.entries(look.balance).map(([k, v]) => k + "=" + v).join(":");
    return "eq=contrast=" + look.contrast + ":saturation=" + look.saturation + ":gamma=" + look.gamma + (b ? ",colorbalance=" + b : "");
  }

  return { shotStats, matchLooks, lookFilter, STYLES, LIMIT };
});
