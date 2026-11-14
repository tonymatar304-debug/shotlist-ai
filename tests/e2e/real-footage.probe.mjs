// Dev probe (not in npm test): analyse real clips from REAL_DIR and print timelines + plans per style. Run: REAL_DIR=... node e2e/real-footage.probe.mjs
import fs from "node:fs"; import path from "node:path";
import { staticServer, listen, launch } from "./lib.mjs";
const dir = process.env.REAL_DIR, files = fs.readdirSync(dir).filter((f) => /\.(mp4|webm|mov)$/i.test(f));
const web = staticServer(), port = await listen(web), browser = await launch(), page = await (await browser.newContext()).newPage();
await page.goto(`http://localhost:${port}/index.html`);
await page.route("**/rf/*", (r) => r.fulfill({ body: fs.readFileSync(path.join(dir, decodeURIComponent(new URL(r.request().url()).pathname.split("/").pop()))), contentType: "video/mp4" }));
const out = await page.evaluate(async (files) => {
  const res = [];
  for (const n of files) {
    const file = new File([await (await fetch("/rf/" + n)).arrayBuffer()], n, { type: "video/mp4" });
    const dur = await new Promise((r) => { const v = document.createElement("video"); v.src = URL.createObjectURL(file); v.onloadedmetadata = () => r(v.duration); });
    const t0 = performance.now(); const a = await ClaqeAnalyze.analyzeClip(file, dur);
    res.push({ n, dur, ms: Math.round(performance.now() - t0), a });
  }
  return res;
}, files);
const A = (await import("../../claqe-analyze.js")).default;
for (const r of out) {
  console.log(`\n== ${r.n}  ${r.dur.toFixed(1)}s  analysed in ${r.ms} ms, ${r.a.samples.length} samples`);
  const c = { duration: r.dur, samples: r.a.samples }; A.scoreClip(c, "dynamic");
  console.log(r.a.samples.map((s) => `${s.t.toFixed(1)}:${s.interest.toFixed(2)}${s.scene > A.SCENE_T ? "*CUT" : ""}`).join(" "));
}
const clips = () => out.map((r) => ({ duration: r.dur, samples: JSON.parse(JSON.stringify(r.a.samples)) }));
for (const film of [20]) for (const style of ["cinematic", "dynamic", "vintage"]) {
  const p = A.planFilm(clips(), style, film);
  console.log(`\n-- ${style} (${film}s): ` + p.plan.map((x) => `${out[x.src].n.slice(0, 6)} ${x.start}+${x.duration} [${x.reason}]`).join(" | "));
}
await browser.close(); web.close();
