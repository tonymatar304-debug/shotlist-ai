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
  function applyVision(analysed, req, vision) {
    const byId = new Map(vision.frames.map((f) => [f.id, f]));
    analysed.forEach((clip, ci) => {
      clip.samples.forEach((s) => { delete s.sem; });
      for (const rf of req.clips[ci].frames) {
        const f = byId.get(rf.id); if (!f) continue;
        const avoid = f.role === "avoid" || !f.usable || f.shotType === "title";
        for (const s of clip.samples) {
          const dt = Math.abs(s.t - rf.t); if (dt > 2.5) continue;
          const lo = Math.min(s.t, rf.t), hi = Math.max(s.t, rf.t);
          if (clip.samples.some((x) => x.t > lo && x.t <= hi && x.scene > 0.3)) continue; // different scene
          const w = (1 - dt / 2.5) * (0.4 + 0.6 * f.confidence);
          if (!s.sem || w > s.sem.w) s.sem = { w, importance: 0.5 + (f.importance - 0.5) * w, avoid: avoid && f.confidence >= 0.4, must: f.role === "highlight" || f.role === "opener", caption: caption(f), role: f.role };
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

  return { VERSION, MAX_FRAMES, chooseFrames, buildVisionRequest, validateVisionResponse, applyVision, mockVision, captureFrames, captureForRequest, frameIds };
});
