/* CLAQE local footage analysis + deterministic footage-aware planner. NOT AI: no model, no network, no upload.
 * Understands only low-level visual signals (exposure, detail, motion, camera movement, scene cuts, look distinctiveness),
 * never what is in the picture. Pure functions work in Node (tests) and the browser (window.ClaqeAnalyze).
 * Memory: the browser sampler keeps one 96x54 grey frame at a time plus ~600 bytes per sample. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ClaqeAnalyze = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const W = 96, H = 54, TW = 32, TH = 18, BINS = 16, SCENE_T = 0.3, MOTION_DT = 0.25;
  const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
  const r1 = (x) => Math.round(x * 10) / 10;

  // ---------- pure feature extraction (grey frames: Uint8 arrays, length W*H) ----------
  function stats(g, w = W, h = H) {
    let sum = 0; const hist = new Array(BINS).fill(0);
    for (let i = 0; i < g.length; i++) { sum += g[i]; hist[g[i] >> 4]++; }
    const mean = sum / g.length; let v = 0;
    for (let i = 0; i < g.length; i++) v += (g[i] - mean) * (g[i] - mean);
    let lap = 0, n = 0;
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x, l = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w]; lap += l * l; n++;
    }
    return { bright: mean / 255, contrast: Math.sqrt(v / g.length) / 255, sharp: lap / n / 65025, hist: hist.map((c) => c / g.length) };
  }
  // Global-shift estimate between two frames: pan = camera movement, resid = movement left after cancelling the shift (subject motion).
  function pairMotion(a, b, w = W, h = H, R = 4) {
    const m = R + 1; let best = Infinity, bx = 0, by = 0, base = 0;
    const sad = (dx, dy) => { let s = 0, n = 0; for (let y = m; y < h - m; y += 2) for (let x = m; x < w - m; x += 2) { s += Math.abs(a[y * w + x] - b[(y + dy) * w + x + dx]); n++; } return s / n; };
    base = sad(0, 0);
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const s = sad(dx, dy) + 0.0001 * (Math.abs(dx) + Math.abs(dy)); if (s < best) { best = s; bx = dx; by = dy; }
    }
    return { mad: base / 255, pan: Math.hypot(bx, by), resid: Math.min(best, base) / 255 };
  }
  function down(g, w = W, h = H) { // 96x54 -> 32x18 box average
    const t = new Uint8Array(TW * TH), fx = w / TW, fy = h / TH;
    for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) {
      let s = 0; for (let j = 0; j < fy; j++) for (let i = 0; i < fx; i++) s += g[(y * fy + j) * w + x * fx + i]; t[y * TW + x] = s / (fx * fy);
    }
    return t;
  }
  // One time sample from frames at t (g0) and t+dt (g1, optional).
  function featurize(t, g0, g1) {
    const s = stats(g0); const m = g1 ? pairMotion(g0, g1) : { mad: 0, pan: 0, resid: 0 };
    return { t: Math.round(t * 100) / 100, bright: s.bright, contrast: s.contrast, sharp: s.sharp, hist: s.hist, tiny: Array.from(down(g0)), motion: m.mad, pan: m.pan, resid: m.resid, scene: 0 };
  }
  // Visual distance between two samples (0..1): colour/brightness distribution + layout.
  function sceneDistance(a, b) {
    let h = 0; for (let i = 0; i < BINS; i++) h += Math.abs(a.hist[i] - b.hist[i]); // 0..2
    let d = 0; for (let i = 0; i < a.tiny.length; i++) d += Math.abs(a.tiny[i] - b.tiny[i]);
    return 0.5 * (h / 2) + 0.5 * (d / a.tiny.length / 255);
  }
  function linkScenes(samples) { samples.forEach((s, i) => { s.scene = i ? sceneDistance(samples[i - 1], s) : 0; }); return samples; }

  // ---------- derived per-clip timeline ----------
  const STYLE_WEIGHTS = {
    cinematic: { exposure: 0.2, sharp: 0.25, motion: 0.1, energy: 0.05, novelty: 0.2, camera: 0.2 },
    dynamic: { exposure: 0.1, sharp: 0.15, motion: 0.3, energy: 0.1, novelty: 0.15, camera: 0.2 },
    vintage: { exposure: 0.15, sharp: 0.2, motion: 0.2, energy: 0.05, novelty: 0.25, camera: 0.15 },
  };
  function rank(values) {
    const idx = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]), out = new Array(values.length), n = values.length;
    for (let i = 0; i < n;) { let j = i; while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++; const r = n > 1 ? (i + j) / 2 / (n - 1) : 0.5; for (let k = i; k <= j; k++) out[idx[k][1]] = r; i = j + 1; }
    return out;
  }
  // Scores each sample 0..1 for the style, combining several signals (never brightness/sharpness alone).
  function scoreClip(clip, style) {
    const S = clip.samples, w = STYLE_WEIGHTS[style] || STYLE_WEIGHTS.cinematic, n = S.length;
    const mean = new Array(BINS).fill(0); S.forEach((s) => s.hist.forEach((v, i) => (mean[i] += v / n)));
    const novelty = rank(S.map((s) => s.hist.reduce((a, v, i) => a + Math.abs(v - mean[i]), 0)));
    // Motion blends rank-within-clip with ABSOLUTE size, so a clip where nothing happens can't out-score one with real action.
    const sharpR = rank(S.map((s) => s.sharp)), motionR = rank(S.map((s) => s.resid)).map((r, i) => 0.5 * r + 0.5 * clamp(S[i].resid / 0.08)), energyR = rank(S.map((s) => s.motion)).map((r, i) => 0.5 * r + 0.5 * clamp(S[i].motion / 0.15));
    S.forEach((s, i) => {
      const exposure = (s.bright < 0.06 || s.bright > 0.96 ? 0.2 : 1) * clamp(1 - Math.abs(s.bright - 0.5) / 0.5) ** 0.5;
      const flat = s.sharp < 1e-6 && s.contrast < 0.02 ? 0.3 : 1;                    // featureless frame (cap, black, fade)
      const pan = clamp(s.pan / 4), shake = pan * (1 - sharpR[i]) * clamp(s.resid * 8);  // fast shift + blur + chaos
      const camera = pan * (1 - shake) * (1 - clamp(s.resid * 6)) * 0.8 + (1 - pan) * 0.4; // deliberate move or steady hold
      const sc = (w.exposure * exposure + w.sharp * sharpR[i] * flat + w.motion * motionR[i] + w.energy * energyR[i] + w.novelty * novelty[i] + w.camera * camera) * flat - 0.25 * shake;
      s.interest = clamp(sc);
      // Optional semantic judgement from ClaqeVision.applyVision (model output, validated): blends with, never replaces, the local score.
      if (s.sem) s.interest = s.sem.avoid ? s.interest * 0.15 : clamp(s.interest * (1 - 0.5 * s.sem.w) + s.sem.importance * 0.5 * s.sem.w + (s.sem.must ? 0.12 * s.sem.w : 0));
      s.traits = { exposure, sharpR: sharpR[i], motion: motionR[i], novelty: novelty[i], camera, shake };
    });
    return clip;
  }
  // A cut is a LOCAL MAXIMUM of visual change above the threshold (fast motion raises several neighbours; only the peak is a cut).
  function isCut(S, i) { const d = S[i].scene; return d > SCENE_T && d >= S[i - 1].scene && (i + 1 >= S.length || d > S[i + 1].scene); }
  function sceneRanges(clip) { // [{start,end}] split at detected cuts
    const S = clip.samples, cuts = [0]; S.forEach((s, i) => { if (i && isCut(S, i)) cuts.push((S[i - 1].t + s.t) / 2); });
    cuts.push(clip.duration); const out = [];
    for (let i = 0; i < cuts.length - 1; i++) out.push({ start: cuts[i], end: cuts[i + 1] });
    return out;
  }
  function windowStats(clip, a, b) {
    const S = clip.samples; let sum = 0, n = 0, max = 0, best = null;
    for (const s of S) if (s.t >= a - 0.25 && s.t <= b + 0.25) { sum += s.interest; n++; if (s.interest >= max) { max = s.interest; best = s; } }
    if (!n) { let d = Infinity; for (const s of S) if (Math.abs(s.t - (a + b) / 2) < d) { d = Math.abs(s.t - (a + b) / 2); best = s; } sum = best.interest; n = 1; max = best.interest; }
    return { score: sum / n, peak: max, rep: best };
  }
  // Promising time ranges of a clip for a style (also used for display/tests).
  function findRanges(clip, style, len) {
    const out = [];
    for (const sc of sceneRanges(clip)) {
      const a0 = sc.start + (sc.start > 0 ? 0.15 : 0), b0 = sc.end - (sc.end < clip.duration ? 0.15 : 0.05), room = b0 - a0;
      if (room < 1) continue;
      const L = Math.min(len, room);
      for (let a = a0; a + L <= b0 + 1e-6; a += 0.5) {
        const ws = windowStats(clip, a, a + L);
        out.push({ start: r1(a), duration: r1(L), score: ws.score * 0.8 + ws.peak * 0.2 + (a === a0 && sc.start > 0 ? 0.04 : 0), rep: ws.rep });
      }
    }
    return out;
  }

  // ---------- pacing + planner ----------
  const PACE = { cinematic: [5, 6, 5.5, 6], dynamic: [3, 2.6, 2.2, 2, 1.8, 1.6], vintage: [3.5, 4, 3, 4.5] };
  function shotLengths(style, film) {
    const seq = PACE[style] || PACE.cinematic, out = []; let sum = 0;
    for (let i = 0; sum < film - 0.05; i++) { const L = Math.min(i < seq.length ? seq[i] : style === "dynamic" ? seq[seq.length - 1] : seq[i % seq.length], film - sum); out.push(L); sum += L; }
    if (out.length > 1 && out[out.length - 1] < 1.2) { const x = out.pop(); out[out.length - 1] += x; }
    return out.map(r1);
  }
  const histDist = (a, b) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / 2;
  function why(t) {
    const p = []; if (t.sharpR > 0.65) p.push("sharp detail"); if (t.motion > 0.65) p.push("strong subject motion");
    if (t.camera > 0.45 && t.shake < 0.2) p.push("steady/deliberate camera"); if (t.novelty > 0.65) p.push("distinct look"); if (t.exposure > 0.85) p.push("well exposed");
    return p.length ? p.join(", ") : "best available moment";
  }
  // clips: [{duration, samples}]. Returns { plan:[{src,start,duration,score,reason}], total, source:"local-analysis" }.
  function planFilm(clips, style, film = 30) {
    style = STYLE_WEIGHTS[style] ? style : "cinematic";
    clips.forEach((c) => scoreClip(c, style));
    const avail = clips.reduce((a, c) => a + c.duration, 0), target = Math.min(film, avail - 0.2 * clips.length);
    const lens = shotLengths(style, target), chosen = [], count = clips.map(() => 0);
    let total = 0;
    for (let k = 0; k < 60 && target - total >= 1; k++) {
      const want = lens[Math.min(k, lens.length - 1)], L0 = Math.min(want, target - total), lens_k = L0 < 1 ? 1 : L0;
      let best = null;
      for (let ci = 0; ci < clips.length; ci++) for (const c of findRanges(clips[ci], style, lens_k)) {
        const hit = chosen.some((x) => x.src === ci && c.start < x.start + x.duration + 0.5 && c.start + c.duration > x.start - 0.5);
        if (hit) continue;
        let sc = c.score / (1 + 0.1 * count[ci]);
        for (const x of chosen) if (histDist(c.rep.hist, x.rep.hist) < 0.08) sc -= 0.06; // near-duplicate look
        if (c.duration < lens_k - 0.05) sc *= 0.8 + 0.2 * (c.duration / lens_k);       // scene shorter than the slot
        if (!best || sc > best.sc + 1e-9) best = { ...c, src: ci, sc };
      }
      if (!best) break;
      total += best.duration; count[best.src]++; chosen.push({ src: best.src, start: best.start, duration: best.duration, score: Math.round(best.sc * 100) / 100, rep: best.rep, reason: best.rep.sem && best.rep.sem.caption && !best.rep.sem.avoid ? best.rep.sem.caption : why(best.rep.traits) });
    }
    // Order by style: cinematic/vintage tell the story in upload order then time; dynamic opens on its strongest shot, then alternates clips.
    let order;
    if (style === "dynamic") {
      const sorted = chosen.slice().sort((a, b) => b.score - a.score), opener = sorted[0], rest = chosen.filter((x) => x !== opener).sort((a, b) => a.src - b.src || a.start - b.start);
      const byClip = clips.map((_, ci) => rest.filter((x) => x.src === ci)); order = opener ? [opener] : [];
      while (byClip.some((q) => q.length)) for (const q of byClip) if (q.length) order.push(q.shift());
    } else order = chosen.slice().sort((a, b) => a.src - b.src || a.start - b.start);
    const plan = order.map((x) => ({ src: x.src, start: x.start, duration: x.duration, score: x.score, reason: x.reason }));
    return { source: "local-analysis", style, plan, total: r1(plan.reduce((a, p) => a + p.duration, 0)) };
  }

  // ---------- browser sampler (needs DOM) ----------
  // Samples the WHOLE clip at ~1 fps (second centres), then adds a half-step sample wherever a visual cut is suspected.
  async function analyzeClip(file, duration, { step = 1, onSample, signal } = {}) {
    const video = document.createElement("video"), url = URL.createObjectURL(file);
    const canvas = document.createElement("canvas"); canvas.width = W; canvas.height = H;
    const g = canvas.getContext("2d", { willReadFrequently: true });
    video.muted = true; video.playsInline = true; video.preload = "auto"; video.src = url;
    try {
      await new Promise((res, rej) => { const to = setTimeout(() => rej(new Error("video did not load")), 15000); video.onloadeddata = () => { clearTimeout(to); res(); }; video.onerror = () => { clearTimeout(to); rej(new Error("video cannot be decoded")); }; });
      const seek = (t) => new Promise((res, rej) => { const to = setTimeout(() => rej(new Error("seek timeout")), 8000); video.onseeked = () => { clearTimeout(to); res(); }; video.currentTime = Math.min(Math.max(0, t), Math.max(0, duration - 0.05)); });
      const grab = async (t) => { await seek(t); await new Promise((r) => requestAnimationFrame(() => r())); g.drawImage(video, 0, 0, W, H);
        const d = g.getImageData(0, 0, W, H).data, o = new Uint8Array(W * H); for (let i = 0; i < o.length; i++) o[i] = (d[i * 4] * 77 + d[i * 4 + 1] * 150 + d[i * 4 + 2] * 29) >> 8; return o; };
      const sampleAt = async (t) => { const a = await grab(t); const b = t + MOTION_DT < duration - 0.05 ? await grab(t + MOTION_DT) : null; const s = featurize(t, a, b); if (onSample) onSample(s); return s; };
      const samples = [];
      for (let t = step / 2; t < duration - 0.1; t += step) { if (signal && signal.aborted) throw new Error("cancelled"); samples.push(await sampleAt(t)); }
      if (!samples.length) samples.push(await sampleAt(Math.max(0, duration / 2)));
      linkScenes(samples);
      const extra = []; // refine suspected cuts: look half a step earlier
      for (let i = 1; i < samples.length; i++) if (samples[i].scene > SCENE_T * 0.8 && samples[i].t - samples[i - 1].t > 0.6) extra.push(await sampleAt((samples[i].t + samples[i - 1].t) / 2));
      samples.push(...extra); samples.sort((a, b) => a.t - b.t); linkScenes(samples);
      return { duration, samples };
    } finally { video.removeAttribute("src"); try { video.load(); } catch (_) {} URL.revokeObjectURL(url); }
  }

  return { analyzeClip, planFilm, findRanges, scoreClip, sceneRanges, shotLengths, featurize, stats, pairMotion, sceneDistance, linkScenes, W, H, SCENE_T };
});
