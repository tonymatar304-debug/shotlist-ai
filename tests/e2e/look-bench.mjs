// FREE manual visual benchmark: render real clips per style, then measure the finished film.
// Per shot (middle frame): luma, colour cast, saturation -> shot-to-shot spread (visual consistency).
// Per cut: luma of the frames either side vs the shot middles (a fade-to-black shows up as a dip).
// Also: FFmpeg time, peak Edge memory, and a contact sheet PNG per style.
// Usage: node e2e/look-bench.mjs <outDir> <clip.mp4> <clip.mp4> ...   (STYLES=cinematic,dynamic,vintage  FORMAT=vertical|horizontal)
import fs from "node:fs";
import path from "node:path";
import { staticServer, listen, launch, routeRealFfmpeg, treeMB, rootPid } from "./lib.mjs";

const [outDir, ...clips] = process.argv.slice(2);
const styles = (process.env.STYLES || "cinematic,dynamic,vintage").split(",");
fs.mkdirSync(outDir, { recursive: true });
const web = staticServer(), port = await listen(web);
const sd = (a) => { const m = a.reduce((s, x) => s + x, 0) / a.length; return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length); };
const f3 = (x) => x.toFixed(3);
const summary = {};
for (const style of styles) {
  const browser = await launch(), pid = rootPid();
  const ctx = await browser.newContext(); await routeRealFfmpeg(ctx);
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${port}/index.html`);
  if (process.env.FORMAT === "horizontal") await page.click('button[data-format="horizontal"]').catch(() => {});
  await page.click(`button[data-style="${style}"]`);
  await page.evaluate(() => { window.__exec = []; let t0 = 0; new MutationObserver(() => { const s = document.getElementById("status").textContent; if (/^Making your film/.test(s)) t0 = performance.now(); else if (/^Film ready/.test(s) && t0) { window.__exec.push(performance.now() - t0); t0 = 0; } }).observe(document.getElementById("status"), { childList: true, characterData: true, subtree: true }); });
  await page.setInputFiles("#clips", clips);
  await page.waitForFunction(() => !document.getElementById("create").disabled, null, { timeout: 60000 });
  const base = pid ? treeMB(pid) : NaN; let peak = base, polling = true;
  const poll = (async () => { while (polling) { if (pid) peak = Math.max(peak, treeMB(pid)); await new Promise((r) => setTimeout(r, 300)); } })();
  await page.click("#create");
  await page.waitForFunction(() => /Film ready|Export failed/.test(document.getElementById("status").textContent) && document.getElementById("download").href, null, { timeout: 900000 });
  polling = false; await poll;
  const r = await page.evaluate(async () => {
    const plan = window.__claqeLast.plan, frames = plan.map((p) => Math.max(1, Math.round(p.duration * 24)));
    const film = new Uint8Array(await (await fetch(document.getElementById("download").href)).arrayBuffer());
    const base = "https://cdn.jsdelivr.net/npm/", blob = async (u, t) => URL.createObjectURL(new Blob([await (await fetch(u)).arrayBuffer()], { type: t }));
    const ff = new window.FFmpegWASM.FFmpeg();
    await ff.load({ coreURL: await blob(base + "@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.js", "text/javascript"), wasmURL: await blob(base + "@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.wasm", "application/wasm") });
    await ff.writeFile("f.mp4", film.slice()); // a copy: writeFile transfers (detaches) the buffer to the worker
    const at = []; let s = 0; for (const n of frames) { at.push({ first: s, mid: s + (n >> 1), last: s + n - 1 }); s += n; }
    const want = [...new Set(at.flatMap((a) => [a.first, a.mid, a.last]))].sort((a, b) => a - b), W = 64, H = 36;
    const sel = (list) => "select='" + list.map((n) => "eq(n," + n + ")").join("+") + "'";
    await ff.exec(["-i", "f.mp4", "-vf", sel(want) + ",scale=" + W + ":" + H, "-vsync", "0", "-f", "rawvideo", "-pix_fmt", "rgb24", "o.rgb"]);
    const raw = await ff.readFile("o.rgb"), px = W * H, stat = {};
    want.forEach((n, k) => {
      let R = 0, G = 0, B = 0, Y = 0, S = 0;
      for (let i = 0; i < px; i++) { const o = (k * px + i) * 3, r = raw[o] / 255, g = raw[o + 1] / 255, b = raw[o + 2] / 255;
        R += r; G += g; B += b; Y += 0.2126 * r + 0.7152 * g + 0.0722 * b; S += Math.max(r, g, b) - Math.min(r, g, b); }
      stat[n] = { Y: Y / px, R: R / px, G: G / px, B: B / px, S: S / px };
    });
    await ff.exec(["-i", "f.mp4", "-vf", sel(at.map((a) => a.mid)) + ",scale=120:-2,tile=" + at.length + "x1", "-frames:v", "1", "sheet.png"]);
    const png = await ff.readFile("sheet.png"); let b64 = ""; for (let i = 0; i < png.length; i += 0x8000) b64 += String.fromCharCode.apply(null, png.subarray(i, i + 0x8000));
    let fb = ""; for (let i = 0; i < film.length; i += 0x8000) fb += String.fromCharCode.apply(null, film.subarray(i, i + 0x8000));
    return { plan: plan.map((p) => ({ src: p.src, start: p.start, duration: p.duration })), at, stat, sheet: btoa(b64), film: btoa(fb), exec: window.__exec.at(-1), status: document.getElementById("status").textContent.slice(0, 30) };
  });
  fs.writeFileSync(path.join(outDir, style + "-sheet.png"), Buffer.from(r.sheet, "base64"));
  fs.writeFileSync(path.join(outDir, style + ".mp4"), Buffer.from(r.film, "base64"));
  const mids = r.at.map((a) => r.stat[a.mid]);
  const castRB = mids.map((m) => m.R - m.B), castG = mids.map((m) => m.G - (m.R + m.B) / 2);
  // Cut dip: darker of the two frames touching each internal cut, relative to the darker of the two shot middles (1 = no dip).
  const dips = r.at.slice(1).map((a, i) => Math.min(r.stat[r.at[i].last].Y, r.stat[a.first].Y) / Math.max(0.02, Math.min(mids[i].Y, mids[i + 1].Y)));
  const row = { exec: r.exec / 1000, peakMB: peak, deltaMB: peak - base, shots: mids.length, sdY: sd(mids.map((m) => m.Y)), sdCast: Math.hypot(sd(castRB), sd(castG)),
    meanSat: mids.reduce((s, m) => s + m.S, 0) / mids.length, maxSat: Math.max(...mids.map((m) => m.S)), minCutRatio: Math.min(...dips),
    firstY: r.stat[r.at[0].first].Y, lastY: r.stat[r.at.at(-1).last].Y };
  summary[style] = row;
  console.log(`\n${style}: ${r.status} | ffmpeg ${row.exec.toFixed(1)} s | peak ${row.peakMB.toFixed(0)} MB (+${row.deltaMB.toFixed(0)}) | ${row.shots} shots`);
  mids.forEach((m, i) => console.log(`  shot ${i + 1} clip ${r.plan[i].src + 1} @${r.plan[i].start}s ${r.plan[i].duration}s  Y ${f3(m.Y)}  R-B ${f3(castRB[i])}  G-mag ${f3(castG[i])}  sat ${f3(m.S)}${i ? `  cut ${f3(dips[i - 1])}` : ""}`));
  console.log(`  spread: luma sd ${f3(row.sdY)}, cast sd ${f3(row.sdCast)}; sat mean ${f3(row.meanSat)} max ${f3(row.maxSat)}; worst cut ratio ${f3(row.minCutRatio)}; first frame Y ${f3(row.firstY)}, last ${f3(row.lastY)}`);
  await browser.close();
}
fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
web.close();
