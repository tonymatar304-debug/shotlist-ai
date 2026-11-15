/* CLAQE local audio helpers. NOT AI, no network: loudness levelling, beat detection and beat-aware cut timing.
 * Pure functions work in Node (tests) and the browser (window.ClaqeMusic); decodeMusic() needs WebAudio. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ClaqeMusic = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const median = (a) => { const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

  // ---------- loudness ----------
  // FFmpeg ebur128 summary (log text) -> { I: integrated LUFS, peak: sample peak dBFS } or null
  function parseLoudness(log) {
    const at = log.lastIndexOf("Summary:"); if (at >= 0) log = log.slice(at); // per-frame lines also contain "I: ... LUFS"
    const i = /I:\s+(-?[\d.]+|-inf) LUFS/.exec(log), p = /Peak:\s+(-?[\d.]+|-inf) dBFS/.exec(log);
    if (!i) return null;
    const num = (m) => (!m || m[1] === "-inf" ? -Infinity : parseFloat(m[1]));
    return { I: num(i), peak: p ? num(p) : 0 };
  }
  const SILENT_LUFS = -45; // quieter than this = (near) silence or room noise: never boosted
  // Conservative levelling: clips are pulled towards the median loudness of the clips with sound, only when they differ by
  // more than 2 dB, by at most -10/+8 dB, and never so far that a sample peak passes -1 dBFS (no clipping from gain).
  // measures[i]: {I, peak} or null (no usable sound). music: {I, peak} or null.
  function levelGains(measures, music = null) {
    const usable = measures.map((m) => m && Number.isFinite(m.I) && m.I > SILENT_LUFS);
    const levels = measures.filter((_, i) => usable[i]).map((m) => m.I);
    const target = levels.length ? clamp(median(levels), -24, -14) : -16;
    const gain = (m, want) => { let g = clamp(want - m.I, -10, 8); if (Math.abs(g) < 2) g = 0; if (Number.isFinite(m.peak)) g = Math.min(g, -1 - m.peak); return Math.round(g * 10) / 10; };
    const clips = measures.map((m, i) => (usable[i] ? gain(m, target) : 0));
    let musicGain = null;
    if (music && Number.isFinite(music.I) && music.I > -60) {
      // a bed under the clips' own sound (and ducked further by them), or the main soundtrack when the clips are silent
      const want = levels.length ? target - 6 : -16;
      musicGain = Math.round(Math.min(clamp(want - music.I, -20, 6), Number.isFinite(music.peak) ? -1 - music.peak : 6) * 10) / 10;
    }
    return { target, clips, musicGain };
  }

  // ---------- beat detection (spectral flux + autocorrelation tempo + dynamic-programming beat tracking) ----------
  function fft(re, im) { // in place, length power of two
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
    for (let len = 2; len <= n; len <<= 1) {
      const a = -2 * Math.PI / len, wr = Math.cos(a), wi = Math.sin(a);
      for (let i = 0; i < n; i += len) { let cr = 1, ci = 0; for (let k = 0; k < len / 2; k++) {
        const xr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci, xi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k + len / 2] = re[i + k] - xr; im[i + k + len / 2] = im[i + k] - xi; re[i + k] += xr; im[i + k] += xi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t; } }
    }
  }
  const N = 1024, HOP = 256;
  function onsetEnvelope(x, sr) {
    const frames = Math.max(0, Math.floor((x.length - N) / HOP) + 1), env = new Float64Array(frames), win = new Float64Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
    const maxBin = Math.min(N / 2, Math.round(8000 / sr * N)); let prev = new Float64Array(maxBin);
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let f = 0; f < frames; f++) {
      for (let i = 0; i < N; i++) { re[i] = x[f * HOP + i] * win[i]; im[i] = 0; }
      fft(re, im); const cur = new Float64Array(maxBin); let s = 0;
      for (let b = 1; b < maxBin; b++) { cur[b] = Math.log1p(10 * Math.hypot(re[b], im[b])); if (f) s += Math.max(0, cur[b] - prev[b]); }
      env[f] = s; prev = cur;
    }
    // remove the slowly varying level (0.5 s moving mean), keep positive part, normalise
    const W = Math.round(0.25 * sr / HOP), out = new Float64Array(frames); let mean = 0, sd = 0;
    for (let f = 0; f < frames; f++) { let a = 0, n = 0; for (let k = Math.max(0, f - W); k <= Math.min(frames - 1, f + W); k++) { a += env[k]; n++; } out[f] = Math.max(0, env[f] - a / n); mean += out[f]; }
    mean /= frames || 1; for (const v of out) sd += (v - mean) ** 2; sd = Math.sqrt(sd / (frames || 1)) || 1;
    for (let f = 0; f < frames; f++) out[f] /= sd;
    return out;
  }
  // Exact onset near t: the steepest rise of a 2 ms energy envelope within +-60 ms.
  function refine(x, sr, t) {
    const B = Math.max(1, Math.round(0.002 * sr)), a = Math.max(0, Math.floor((t - 0.06) * sr / B)), b = Math.min(Math.floor(x.length / B) - 1, Math.ceil((t + 0.06) * sr / B));
    let best = t, bestD = 0, prevE = null;
    for (let k = a; k <= b; k++) { let e = 0; for (let i = k * B; i < (k + 1) * B; i++) e += x[i] * x[i]; e = Math.sqrt(e / B); if (prevE !== null && e - prevE > bestD) { bestD = e - prevE; best = k * B / sr; } prevE = e; }
    return best;
  }
  // x: mono samples, sr: rate. Returns { kind: "beats"|"accents"|"none", tempo, confidence, beats:[{t, strength}] } (t in seconds of x).
  function detectBeats(x, sr) {
    const env = onsetEnvelope(x, sr), fr = sr / HOP, n = env.length;
    if (n < fr * 4) return { kind: "none", tempo: 0, confidence: 0, beats: [] };
    // tempo: autocorrelation over 60-190 BPM, weighted towards ~120 BPM (one octave wide)
    let bestL = 0, bestV = -Infinity; const ac = (L) => { let s = 0; for (let i = L; i < n; i++) s += env[i] * env[i - L]; return s / (n - L); };
    const acs = new Map();
    for (let L = Math.floor(fr * 60 / 190); L <= Math.ceil(fr * 60 / 60); L++) { const v = ac(L); acs.set(L, v); const bpm = 60 * fr / L, w = Math.exp(-0.5 * (Math.log2(bpm / 120) / 1) ** 2); if (v * w > bestV) { bestV = v * w; bestL = L; } }
    const a0 = acs.get(bestL - 1) ?? 0, a1 = acs.get(bestL), a2 = acs.get(bestL + 1) ?? 0, den = a0 - 2 * a1 + a2;
    const period = bestL + (den < 0 ? clamp(0.5 * (a0 - a2) / den, -0.5, 0.5) : 0);
    // dynamic programming (Ellis 2007): beats on strong onsets, spaced close to the period
    const C = new Float64Array(n), P = new Int32Array(n).fill(-1), alpha = 100;
    for (let t = 0; t < n; t++) {
      let best = 0, arg = -1;
      for (let tau = Math.max(0, Math.round(t - 2 * period)); tau <= t - Math.round(period / 2); tau++) { const v = C[tau] - alpha * Math.log((t - tau) / period) ** 2; if (v > best || arg < 0) { best = v; arg = tau; } }
      C[t] = env[t] + (arg >= 0 ? Math.max(0, best) : 0); P[t] = arg >= 0 && best > 0 ? arg : -1;
    }
    let t = n - 1; for (let k = n - 1; k >= Math.max(0, n - Math.round(period)); k--) if (C[k] > C[t]) t = k;
    const frames = []; for (; t >= 0; t = P[t]) frames.unshift(t);
    // confidence: autocorrelation coefficient of the onset envelope at the beat period (periodic music ~0.5-1, noise ~0)
    const at = (f) => Math.max(...[-2, -1, 0, 1, 2].map((d) => env[clamp(f + d, 0, n - 1)]));
    let mean = 0; for (const v of env) mean += v; mean /= n;
    const coef = (L) => { let s = 0, s0 = 0; for (let i = 0; i < n; i++) { s0 += (env[i] - mean) ** 2; if (i >= L) s += (env[i] - mean) * (env[i - L] - mean); } return s0 ? s / s0 * n / (n - L) : 0; };
    // smear the lag by +-1 frame (the period is fractional); take the best
    const confidence = Math.max(coef(bestL - 1), coef(bestL), coef(bestL + 1));
    const max = Math.max(...frames.map(at), 1e-9), lat = (N / 2) / sr; // frame index -> time of the window centre
    if (confidence >= 0.3 && frames.length >= 4) {
      return { kind: "beats", tempo: Math.round(600 * fr / period) / 10, confidence: Math.round(confidence * 100) / 100,
        beats: frames.map((f) => ({ t: Math.round(refine(x, sr, f / fr + lat - 0.5 / fr) * 1000) / 1000, strength: Math.round(at(f) / max * 100) / 100 })) };
    }
    // no steady beat: use clear rhythmic accents (strong isolated onsets, >= 0.4 s apart)
    let sd = 0; for (const v of env) sd += (v - mean) ** 2; sd = Math.sqrt(sd / n);
    const acc = []; for (let f = 1; f < n - 1; f++) if (env[f] > mean + 4 * sd && env[f] >= env[f - 1] && env[f] > env[f + 1] && (!acc.length || f - acc[acc.length - 1] > 0.4 * fr)) acc.push(f);
    const am = Math.max(...acc.map((f) => env[f]), 1e-9);
    return { kind: acc.length >= 3 ? "accents" : "none", tempo: 0, confidence: Math.round(confidence * 100) / 100,
      beats: acc.length >= 3 ? acc.map((f) => ({ t: Math.round(refine(x, sr, f / fr + lat - 0.5 / fr) * 1000) / 1000, strength: Math.round(env[f] / am * 100) / 100 })) : [] };
  }

  // ---------- beat-aware cut timing ----------
  // Moves each cut of an existing plan to a nearby beat (film time) when the shots on both sides allow it:
  // a shot never crosses a scene cut, an avoided frame or another shot of the same clip, never runs past its clip,
  // never drops a key story moment (plan item .moment), stays >= 1 s, and the film never gets longer.
  // clips[i]: { duration, cuts?: [scene cut times], avoid?: [times] }. Returns { plan, aligned, cuts }.
  const TOL = { dynamic: 0.3, cinematic: 0.5, vintage: 0.45 }, STRONG = { dynamic: 0.15, cinematic: 0.5, vintage: 0.3 };
  function alignToBeats(plan, clips, beats, { film = 30, style = "cinematic", fps = 24 } = {}) {
    const same = { plan, aligned: 0, cuts: [] };
    if (!beats || beats.length < 2 || plan.length < 2) return same;
    const tol = TOL[style] ?? 0.4, wStrong = STRONG[style] ?? 0.3, fr = (t) => Math.round(t * fps) / fps;
    const lim = plan.map((p, k) => {
      const c = clips[p.src] || {}, end = p.start + p.duration;
      let max = (Number.isFinite(c.duration) ? c.duration : end) - 0.05;
      for (const x of c.cuts || []) if (x > end - 1e-6) max = Math.min(max, x - 0.08);
      for (const x of c.avoid || []) if (x > end - 1e-6) max = Math.min(max, x - 0.3);
      plan.forEach((q, j) => { if (j !== k && q.src === p.src && q.start >= end - 1e-6) max = Math.min(max, q.start); });
      const min = Math.max(1, 0.6 * p.duration, Number.isFinite(p.moment) ? p.moment - p.start + 0.4 : 0);
      return { min: Math.min(min, p.duration), max: Math.max(p.duration, max - p.start) };
    });
    const total = Math.min(film, plan.reduce((s, p) => s + p.duration, 0));
    const dur = []; let prev = 0, nominal = 0, aligned = 0; const cuts = [];
    for (let k = 0; k < plan.length - 1; k++) {
      nominal += plan[k].duration;
      const lo = prev + lim[k].min, hi = Math.min(prev + lim[k].max, total - 1);
      let pick = null, ps = Infinity;
      for (const b of beats) { if (Math.abs(b.t - nominal) > tol || b.t < lo || b.t > hi) continue; const s = Math.abs(b.t - nominal) / tol - wStrong * b.strength; if (s < ps) { ps = s; pick = b.t; } }
      let cut = clamp(pick ?? nominal, lo, hi); cut = fr(cut); if (cut < lo - 1e-9) cut += 1 / fps; if (cut > hi + 1e-9) cut -= 1 / fps;
      if (pick !== null) { aligned++; cuts.push(cut); }
      dur.push(cut - prev); prev = cut;
    }
    const L = lim[plan.length - 1], last = Math.min(Math.floor((total - prev) * fps + 1e-6) / fps, Math.floor(L.max * fps + 1e-6) / fps);
    if (last < L.min - 1e-9 || last < 1) return same; // could not keep the ending intact: keep the original timing
    dur.push(last);
    if (dur.some((d, k) => d < lim[k].min - 1 / fps - 1e-9 || d > lim[k].max + 1 / fps + 1e-9)) return same;
    return { plan: plan.map((p, k) => ({ ...p, duration: Math.round(dur[k] * 1e6) / 1e6 })), aligned, cuts };
  }

  // ---------- browser: decode a music file to mono 22.05 kHz (WebAudio) ----------
  async function decodeMusic(file, { maxSeconds = 600 } = {}) {
    const AC = (typeof window !== "undefined" && (window.OfflineAudioContext || window.webkitOfflineAudioContext));
    if (!AC) throw new Error("This browser can't decode audio.");
    const buf = await new AC(1, 1, 44100).decodeAudioData(await file.arrayBuffer());
    const sr = 22050, len = Math.min(Math.ceil(buf.duration * sr), maxSeconds * sr), ctx = new AC(1, len, sr), src = ctx.createBufferSource();
    src.buffer = buf; src.connect(ctx.destination); src.start(); // multichannel is downmixed to mono by the 1-channel context
    const mono = (await ctx.startRendering()).getChannelData(0);
    let start = 0; while (start < mono.length && Math.abs(mono[start]) < 0.02) start++; // skip leading silence
    return { samples: mono, sr, duration: buf.duration, start: Math.max(0, start / sr - 0.01) };
  }

  return { parseLoudness, levelGains, detectBeats, onsetEnvelope, alignToBeats, decodeMusic, SILENT_LUFS };
});
