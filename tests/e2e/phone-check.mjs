// FREE local check for a REAL phone recording (see docs/PHONE_FOOTAGE_TESTING.md). Renders the clip through the real app
// (sequential renderer, style look neutralised, no shot matching), prints what CLAQE detected (HDR/SDR, codec, rotation, VFR),
// and compares one frame of CLAQE's film with a trusted SDR reference of the same recording (e.g. the phone's own SDR export).
// Without a reference, an SDR clip is compared with itself (must be ~unchanged); an HDR clip only gets its frame saved.
// Usage: node e2e/phone-check.mjs <original> [reference-sdr] [outDir]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { staticServer, listen, launch, routeRealFfmpeg } from "./lib.mjs";
import { lab, dE2000 } from "./phone-chart.mjs";

const [orig, refArg, outArg] = process.argv.slice(2);
if (!orig) { console.log("usage: node e2e/phone-check.mjs <original> [reference-sdr] [outDir]"); process.exit(1); }
const out = outArg || path.join(os.tmpdir(), "claqe-phone-check"); fs.mkdirSync(out, { recursive: true });
const web = staticServer(), port = await listen(web), browser = await launch(), ctx = await browser.newContext(); await routeRealFfmpeg(ctx);
const page = await ctx.newPage(); page.on("console", (m) => /CLAQE/.test(m.text()) && console.log("  console: " + m.text().slice(0, 160)));
await page.addInitScript(() => { window.CLAQE_MATCH = false; });
await page.goto(`http://localhost:${port}/index.html`);
await page.evaluate(() => { window.ClaqeLook.lookFilter = () => "null"; }); // neutral: no style grade
await page.evaluate(() => { for (const id of ["a", "b"]) { const i = document.createElement("input"); i.type = "file"; i.id = "pc_" + id; document.body.append(i); } });
await page.setInputFiles("#pc_a", [orig]); if (refArg) await page.setInputFiles("#pc_b", [refArg]);
await page.click('button[data-format="landscape"]'); // 640x360 film; the reference is fitted the same way
await page.setInputFiles("#clips", [orig, orig]); // CLAQE needs 2+ clips; the first shot is what gets measured
// Wait until Create is enabled, or every clip is measured and CLAQE refused the selection (e.g. a clip over 60 s).
await page.waitForFunction(() => !document.getElementById("create").disabled
  || (document.querySelectorAll("#files li").length > 0 && !/Checking…/.test(document.getElementById("files").textContent)), null, { timeout: 120000 });
if (await page.$eval("#create", (b) => b.disabled)) {
  console.log(`\n${path.basename(orig)}: not accepted by CLAQE\n  note: ` + await page.$eval("#renderNote", (e) => e.textContent));
  await browser.close(); web.close(); process.exit(2);
}
const t0 = Date.now(); await page.click("#create");
await page.waitForFunction(() => /Film ready|Export failed/.test(document.getElementById("status").textContent), null, { timeout: 900000 });
const secs = (Date.now() - t0) / 1000;
const info = await page.evaluate(() => ({ status: document.getElementById("status").textContent.slice(0, 160), note: document.getElementById("resultNote").textContent,
  renderer: window.__claqeLast && window.__claqeLast.renderer, video: window.__claqeLast && window.__claqeLast.video[0], cluts: window.__claqeLast && window.__claqeLast.cluts,
  shot: window.__claqeLast && window.__claqeLast.plan[0], loud: window.__claqeLast && window.__claqeLast.loudness[0] }));
