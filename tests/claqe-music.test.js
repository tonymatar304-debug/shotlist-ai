// Local audio helpers: loudness levelling, beat detection on synthetic music (generated here, no third-party audio), beat-aware cuts.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const M = require("../claqe-music.js");

const SR = 22050;
let seed = 7; const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
function track(dur, hits, { pad = 0.1, noise = 0.02 } = {}) { // kick-like hits (sine 80 Hz + click) over a soft pad
  const x = new Float32Array(Math.round(dur * SR));
  for (let i = 0; i < x.length; i++) x[i] = pad * Math.sin(2 * Math.PI * 220 * i / SR) + noise * rnd();
  for (const h of hits) { const s = Math.round(h * SR); for (let i = 0; i < 0.15 * SR && s + i < x.length; i++) { const e = Math.exp(-i / (0.03 * SR)); x[s + i] += 0.6 * e * Math.sin(2 * Math.PI * 80 * i / SR) + (i < 0.004 * SR ? 0.4 * rnd() : 0); } }
  return x;
}
const grid = (bpm, off, dur) => { const o = []; for (let t = off; t < dur - 0.2; t += 60 / bpm) o.push(t); return o; };
const nearest = (arr, t) => arr.reduce((b, x) => (Math.abs(x - t) < Math.abs(b - t) ? x : b), Infinity);

for (const [bpm, off] of [[120, 0.23], [95, 0.6], [140, 0.1]]) {
  test(`beats: steady ${bpm} BPM track -> tempo and every beat within 15 ms`, () => {
    const truth = grid(bpm, off, 20), r = M.detectBeats(track(20, truth), SR);
    assert.equal(r.kind, "beats", JSON.stringify({ kind: r.kind, conf: r.confidence }));
    assert.ok(Math.abs(r.tempo - bpm) / bpm < 0.03, "tempo " + r.tempo);
    const ts = r.beats.map((b) => b.t), inner = truth.filter((t) => t > 1 && t < 19);
    const errs = inner.map((t) => Math.abs(nearest(ts, t) - t));
    assert.ok(errs.filter((e) => e <= 0.015).length >= 0.95 * inner.length, "errors ms " + JSON.stringify(errs.map((e) => Math.round(e * 1000))));
  });
}
test("beats: noise only -> no beat grid claimed", () => {
  const r = M.detectBeats(track(15, [], { pad: 0, noise: 0.3 }), SR);
  assert.equal(r.kind, "none", "confidence " + r.confidence + " " + r.beats.length);
});
test("beats: irregular hits -> rhythmic accents at those hits", () => {
  const hits = [1.1, 2.9, 3.6, 6.2, 8.8, 9.5, 12.3], r = M.detectBeats(track(15, hits, { pad: 0.05, noise: 0.01 }), SR);
  assert.ok(r.beats.length >= 5, JSON.stringify(r));
  for (const h of hits) assert.ok(Math.abs(nearest(r.beats.map((b) => b.t), h) - h) < 0.02, "hit " + h);
});

test("loudness: parses FFmpeg ebur128 summary", () => {
  const log = "Summary:\n  Integrated loudness:\n    I:         -23.4 LUFS\n    Threshold: -33.6 LUFS\n  Sample peak:\n    Peak:       -3.2 dBFS";
  assert.deepEqual(M.parseLoudness(log), { I: -23.4, peak: -3.2 });
  assert.equal(M.parseLoudness("nothing"), null);
  assert.deepEqual(M.parseLoudness("t: 0.1 M: -120 S: -120 I: -70.0 LUFS LRA: 0 LU\n" + log), { I: -23.4, peak: -3.2 }); // per-frame lines ignored
  assert.deepEqual(M.parseLoudness("I:         -inf LUFS\nPeak:       -inf dBFS"), { I: -Infinity, peak: -Infinity });
});
test("levelling: conservative, bounded, never boosts silence, never pushes peaks past -1 dBFS", () => {
  const g = M.levelGains([{ I: -14, peak: -1 }, { I: -34, peak: -20 }, { I: -23, peak: -6 }, null, { I: -70, peak: -50 }]);
  assert.equal(g.target, -23);
  assert.deepEqual(g.clips, [-9, 8, 0, 0, 0]); // loud clip down 9 dB, quiet clip up (capped at +8), close one untouched, silent ones untouched
  assert.deepEqual(M.levelGains([{ I: -20, peak: -1 }, { I: -21.5, peak: -2 }]).clips, [0, 0]); // < 2 dB apart: no change
  assert.deepEqual(M.levelGains([{ I: -20, peak: -1 }, { I: -30, peak: -3 }, { I: -20, peak: -1 }]).clips, [0, 2, 0]); // +10 wanted, peak allows +2
  const m = M.levelGains([{ I: -20, peak: -2 }], { I: -10, peak: -0.5 });
  assert.equal(m.musicGain, -16); // music bed 6 dB under the clips
  assert.equal(M.levelGains([null], { I: -30, peak: -12 }).musicGain, 6); // silent clips: music is the soundtrack (-16 LUFS, +6 cap)
  assert.equal(M.levelGains([null], { I: -9, peak: 0 }).musicGain, -7);
});

