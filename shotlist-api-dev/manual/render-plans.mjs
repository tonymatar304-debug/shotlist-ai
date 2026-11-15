// FREE: render local-only vs AI-assisted plans from a saved run with the REAL CLAQE page renderer (FFmpeg.wasm in Edge).
// No Worker, no API call. Usage: node manual/render-plans.mjs <run.json> <clip0> <clip1> ... [STYLES=cinematic,dynamic,vintage]
// Output: manual/runs/videos/<style>-<local|ai>.mp4 (git-ignored).
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url)), repo = path.join(here, "..", "..");
const req = createRequire(import.meta.url), A = req(path.join(repo, "claqe-analyze.js")), V = req(path.join(repo, "claqe-vision.js"));
const { staticServer, listen, launch, routeRealFfmpeg } = await import(pathToFileURL(path.join(repo, "tests", "e2e", "lib.mjs")).href);
const [runFile, ...clips] = process.argv.slice(2);
const run = JSON.parse(fs.readFileSync(runFile, "utf8")), FILM = Number(process.env.FILM || 30);
const styles = (process.env.STYLES || "cinematic,dynamic,vintage").split(",");
const vision = run.vision ? V.validateVisionResponse(run.vision, run.request) : null;
const out = path.join(here, "runs", "videos"); fs.mkdirSync(out, { recursive: true });

const jobs = [];
for (const style of styles) {
  jobs.push({ name: `${style}-local`, style, plan: A.planFilm(JSON.parse(JSON.stringify(run.analysed)), style, FILM).plan });
  if (vision) { const an = JSON.parse(JSON.stringify(run.analysed)); V.applyVision(an, run.request, vision); jobs.push({ name: `${style}-ai`, style, plan: A.planFilm(an, style, FILM).plan }); }
}
const web = staticServer(), port = await listen(web), browser = await launch();
try {
  for (const job of jobs) {
    const ctx = await browser.newContext({ acceptDownloads: true }); await routeRealFfmpeg(ctx);
    // the page's own planner is replaced by the precomputed plan; everything else (renderer, grading, watermark) is unchanged
    await ctx.addInitScript((p) => { window.CLAQE_LIMITS = { filmSeconds: 30 }; window.__fixedPlan = p; }, job.plan);
    const page = await ctx.newPage(); await page.goto(`http://localhost:${port}/index.html`);
    await page.evaluate(() => { const orig = window.ClaqeAnalyze.planFilm; window.ClaqeAnalyze.planFilm = (c, s, f) => ({ ...orig(c, s, f), plan: window.__fixedPlan }); });
    await page.setInputFiles("#clips", clips);
    await page.waitForFunction(() => !document.getElementById("create").disabled, null, { timeout: 30000 });
    await page.click(`button[data-style="${job.style}"]`);
    const t0 = Date.now(); await page.click("#create");
    await page.waitForFunction(() => /Film ready|Export failed/.test(document.getElementById("status").textContent), null, { timeout: 600000 });
    const status = await page.textContent("#status");
    if (!/Film ready/.test(status)) { console.log(job.name, "FAILED:", status.slice(0, 160)); await ctx.close(); continue; }
    const b64 = await page.evaluate(async () => { const b = new Uint8Array(await (await fetch(document.getElementById("download").href)).arrayBuffer()); let s = ""; for (let i = 0; i < b.length; i += 32768) s += String.fromCharCode(...b.subarray(i, i + 32768)); return btoa(s); });
    const file = path.join(out, job.name + ".mp4"); fs.writeFileSync(file, Buffer.from(b64, "base64"));
    console.log(`${job.name}: ${((Date.now() - t0) / 1000).toFixed(0)} s render, ${Math.round(fs.statSync(file).size / 1024)} KB -> ${path.relative(process.cwd(), file)}`);
    console.log("   shots:", job.plan.map((x) => `c${x.src} ${x.start}+${x.duration}${x.role ? " " + x.role : ""}`).join(" | "));
    await ctx.close();
  }
} finally { await browser.close(); web.close(); }
