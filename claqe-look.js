/* CLAQE footage-aware grading. Pure functions (Node tests + browser window.ClaqeLook), no network.
 * 1) Measure each shot from the analysis samples it covers (luma, contrast, mean RGB, saturation).
 * 2) Match: pull each shot part-way toward the film's median exposure / contrast / saturation / colour cast,
 *    with tight limits, so shots sit together without all looking identical.
 * 3) Style look on top: a restrained tone curve (lutyuv, black and white points pinned: never crushes or clips), a light
 *    saturation/vibrance difference and at most a faint warmth. No teal/orange split-tone, no sharpening, no LUT.
 *    The curve's contrast is scaled down on dark shots, so night/low-key footage keeps its shadow detail.
 * Costs one eq + one lutyuv (YUV, table lookups) and, only when needed, one RGB step (colorbalance/vibrance) with explicit
 * BT.709 matrices both ways (FFmpeg's automatic conversion picked a mismatched matrix: ~1 dE on a no-op round trip). */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ClaqeLook = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const median = (a) => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const r3 = (x) => Math.round(x * 1000) / 1000;

  // Style looks. curve: s = midtone S-curve strength (0 = none), toe = shadow lift (filmic, 0.02 ~ 4 levels at black),
  // shoulder = highlight roll-off (0.08 ~ whites 4 levels softer). Skin sits in the midtones: no hue shifts there.
  // balance: colorbalance SHADOWS/HIGHLIGHTS only (rs/bs/rh/bh): FFmpeg 5.1's midtone terms (rm/gm/bm) measured as a no-op.
  const STYLES = {
    cinematic: { contrast: 1, saturation: 0.94, gamma: 1, curve: { s: 0.1, toe: 0.02, shoulder: 0.08 }, vibrance: 0, balance: { rh: 0.01, bh: -0.01 } },
    dynamic: { contrast: 1, saturation: 1, gamma: 1, curve: { s: 0.12, toe: 0, shoulder: 0.03 }, vibrance: 0.12, balance: {} },
    vintage: { contrast: 1, saturation: 0.84, gamma: 1, curve: { s: 0.04, toe: 0.045, shoulder: 0.1 }, vibrance: 0, balance: { rs: 0.015, bs: -0.02, rh: 0.015, bh: -0.025 } },
  };
  // Contrast/saturation matching only ever ADD to flat/dull shots: eq contrast < 1 lifts black above 16 (milky shadows) and
  // lowering saturation flattened intentionally colourful shots in the gym test.
  const LIMIT = { gamma: [0.82, 1.22], contrast: [1, 1.05], saturation: [1, 1.08], cast: 0.03 };
  const STRENGTH = { exposure: 0.5, contrast: 0.5, saturation: 0.4, cast: 0.5 };
  const BAND = [0.1, 0.7]; // exposure kept as filmed inside this band (low-key gym/night footage sits ~0.11); only gross errors move

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
      c: median(real.map((s) => s.c)), sat: median(real.map((s) => s.sat)),
      rg: median(real.map((s) => s.r - s.g)), bg: median(real.map((s) => s.b - s.g)),
    };
    return stats.map((s) => {
      const look = { contrast: st.contrast, saturation: st.saturation, gamma: st.gamma, curve: { ...st.curve }, vibrance: st.vibrance, balance: { ...st.balance }, gain: { r: 1, b: 1 } };
      // Dark shots keep their shadows: the S-curve fades out below mean luma 0.35 (gone at 0.15). Known shots only.
      if (s && !s.flat) look.curve.s *= clamp((s.y - 0.15) / 0.2, 0, 1);
      if (!target || !s || s.flat || s.y <= 0.03 || s.y >= 0.97) return finish(look);
      // Exposure via gamma (eq: out = in^(1/gamma)): only shots OUTSIDE the normal band move, part-way toward its edge. A well
      // exposed shot is never darkened or brightened to match the others (that crushed a bright shot in the gym test).
      const edge = s.y < BAND[0] ? BAND[0] : s.y > BAND[1] ? BAND[1] : s.y, want = s.y + (edge - s.y) * STRENGTH.exposure;
      const dead = (x) => (Math.abs(x - 1) < 0.02 ? 1 : x); // ignore corrections too small to see
      const g = Math.abs(want - s.y) < 0.015 ? 1 : clamp(Math.log(s.y) / Math.log(want), ...LIMIT.gamma);
      // Contrast only between shots that both have real tonal range (low-contrast measurements are noise / haze).
      const c = s.c < 0.04 || target.c < 0.04 ? 1 : dead(clamp(Math.pow(target.c / s.c, STRENGTH.contrast), ...LIMIT.contrast));
      let sat = dead(clamp(Math.pow(target.sat / Math.max(0.02, s.sat), STRENGTH.saturation), ...LIMIT.saturation));
      // Never push an already colourful shot further (protects skin and bright colours from looking unnatural).
      if (s.sat > 0.3) sat = Math.min(sat, 1 / Math.max(1, st.saturation));
      look.gamma *= g; look.contrast *= c; look.saturation *= sat;
      // Colour cast relative to the film's own median cast (keeps an intentional overall tone), as white-balance channel GAINS
      // (colorchannelmixer: what white balance physically is). Weaker on colourful shots, where a strong colour is usually the
      // content (sky, neon), not a white-balance error. dr/db: wanted change of the channel mean (0..1), capped.
      const k = STRENGTH.cast * clamp(1 - (s.sat - 0.1) / 0.12, 0, 1);
      const dr = clamp(-((s.r - s.g) - target.rg) * k, -LIMIT.cast, LIMIT.cast), db = clamp(-((s.b - s.g) - target.bg) * k, -LIMIT.cast, LIMIT.cast);
      look.gain.r = 1 + dr / Math.max(0.1, s.r); look.gain.b = 1 + db / Math.max(0.1, s.b);
      return finish(look);
    });
  }
  function finish(look) {
    look.contrast = r3(look.contrast); look.saturation = r3(look.saturation); look.gamma = r3(look.gamma);
    if (look.curve) for (const k of Object.keys(look.curve)) look.curve[k] = r3(look.curve[k]);
    for (const k of Object.keys(look.balance)) { look.balance[k] = r3(look.balance[k]); if (Math.abs(look.balance[k]) < 0.004) delete look.balance[k]; }
    if (look.gain) for (const k of ["r", "b"]) { look.gain[k] = r3(look.gain[k]); if (Math.abs(look.gain[k] - 1) < 0.008) look.gain[k] = 1; }
    return look;
  }

  // Tone curve on limited-range luma (16..235), black and white points pinned. x in 0..1:
  // f = x + s*x(1-x)(2x-1)  [S: deeper low-mids, brighter high-mids, ends fixed]  + toe*(1-x)^4  - shoulder*((x-0.75)/0.25)^2*0.25 for x>0.75
  function curveExpr(c) {
    if (!c || (!c.s && !c.toe && !c.shoulder)) return "";
    // Single quotes protect the commas from the filtergraph parser (as zoompan's z='min(..,..)' did).
    const X = "ld(0)", terms = [X];
    if (c.s) terms.push("+" + c.s + "*" + X + "*(1-" + X + ")*(2*" + X + "-1)");
    if (c.toe) terms.push("+" + c.toe + "*pow(1-" + X + ",4)");
    if (c.shoulder) terms.push("-" + c.shoulder + "*0.25*pow(max(0," + X + "-0.75)/0.25,2)");
    return "lutyuv=y='st(0,clip((val-16)/219,0,1));16+219*clip(" + terms.join("") + ",0,1)'";
  }
  // FFmpeg filter chain for a look (no trailing comma).
  function lookFilter(look) {
    const b = Object.entries(look.balance).map(([k, v]) => k + "=" + v).join(":"), curve = curveExpr(look.curve);
    const g = look.gain || { r: 1, b: 1 }, mix = g.r !== 1 || g.b !== 1 ? "colorchannelmixer=rr=" + g.r + ":bb=" + g.b : "";
    const rgb = [mix, b ? "colorbalance=" + b : "", look.vibrance ? "vibrance=intensity=" + look.vibrance : ""].filter(Boolean);
    return "eq=contrast=" + look.contrast + ":saturation=" + look.saturation + ":gamma=" + look.gamma + (curve ? "," + curve : "") +
      (rgb.length ? ",scale=in_color_matrix=bt709:in_range=tv,format=gbrp," + rgb.join(",") + ",scale=out_color_matrix=bt709:out_range=tv,format=yuv420p" : "");
  }

  return { shotStats, matchLooks, lookFilter, curveExpr, STYLES, LIMIT, BAND };
});