const clipsInfo = [{ duration: 20, cuts: [9], avoid: [] }, { duration: 12, cuts: [], avoid: [7.5] }, { duration: 6 }];
const plan0 = () => [
  { src: 0, start: 1, duration: 5 }, { src: 1, start: 2, duration: 5, moment: 6 }, { src: 2, start: 0.5, duration: 4 },
  { src: 0, start: 10, duration: 6 }, { src: 1, start: 8, duration: 3.5 }];
const BEATS = grid(120, 0.23, 40).map((t, i) => ({ t, strength: i % 4 === 0 ? 1 : 0.5 }));
test("beat cuts: cuts move onto beats, film never longer, shots stay inside clips/scenes, story moment kept", () => {
  for (const style of ["cinematic", "dynamic", "vintage"]) {
    const p0 = plan0(), r = M.alignToBeats(p0, clipsInfo, BEATS, { film: 30, style });
    assert.ok(r.aligned >= 3, style + " aligned " + r.aligned);
    let t = 0; const total0 = p0.reduce((s, p) => s + p.duration, 0), total = r.plan.reduce((s, p) => s + p.duration, 0);
    assert.ok(total <= total0 + 1e-9 && total >= total0 - 1 / 24 - 1e-9, style + " total " + total);
    r.plan.forEach((p, k) => {
      t += p.duration; const c = clipsInfo[p.src], end = p.start + p.duration;
      assert.ok(Math.abs(p.duration * 24 - Math.round(p.duration * 24)) < 1e-6, "whole frames");
      assert.ok(p.duration >= 1 && end <= c.duration - 0.05 + 1e-9, "inside clip " + JSON.stringify(p));
      assert.ok(!(c.cuts || []).some((x) => x > p.start && x < end), "crosses a scene cut " + JSON.stringify(p));
      assert.ok(!(c.avoid || []).some((x) => x > p.start - 0.3 && x < end + 0.3 - 1e-9) || p.start + p0[k].duration > 7.2, "avoid frame " + JSON.stringify(p));
      if (p.moment) assert.ok(end >= p.moment + 0.4 - 1e-9, "moment kept");
      if (k < r.plan.length - 1 && r.cuts.length) {
        const off = Math.abs(nearest(BEATS.map((b) => b.t), t) - t);
        if (r.cuts.some((c) => Math.abs(c - t) < 1e-6)) assert.ok(off <= 1 / 48 + 1e-9, "cut " + t + " off beat by " + off);
      }
    });
    // same clip shots never overlap
    r.plan.forEach((p, i) => r.plan.forEach((q, j) => { if (i < j && p.src === q.src) assert.ok(p.start + p.duration <= q.start + 1e-9 || q.start + q.duration <= p.start + 1e-9, "overlap"); }));
  }
});
test("beat cuts: no beats / one shot -> plan unchanged; tolerance differs by style", () => {
  const p = plan0();
  assert.equal(M.alignToBeats(p, clipsInfo, [], {}).plan, p);
  assert.equal(M.alignToBeats([p[0]], clipsInfo, BEATS, {}).plan.length, 1);
  const far = [{ t: 5.45, strength: 1 }, { t: 30, strength: 1 }]; // 0.45 s after the first cut
  assert.equal(M.alignToBeats(plan0(), clipsInfo, far, { style: "dynamic" }).aligned, 0);
  assert.equal(M.alignToBeats(plan0(), clipsInfo, far, { style: "cinematic" }).aligned, 1);
});