console.log(`\n${path.basename(orig)}: ${info.status}\n  render ${secs.toFixed(1)} s, renderer ${info.renderer}`);
console.log("  detected: " + JSON.stringify(info.video));
console.log("  audio: " + (info.loud ? JSON.stringify(info.loud) + " (decoded and levelled)" : "none or not decodable (film is silent for this clip)"));
console.log("  note: " + info.note);
if (!/Film ready/.test(info.status)) { await browser.close(); web.close(); process.exit(1); }
// One frame, 0.6 s into the first shot (after the fade-in), from CLAQE's film and from the reference at the same source time.
const te = Math.min(0.6, info.shot.duration / 2), ts = info.shot.start + te;
const res = await page.evaluate(async ({ te, ts, hasRef, sdr }) => {
  const base = "https://cdn.jsdelivr.net/npm/", blob = async (u, t) => URL.createObjectURL(new Blob([await (await fetch(u)).arrayBuffer()], { type: t }));
  const ff = new window.FFmpegWASM.FFmpeg(); await ff.load({ coreURL: await blob(base + "@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.js", "text/javascript"), wasmURL: await blob(base + "@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.wasm", "application/wasm") });
  await ff.writeFile("film.mp4", new Uint8Array(await (await fetch(document.getElementById("download").href)).arrayBuffer()));
  const fit = "scale=640:360:force_original_aspect_ratio=increase,crop=640:360,setsar=1";
  const grab = async (args, name) => { await ff.exec(["-y", "-v", "error", ...args, "-frames:v", "1", "-vf", fit + ",format=rgb24", "-f", "rawvideo", name]); return ff.readFile(name); };
  const ours = await grab(["-ss", String(te), "-i", "film.mp4"], "a.rgb");
  let ref = null, refName = null;
  const src = hasRef ? document.getElementById("pc_b").files[0] : sdr ? document.getElementById("pc_a").files[0] : null;
  if (src) { await ff.createDir("/r"); await ff.mount("WORKERFS", { blobs: [{ name: "ref", data: src }] }, "/r"); ref = await grab(["-ss", String(ts), "-i", "/r/ref"], "b.rgb"); refName = src.name; }
  // side-by-side PNG (CLAQE | reference)
  const pngArgs = ref ? ["-f", "rawvideo", "-pix_fmt", "rgb24", "-s", "640x360", "-i", "a.rgb", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", "640x360", "-i", "b.rgb", "-filter_complex", "hstack"]
    : ["-f", "rawvideo", "-pix_fmt", "rgb24", "-s", "640x360", "-i", "a.rgb"];
  await ff.exec(["-y", "-v", "error", ...pngArgs, "-frames:v", "1", "out.png"]);
  const png = await ff.readFile("out.png"); let s = ""; for (let i = 0; i < png.length; i += 0x8000) s += String.fromCharCode.apply(null, png.subarray(i, i + 0x8000));
  return { ours: Array.from(ours), ref: ref && Array.from(ref), refName, png: btoa(s) };
}, { te, ts, hasRef: !!refArg, sdr: !info.video || !info.video.hdr });
const pngPath = path.join(out, path.basename(orig).replace(/\.\w+$/, "") + "-frame.png"); fs.writeFileSync(pngPath, Buffer.from(res.png, "base64"));
console.log(`  frame at ${te.toFixed(2)} s of the film (source ${ts.toFixed(2)} s) -> ${pngPath}` + (res.ref ? " (left CLAQE, right reference)" : ""));
if (res.ref) {
  // 20 x 11 grid of 32x32 block averages (tolerates the shot's slight zoom), Delta E 2000 per block, plus mean channel shifts.
  const blocks = (px) => { const o = []; for (let by = 0; by < 11; by++) for (let bx = 0; bx < 20; bx++) { const s = [0, 0, 0]; for (let y = by * 32 + 4; y < by * 32 + 28; y++) for (let x = bx * 32 + 4; x < bx * 32 + 28; x++) for (let c = 0; c < 3; c++) s[c] += px[(y * 640 + x) * 3 + c]; o.push(s.map((v) => v / 576 / 255)); } return o; };
  const a = blocks(res.ours), b = blocks(res.ref), d = a.map((x, i) => dE2000(lab(x), lab(b[i]))).sort((p, q) => p - q);
  const shift = [0, 1, 2].map((c) => Math.round((a.reduce((s, x) => s + x[c], 0) - b.reduce((s, x) => s + x[c], 0)) / a.length * 255));
  console.log(`  vs ${res.refName}: dE2000 mean ${(d.reduce((s, x) => s + x, 0) / d.length).toFixed(2)}, median ${d[d.length >> 1].toFixed(2)}, p95 ${d[Math.floor(d.length * 0.95)].toFixed(2)}; mean RGB shift ${JSON.stringify(shift)} (CLAQE - reference, 0..255)`);
  console.log("  guide: mean < 3 very close, 3-6 noticeable side by side, > 6 clearly different (check the PNG)");
}
await browser.close(); web.close();
