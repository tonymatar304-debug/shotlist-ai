// FREE manual benchmark: single-pass vs sequential renderer through the real app (fixed plan, full pipeline incl. grading,
// audio, watermark). Per run: whole Edge tree peak MB (page + FFmpeg worker/WASM heap + MEMFS files), FFmpeg time,
// intermediate size, and quality (PSNR/SSIM of each output vs the single-pass output of the same plan).
// Usage: node e2e/render-bench.mjs <clip.mp4> [shots=1,4,8,16] [modes=single,sequential,sequential-visual] [repeat=1]
import fs from "node:fs";
import path from "node:path";
import { staticServer, listen, launch, routeRealFfmpeg, treeMB, rootPid } from "./lib.mjs";

const [clip, shotsArg = "1,4,8,16", modesArg = "single,sequential,sequential-visual", repeatArg = "1"] = process.argv.slice(2);
const web = staticServer(), port = await listen(web);
const ref = {};
for (const n of shotsArg.split(",").map(Number)) {
  // n shots of 1.8 s (16 shots = 28.8 s, inside the 30 s film limit), starts spread over the first 6 s of the clip
  const plan = Array.from({ length: n }, (_, i) => ({ src: i % 2, start: Math.round(((i * 1.3) % 6) * 100) / 100, duration: 1.8 }));
  for (const mode of modesArg.split(",")) {
    const browser = await launch(), pid = rootPid(), ctx = await browser.newContext(); await routeRealFfmpeg(ctx);
    const page = await ctx.newPage();
    await page.addInitScript(({ mode, plan }) => {
      window.CLAQE_RENDER = mode.startsWith("sequential") ? "sequential" : "single";
      if (mode === "sequential-visual") window.CLAQE_INTERMEDIATE = "visual";
      if (mode.endsWith("-lazy")) window.CLAQE_LAZY = true; // WORKERFS: FFmpeg reads the File instead of an in-memory copy
      window.__fixedPlan = plan;
    }, { mode, plan });
    page.on("console", (m) => /sequential render failed|CLAQE sequential:/.test(m.text()) && console.log("  FALLBACK " + m.text().slice(0, 200)));
    await page.goto(`http://localhost:${port}/index.html`);
    await page.evaluate(() => { const o = window.ClaqeAnalyze.planFilm; window.ClaqeAnalyze.planFilm = (...a) => ({ ...o(...a), plan: window.__fixedPlan }); });
    await page.click('button[data-style="dynamic"]');
    await page.evaluate(() => { window.__exec = []; let t0 = 0; new MutationObserver(() => { const s = document.getElementById("status").textContent; if (/^Making your film/.test(s) && !t0) t0 = performance.now(); else if (/^Film ready/.test(s) && t0) { window.__exec.push(performance.now() - t0); t0 = 0; } }).observe(document.getElementById("status"), { childList: true, characterData: true, subtree: true }); });
    await page.setInputFiles("#clips", [clip, clip]); // the same clip twice (CLAQE needs 2+ clips); shots alternate between them
    await page.waitForFunction(() => !document.getElementById("create").disabled, null, { timeout: 120000 });
    const base = treeMB(pid);
    for (let round = 1; round <= +repeatArg; round++) {
      const before = await page.getAttribute("#download", "href");
      let peak = treeMB(pid), polling = true;
      const poll = (async () => { while (polling) { peak = Math.max(peak, treeMB(pid)); await new Promise((r) => setTimeout(r, 250)); } })();
      await page.click("#create");
      await page.waitForFunction((b) => /Film ready|Export failed/.test(document.getElementById("status").textContent) && document.getElementById("download").href !== b, before, { timeout: 1800000 });
      polling = false; await poll;
      await new Promise((r) => setTimeout(r, 1500));
      const after = treeMB(pid);
      const r = await page.evaluate(async () => {
        const film = new Uint8Array(await (await fetch(document.getElementById("download").href)).arrayBuffer());
        let b = ""; for (let i = 0; i < film.length; i += 0x8000) b += String.fromCharCode.apply(null, film.subarray(i, i + 0x8000));
        return { status: document.getElementById("status").textContent.slice(0, 20), exec: window.__exec.at(-1), renderer: window.__claqeLast.renderer, kb: window.__claqeLast.intermediateKB || 0, film: btoa(b) };
      });
      const film = Buffer.from(r.film, "base64");
      let q = "";
      if (round === 1) {
        if (mode === "single") ref[n] = film;
        else if (ref[n]) {
          q = await page.evaluate(async ({ a, b }) => {
            const base = "https://cdn.jsdelivr.net/npm/", blob = async (u, t) => URL.createObjectURL(new Blob([await (await fetch(u)).arrayBuffer()], { type: t }));
            const ff = new window.FFmpegWASM.FFmpeg(), log = []; ff.on("log", ({ message }) => log.push(message));
            await ff.load({ coreURL: await blob(base + "@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.js", "text/javascript"), wasmURL: await blob(base + "@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.wasm", "application/wasm") });
            const bin = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
            await ff.writeFile("a.mp4", bin(a)); await ff.writeFile("b.mp4", bin(b));
            await ff.exec(["-v", "info", "-i", "a.mp4", "-i", "b.mp4", "-lavfi", "[0:v][1:v]ssim;[0:v][1:v]psnr", "-f", "null", "nul"]);
            ff.terminate();
            const ssim = log.map((l) => /SSIM .*All:([\d.]+)/.exec(l)).filter(Boolean).pop(), psnr = log.map((l) => /PSNR .*average:([\d.inf]+)/.exec(l)).filter(Boolean).pop();
            return `SSIM ${ssim ? ssim[1] : "?"} PSNR ${psnr ? psnr[1] : "?"} dB vs single`;
          }, { a: ref[n].toString("base64"), b: r.film });
        }
      }
      console.log(`${path.basename(clip).slice(0, 14)} ${String(n).padStart(2)} shots ${mode.padEnd(17)} r${round}: ${r.status.startsWith("Film ready") ? "ok" : r.status} [${r.renderer}] ffmpeg ${(r.exec / 1000).toFixed(1)} s | tree base ${base.toFixed(0)} MB, peak ${peak.toFixed(0)} MB (+${(peak - base).toFixed(0)}), after ${after.toFixed(0)} | intermediates ${(r.kb / 1024).toFixed(1)} MB | output ${(film.length / 1048576).toFixed(2)} MB ${q}`);
    }
    await browser.close();
  }
}
web.close();
