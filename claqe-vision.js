/* CLAQE semantic-vision client side. No network here; the Worker's /vision route (src/vision.js) calls the model.
 * Flow: local analysis -> chooseFrames()/buildVisionRequest() -> captureFrames() (small JPEGs) -> Worker /vision
 *       -> validateVisionResponse() (untrusted!) -> applyVision() -> the SAME planFilm()/FFmpeg renderer.
 * Status: contract + Worker verified with MOCK model replies only. No real model has been run. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ClaqeVision = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const VERSION = 1, MAX_FRAMES = 12, FRAME_WIDTH = 512, JPEG_QUALITY = 0.6, MAX_IMAGE_B64 = 70000;
  const SHOT_TYPES = ["wide", "medium", "close", "detail", "aerial", "title", "other"], ROLES = ["opener", "highlight", "closer", "filler", "avoid"];
  const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
  const histDist = (a, b) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / 2;
  const showable = (s) => s.bright > 0.06 && s.bright < 0.96 && !(s.sharp < 1e-6 && s.contrast < 0.02); // skip black/flat frames: nothing to describe

  // Pick up to `max` frames across ALL clips: >= 2 per clip (its best moment + its most different one), then the rest by
  // interest x visual variety (distance from frames already chosen), >= 2 s apart within a clip. Deterministic.
  function chooseFrames(clips, max = MAX_FRAMES) {
    const picks = clips.map(() => []), all = [];
    clips.forEach((c, ci) => c.samples.forEach((s, si) => { if (showable(s)) all.push({ ci, s, si, cut: si > 0 && s.scene > 0.3 }); }));
    const chosen = () => picks.flat();
    const ok = (c) => !picks[c.ci].some((p) => Math.abs(p.s.t - c.s.t) < 2) && chosen().length < max;
    const take = (c) => { picks[c.ci].push(c); };
    const variety = (c) => { const ch = chosen(); return ch.length ? Math.min(...ch.map((p) => histDist(p.s.hist, c.s.hist))) : 1; };
    const score = (c) => 0.55 * c.s.interest + 0.35 * Math.min(1, variety(c) * 3) + (c.cut ? 0.1 : 0) + 0.25 * Math.min(1, picks[c.ci].length ? Math.min(...picks[c.ci].map((p) => Math.abs(p.s.t - c.s.t))) / (clips[c.ci].duration / 3) : 0.5) + 0.25 * (clips[c.ci].duration / 60) / (1 + picks[c.ci].length); // longer clips earn more frames
    const best = (pool) => pool.filter(ok).sort((a, b) => score(b) - score(a) || a.s.t - b.s.t)[0];
    for (let round = 0; round < 2; round++) for (let ci = 0; ci < clips.length; ci++) { const c = best(all.filter((x) => x.ci === ci)); if (c) take(c); }
    while (chosen().length < max) { const c = best(all); if (!c) break; take(c); }
    return picks.map((p) => p.map((c) => ({ t: c.s.t, local: Math.round(c.s.interest * 100) / 100 })).sort((a, b) => a.t - b.t));
  }
  // Request: compact JSON; durations, times and local scores only (no file names / user ids). Frames travel separately as JPEGs.
  function buildVisionRequest(clips, { style, filmSeconds, maxFrames = MAX_FRAMES }) {
    const picks = chooseFrames(clips, maxFrames);
    return { version: VERSION, style, filmSeconds, clips: clips.map((c, ci) => ({ index: ci, duration: Math.round(c.duration * 10) / 10,
      frames: picks[ci].map((f, n) => ({ id: "c" + ci + "f" + n, t: f.t, local: f.local })) })) };
  }
  const frameIds = (req) => req.clips.flatMap((c) => c.frames.map((f) => f.id));

  // The model's answer is UNTRUSTED. Mirrors the Worker's validation: known ids only, echoed timestamp must match the request,
  // numbers clamped, strings cleaned. Returns null if mostly unusable (then the caller uses local analysis).
  const clean = (v, n) => (typeof v === "string" ? v.replace(/[\u0000-\u001f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, n) : "");
  function validateVisionResponse(resp, req) {
    if (!resp || typeof resp !== "object" || resp.version !== VERSION || !Array.isArray(resp.frames)) return null;
    const known = new Map(); req.clips.forEach((c) => c.frames.forEach((f) => known.set(f.id, f)));
    const seen = new Set(), frames = [];
    for (const f of resp.frames) {
      const rf = f && known.get(f.id);
      if (!rf || seen.has(f.id) || typeof f.importance !== "number" || !Number.isFinite(f.importance) || typeof f.t !== "number" || Math.abs(f.t - rf.t) > 0.1) continue;
      seen.add(f.id);
      frames.push({ id: f.id, t: rf.t, importance: clamp(f.importance), confidence: typeof f.confidence === "number" && Number.isFinite(f.confidence) ? clamp(f.confidence) : 0.5,
        subject: clean(f.subject, 60), action: clean(f.action, 60), setting: clean(f.setting, 60), mood: clean(f.mood, 30),
        shotType: SHOT_TYPES.includes(f.shotType) ? f.shotType : "other", usable: f.usable !== false, issues: (Array.isArray(f.issues) ? f.issues : []).slice(0, 4).map((x) => clean(x, 30)).filter(Boolean),
        role: ROLES.includes(f.role) ? f.role : "filler" });
    }
    if (frames.length < Math.ceil(known.size / 2)) return null;
    return { version: VERSION, frames, story: clean(resp.story, 200) };
  }
  // A caption is shown only when the model was reasonably sure (never present a guess as fact).
  const caption = (f) => (f.confidence >= 0.5 ? [f.subject, f.action].filter((x) => x && x !== "unclear").join(" – ") : "");

  // Attach semantic judgement to analysed samples. Influence fades with distance (2.5 s), scales with the model's confidence,
  // and stops at a scene cut. Planner blends it with local scores (never replaces them).
  // same cut rule as the planner (claqe-analyze isCut): a cut is a local maximum of visual change above 0.3
  const isCut = (S, i) => i > 0 && S[i].scene > 0.3 && S[i].scene >= S[i - 1].scene && (i + 1 >= S.length || S[i].scene > S[i + 1].scene);
  const look = (a, b) => { let h = 0; for (let k = 0; k < a.hist.length; k++) h += Math.abs(a.hist[k] - b.hist[k]); let d = 0; for (let k = 0; k < a.tiny.length; k++) d += Math.abs(a.tiny[k] - b.tiny[k]); return 0.5 * (h / 2) + 0.5 * (d / a.tiny.length / 255); };
  // Region around an avoided frame that LOOKS like it (a held title card, a long blurry stretch): contiguous samples within
  // distance 0.2 of the frame, at most +-6 s and never more than half the clip. A frame unlike its neighbours gets no region.
  function lookAlike(clip, t) {
    const S = clip.samples; if (!S.length) return null;
    let fi = 0; S.forEach((s, k) => { if (Math.abs(s.t - t) < Math.abs(S[fi].t - t)) fi = k; });
    let a = fi, b = fi;
    while (a > 0 && look(S[a - 1], S[fi]) < 0.2 && t - S[a - 1].t <= 6) a--;
    while (b < S.length - 1 && look(S[b + 1], S[fi]) < 0.2 && S[b + 1].t - t <= 6) b++;
    let lo = S[a].t - 0.5, hi = S[b].t + 0.5; const max = clip.duration / 2;
    if (hi - lo > max) { const c = (lo + hi) / 2; lo = Math.max(lo, c - max / 2); hi = Math.min(hi, c + max / 2); }
    return { lo, hi };
  }
  function applyVision(analysed, req, vision) {
    const byId = new Map(vision.frames.map((f) => [f.id, f]));
    analysed.forEach((clip, ci) => {
      clip.samples.forEach((s) => { delete s.sem; });
      clip.vision = req.clips[ci].frames.map((rf) => byId.get(rf.id)).filter(Boolean).map((f) => ({ t: f.t, role: f.role === "avoid" || !f.usable || f.shotType === "title" ? "avoid" : f.role, confidence: f.confidence, importance: f.importance }));
      const regions = new Map(req.clips[ci].frames.map((rf) => [rf.id, lookAlike(clip, rf.t)]));
      for (const rf of req.clips[ci].frames) {
        const f = byId.get(rf.id); if (!f) continue;
        const avoid = f.role === "avoid" || !f.usable || f.shotType === "title";
        for (const s of clip.samples) {
          // a confident "avoid" also covers the look-alike region around it (e.g. a held title card); otherwise it fades over 2.5 s
          const region = avoid && f.confidence >= 0.6 ? regions.get(rf.id) : null, dt = Math.abs(s.t - rf.t);
          const wide = !!region && s.t >= region.lo && s.t <= region.hi; if (!wide && dt > 2.5) continue;
          const lo = Math.min(s.t, rf.t), hi = Math.max(s.t, rf.t);
          if (!wide && clip.samples.some((x, xi) => x.t > lo && x.t <= hi && isCut(clip.samples, xi))) continue; // different scene
          const w = (wide ? 1 : 1 - dt / 2.5) * (0.4 + 0.6 * f.confidence);
          const isAvoid = avoid && f.confidence >= 0.4;
          if (!s.sem || (isAvoid && !s.sem.avoid) || (isAvoid === !!s.sem.avoid && w > s.sem.w)) s.sem = { w, importance: 0.5 + (f.importance - 0.5) * w, avoid: avoid && f.confidence >= 0.4, must: f.role === "highlight" || f.role === "opener" || f.role === "closer", caption: caption(f), role: f.role, conf: f.confidence };
        }
      }
    });
    return analysed;
  }

  // Deterministic stand-in for the model (tests/dev only).
  function mockVision(req, rules = {}) {
    return { version: VERSION, story: "mock response", frames: req.clips.flatMap((c) => c.frames.map((f) => {
      const r = rules[f.id] || {};
      return { id: f.id, t: f.t, importance: r.importance ?? f.local, confidence: r.confidence ?? 0.9, subject: r.subject || "mock subject", action: r.action || "mock action", setting: "mock", mood: "neutral",
        shotType: r.shotType || "medium", usable: r.usable !== false, issues: [], role: r.role || "filler" };
    })) };
  }

  // Browser: small JPEGs (512 px wide, base64 without the data: prefix) for the chosen times. One frame in memory at a time.
  async function captureFrames(file, times, { width = FRAME_WIDTH, quality = JPEG_QUALITY } = {}) {
    const v = document.createElement("video"), url = URL.createObjectURL(file); v.muted = true; v.preload = "auto"; v.src = url;
    try {
      await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error("cannot decode")); });
      const c = document.createElement("canvas"), out = [];
      for (const t of times) {
        await new Promise((res) => { v.onseeked = res; v.currentTime = t; });
        await new Promise((r) => requestAnimationFrame(() => r()));
        c.width = width; c.height = Math.max(16, Math.round(width * (v.videoHeight / v.videoWidth)));
        if (c.height > 640) { c.height = 640; c.width = Math.max(16, Math.round(640 * (v.videoWidth / v.videoHeight))); }
        c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
        let q = quality, data = c.toDataURL("image/jpeg", q).split(",")[1];
        while (data.length > MAX_IMAGE_B64 && q > 0.3) { q -= 0.1; data = c.toDataURL("image/jpeg", q).split(",")[1]; }
        out.push(data);
      }
      return out;
    } finally { v.removeAttribute("src"); try { v.load(); } catch (_) {} URL.revokeObjectURL(url); }
  }
  // Frames for a whole request, as [{id, data}] in request order.
  async function captureForRequest(files, req) {
    const images = [];
    for (const c of req.clips) { const data = await captureFrames(files[c.index], c.frames.map((f) => f.t)); c.frames.forEach((f, i) => images.push({ id: f.id, data: data[i] })); }
    return images;
  }

  // ================= v2 "timeline": one contact sheet per clip -> phase segments (Worker src/timeline.js) =================
  // The model sees evenly spaced, time-labelled tiles of the WHOLE clip, so it can tell setup from action and the operator
  // walking to the camera from the activity. Generic phases; no subject-specific rules.
  const PHASES = ["setup", "action", "peak", "rest", "ending", "transition", "handling", "irrelevant"];
  const SHEET_SIDE = 1024, SHEET_MAX_B64 = 300000, MAX_TILES = 30;
  // Tiles every ~1.5-2.5 s (8..MAX_TILES per clip), at tile centres, rounded to 0.1 s.
  function tileTimes(duration, max = MAX_TILES) {
    const n = Math.max(8, Math.min(max, Math.round(duration / 2)));
    return Array.from({ length: n }, (_, k) => Math.round(((k + 0.5) * duration / n) * 10) / 10).filter((t, k, a) => k === 0 || t > a[k - 1]);
  }
  function buildTimelineRequest(clips, { style, filmSeconds }) {
    return { version: 2, style, filmSeconds, clips: clips.map((c, ci) => ({ index: ci, duration: Math.round(c.duration * 10) / 10, sheet: "s" + ci, tiles: tileTimes(c.duration) })) };
  }
  // Grid that fits SHEET_SIDE: portrait clips get more columns. -> { cols, rows, tw, th }
  function sheetLayout(n, vw, vh, side = SHEET_SIDE) {
    let best = null;
    for (let cols = 2; cols <= 10; cols++) {
      const rows = Math.ceil(n / cols), tw = Math.floor(Math.min(side / cols, (side / rows) * (vw / vh))), th = Math.floor(tw * vh / vw);
      if (tw >= 48 && (!best || tw > best.tw)) best = { cols, rows, tw, th };
    }
    return best;
  }
  async function captureSheet(file, times) {
    const v = document.createElement("video"), url = URL.createObjectURL(file); v.muted = true; v.preload = "auto"; v.src = url;
    try {
      await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error("cannot decode")); });
      const L = sheetLayout(times.length, v.videoWidth, v.videoHeight), c = document.createElement("canvas");
      c.width = L.cols * L.tw; c.height = L.rows * L.th; const g = c.getContext("2d");
      g.fillStyle = "#000"; g.fillRect(0, 0, c.width, c.height); g.font = "bold " + Math.max(11, Math.round(L.tw / 9)) + "px sans-serif"; g.textBaseline = "top";
      for (let k = 0; k < times.length; k++) {
        await new Promise((res) => { v.onseeked = res; v.currentTime = times[k]; });
        await new Promise((r) => requestAnimationFrame(() => r()));
        const x = (k % L.cols) * L.tw, y = Math.floor(k / L.cols) * L.th, label = times[k].toFixed(1) + "s", lw = g.measureText(label).width + 6;
        g.drawImage(v, x, y, L.tw, L.th); g.fillStyle = "rgba(0,0,0,.65)"; g.fillRect(x, y, lw, Math.max(13, Math.round(L.tw / 9)) + 4); g.fillStyle = "#ff0"; g.fillText(label, x + 3, y + 2);
      }
      let q = 0.8, data = c.toDataURL("image/jpeg", q).split(",")[1];
      while (data.length > SHEET_MAX_B64 && q > 0.35) { q -= 0.1; data = c.toDataURL("image/jpeg", q).split(",")[1]; }
      return data;
    } finally { v.removeAttribute("src"); try { v.load(); } catch (_) {} URL.revokeObjectURL(url); }
  }
  async function captureSheets(files, req) {
    const images = [];
    for (const c of req.clips) images.push({ id: c.sheet, data: await captureSheet(files[c.index], c.tiles) });
    return images;
  }
  // Mirrors the Worker's validateTimelineOutput (the reply is untrusted even after the Worker checked it).
  function validateTimelineResponse(out, req) {
    if (!out || typeof out !== "object" || out.version !== 2 || !Array.isArray(out.clips)) return null;
    const unit = (x, d = 0.5) => (typeof x === "number" && Number.isFinite(x) ? clamp(x) : d), clips = [], seen = new Set();
    for (const c of out.clips) {
      const rc = c && Number.isInteger(c.index) && req.clips[c.index];
      if (!rc || seen.has(c.index) || !Array.isArray(c.segments)) continue;
      seen.add(c.index);
      const segs = c.segments.filter((s) => s && PHASES.includes(s.phase) && Number.isFinite(s.start) && Number.isFinite(s.end))
        .map((s) => ({ start: clamp(s.start, 0, rc.duration), end: clamp(s.end, 0, rc.duration), phase: s.phase, what: clean(s.what, 80), quality: unit(s.quality), importance: unit(s.importance) }))
        .filter((s) => s.end - s.start >= 0.2).sort((a, b) => a.start - b.start).slice(0, 24);
      for (let i = 1; i < segs.length; i++) if (segs[i].start < segs[i - 1].end) segs[i].start = segs[i - 1].end;
      const segments = segs.filter((s) => s.end - s.start >= 0.2);
      if (!segments.length || segments.reduce((a, s) => a + s.end - s.start, 0) < rc.duration * 0.5) continue;
      const moments = (Array.isArray(c.moments) ? c.moments : []).filter((m) => m && Number.isFinite(m.t) && m.t >= 0 && m.t <= rc.duration).slice(0, 3)
        .map((m) => ({ t: Math.round(m.t * 10) / 10, what: clean(m.what, 80), importance: unit(m.importance) }));
      clips.push({ index: c.index, summary: clean(c.summary, 140), segments, moments });
    }
    if (clips.length < Math.ceil(req.clips.length / 2)) return null;
    return { version: 2, story: clean(out.story, 200), clips: clips.sort((a, b) => a.index - b.index) };
  }
  // Phase -> how the planner should treat that footage. avoid: never used. role feeds the opener/highlight/closer ordering.
  const PHASE_RULE = {
    setup: { value: 0.45, role: "opener" }, action: { value: 0.75, role: "filler" }, peak: { value: 1, role: "highlight" }, rest: { value: 0.25, role: "filler" },
    ending: { value: 0.6, role: "closer" }, transition: { value: 0.3, role: "filler" }, handling: { avoid: true }, irrelevant: { avoid: true },
  };
  // Every sample inside a segment gets the segment's semantic judgement (sharp boundaries: the model saw the whole clip).
  // Model moments become key moments the planner seeds first. Unsegmented time keeps its local score only.
  function applyTimeline(analysed, tl) {
    analysed.forEach((clip) => { clip.samples.forEach((s) => { delete s.sem; }); clip.vision = []; clip.timeline = null; });
    for (const c of tl.clips) {
      const clip = analysed[c.index]; if (!clip) continue;
      clip.timeline = c;
      for (const s of clip.samples) {
        const seg = c.segments.find((g) => s.t >= g.start && (s.t < g.end || (g === c.segments[c.segments.length - 1] && s.t <= g.end)));
        if (!seg) continue;
        const r = PHASE_RULE[seg.phase], avoid = !!r.avoid || seg.quality < 0.25;
        const importance = avoid ? 0 : clamp(0.55 * r.value + 0.45 * seg.importance) * (0.5 + 0.5 * seg.quality);
        s.sem = { w: 0.85, importance, avoid, must: seg.phase === "peak", caption: seg.what, role: avoid ? "avoid" : r.role, conf: 0.85, phase: seg.phase };
      }
      // Key moments (and a confident setup/ending) seed the plan; only inside usable segments.
      const usable = (t) => { const g = c.segments.find((x) => t >= x.start && t < x.end); return g && !PHASE_RULE[g.phase].avoid && g.quality >= 0.25 ? g : null; };
      for (const m of c.moments) { const g = usable(m.t); if (g) clip.vision.push({ t: m.t, role: "highlight", importance: Math.max(m.importance, 0.6), confidence: 0.85 }); }
      for (const g of c.segments) if ((g.phase === "setup" || g.phase === "ending") && g.importance >= 0.5 && g.quality >= 0.5)
        clip.vision.push({ t: Math.round(((g.start + g.end) / 2) * 10) / 10, role: PHASE_RULE[g.phase].role, importance: g.importance, confidence: 0.75 });
    }
    return analysed;
  }
  // Deterministic stand-in for the model (tests/dev): segments from rules[clipIndex] = [[start, end, phase, importance?], ...].
  function mockTimeline(req, rules = {}) {
    return { version: 2, story: "mock timeline", clips: req.clips.map((c) => ({ index: c.index, summary: "mock clip " + c.index,
      segments: (rules[c.index] || [[0, c.duration, "action", 0.6]]).map(([start, end, phase, importance = 0.6, quality = 0.8]) => ({ start, end, phase, what: "mock " + phase, quality, importance })),
      moments: [] })) };
  }

  return { VERSION, MAX_FRAMES, PHASES, tileTimes, sheetLayout, buildTimelineRequest, captureSheets, validateTimelineResponse, applyTimeline, mockTimeline, chooseFrames, buildVisionRequest, validateVisionResponse, applyVision, mockVision, captureFrames, captureForRequest, frameIds };
});
