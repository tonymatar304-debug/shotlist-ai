// FREE manual benchmark: HDR -> SDR tone-mapping candidates on the phone fixtures, scored against the standards-based
// chart reference (phone-chart.mjs). Per candidate: Delta E 2000 of grey / colour / skin patches (vs the expected BT.709
// value), highlight luma (must rise monotonically, not clip early), highlight hue error, and FFmpeg time per 640x360 frame.
// Also reports how Edge itself renders the HDR clip (browser HDR->SDR) when it can decode HEVC.
// Usage: node e2e/tonemap-bench.mjs [fixture=hlg-prores-4s.mov,pq-prores-4s.mov,sdr10-prores-4s.mov,hlg-prores-portrait-4s.mov]
import fs from "node:fs";
import path from "node:path";
import { staticServer, listen, launch, routeRealFfmpeg, FIXTURES } from "./lib.mjs";
import { W, H, COLS, PW, PH, PATCHES, lab, dE2000 } from "./phone-chart.mjs";
import { createRequire } from "node:module";
const ClaqeColor = createRequire(import.meta.url)("../../claqe-color.js");

const fixtures = (process.argv[2] || "hlg-prores-4s.mov,pq-prores-4s.mov,sdr10-prores-4s.mov,hlg-prores-portrait-4s.mov").split(",");
const tm = (op, npl, param = null, desat = 0) => (info) => ClaqeColor.toneMapFilter(info, { op, npl, param, desat });
const CANDIDATES = {
  "none (current)": () => "format=yuv420p",
  "clip npl203": tm("clip", 203), "hable npl100": tm("hable", 100), "hable npl203": tm("hable", 203),
  "reinhard npl203": tm("reinhard", 203, 0.5), "mobius npl203 j0.3": tm("mobius", 203, 0.3), "mobius npl203 j0.5": tm("mobius", 203, 0.5),
  "CLAQE default": (info) => ClaqeColor.toneMapFilter(info),
};
const web = staticServer(), port = await listen(web), browser = await launch(), ctx = await browser.newContext(); await routeRealFfmpeg(ctx);
const page = await ctx.newPage(); await page.goto(`http://localhost:${port}/index.html`);
await page.evaluate(async () => {
  const base = "https://cdn.jsdelivr.net/npm/", blob = async (u, t) => URL.createObjectURL(new Blob([await (await fetch(u)).arrayBuffer()], { type: t }));
  const ff = new window.FFmpegWASM.FFmpeg(); window.__log = []; ff.on("log", (e) => window.__log.push(e.message));
  await ff.load({ coreURL: await blob(base + "@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.js", "text/javascript"), wasmURL: await blob(base + "@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.wasm", "application/wasm") });
  window.__b = ff;
});
const exec = (args) => page.evaluate(async (args) => { window.__log = []; const t0 = performance.now(); const code = await window.__b.exec(args); return { code, ms: performance.now() - t0, log: window.__log.join("\n") }; }, args);
const readRaw = (f) => page.evaluate(async (f) => Array.from(await window.__b.readFile(f)), f);
// Average full-range RGB of each patch's centre (rgb24 frame of W x H).
const samplePatches = (px) => PATCHES.map((_, i) => { const cx = (i % COLS) * PW + PW / 2, cy = Math.floor(i / COLS) * PH + PH / 2, s = [0, 0, 0]; let n = 0;
  for (let y = cy - 20; y < cy + 20; y++) for (let x = cx - 20; x < cx + 20; x++) { for (let c = 0; c < 3; c++) s[c] += px[(y * W + x) * 3 + c]; n++; } return s.map((v) => v / n / 255); });
const hue = ([r, g, b]) => (Math.atan2(Math.sqrt(3) * (g - b), 2 * r - g - b) * 180) / Math.PI;
function score(rgb) {
  const de = (f) => PATCHES.map((p, i) => (p.sdr && f(p) ? dE2000(lab(p.sdr), lab(rgb[i])) : null)).filter((x) => x !== null);
  const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length, grey = de((p) => /^grey/.test(p.name)), col = de((p) => !/^grey/.test(p.name) && !p.skin), skin = de((p) => p.skin);
  const hi = PATCHES.map((p, i) => [p, rgb[i]]).filter(([p]) => p.hi), luma = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const ramp = hi.filter(([p]) => /^highlight/.test(p.name)).map(([, c]) => luma(c));
  const hueErr = hi.filter(([p]) => /sunset|sky/.test(p.name)).map(([p, c]) => Math.round(Math.abs(((hue(c) - hue(p.hi) + 540) % 360) - 180)));
  const greys = PATCHES.map((p, i) => [p, rgb[i]]).filter(([p]) => /^grey/.test(p.name)).map(([, c]) => Math.round(luma(c) * 255));
  return { greys, grey: +avg(grey).toFixed(2), greyMax: +Math.max(...grey).toFixed(2), colour: +avg(col).toFixed(2), skin: skin.map((x) => +x.toFixed(2)),
    rampLuma: ramp.map((x) => Math.round(x * 255)), rampMonotonic: ramp.every((x, i) => !i || x >= ramp[i - 1] - 0.002), hueErrDeg: hueErr,
    clippedHi: hi.filter(([, c]) => Math.max(...c) > 0.995).length };
}
const toRgb = "scale=in_color_matrix=bt709:in_range=tv:out_range=pc:flags=neighbor,format=rgb24";
for (const fx of fixtures) {
  const bytes = fs.readFileSync(path.join(FIXTURES, fx));
  await page.evaluate(async ({ b64, fx }) => { const s = atob(b64), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); await window.__b.writeFile(fx, u); }, { b64: bytes.toString("base64"), fx });
  await exec(["-v", "error", "-i", fx, "-frames:v", "1", "-f", "null", "-"]);
  const pr = await page.evaluate(async (fx) => { await window.__b.ffprobe(["-v", "error", "-select_streams", "v:0", "-show_streams", "-show_entries", "stream_side_data_list", "-of", "json", fx, "-o", "p.json"]); return new TextDecoder().decode(await window.__b.readFile("p.json")); }, fx);
  const info = ClaqeColor.describe(JSON.parse(pr));
  console.log(`\n== ${fx}: hdr=${info.hdr} ${info.codec} ${info.profile} ${info.pixFmt} ${info.primaries}/${info.transfer}/${info.matrix} rot=${info.rotation}`);
  for (const [name, f] of Object.entries(CANDIDATES)) {
    const chain = f(info) || "format=yuv420p";
    const r = await exec(["-y", "-v", "error", "-ss", "0.2", "-i", fx, "-frames:v", "1", "-vf", chain + "," + toRgb, "-f", "rawvideo", "out.rgb"]);
    if (r.code !== 0) { console.log(`  ${name.padEnd(20)} FAILED ${r.log.slice(-200)}`); continue; }
    const s = score(samplePatches(await readRaw("out.rgb")));
    // speed: 48 frames at the app's working size (640x360)
    const t = await exec(["-y", "-v", "error", "-i", fx, "-frames:v", "48", "-vf", "scale=640:360," + chain, "-f", "null", "-"]);
    console.log(`  ${name.padEnd(20)} greys ${JSON.stringify(s.greys)} dE grey ${s.grey} (max ${s.greyMax}) colour ${s.colour} skin ${JSON.stringify(s.skin)} | highlights ${JSON.stringify(s.rampLuma)} mono=${s.rampMonotonic} clipped=${s.clippedHi} hueErr ${JSON.stringify(s.hueErrDeg)}° | ${(t.ms / 48).toFixed(1)} ms/frame`);
  }
  // Fast path: CLAQE default baked into a Hald CLUT once, applied per frame.
  if (info.hdr) {
    const mk = await exec(["-v", "error", ...ClaqeColor.clutCommand(info, "clut.png")]);
    const g = (pre) => `[0:v]${pre}null[src];` + ClaqeColor.clutFilter(info, "src", "1:v", "o");
    const r = await exec(["-y", "-v", "error", "-ss", "0.2", "-i", fx, "-i", "clut.png", "-frames:v", "1", "-filter_complex", g("") + `;[o]${toRgb}[rgb]`, "-map", "[rgb]", "-f", "rawvideo", "out.rgb"]);
    if (mk.code || r.code) console.log(`  CLUT FAILED ${(mk.log + r.log).slice(-300)}`);
    else {
      const s = score(samplePatches(await readRaw("out.rgb")));
      const t = await exec(["-y", "-v", "error", "-i", fx, "-i", "clut.png", "-frames:v", "48", "-filter_complex", g("scale=640:360,"), "-map", "[o]", "-f", "null", "-"]);
      console.log(`  ${"CLAQE default, CLUT".padEnd(20)} dE grey ${s.grey} (max ${s.greyMax}) colour ${s.colour} skin ${JSON.stringify(s.skin)} | highlights ${JSON.stringify(s.rampLuma)} mono=${s.rampMonotonic} clipped=${s.clippedHi} hueErr ${JSON.stringify(s.hueErrDeg)}° | ${(t.ms / 48).toFixed(1)} ms/frame (CLUT build ${mk.ms.toFixed(0)} ms)`);
    }
  }
  // Browser reference: Edge's own HDR -> SDR rendering of the same clip (needs an HEVC decoder in this browser).
  const br = await page.evaluate(async ({ b64, W, H }) => {
    const s = atob(b64), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
    const v = document.createElement("video"); v.muted = true; v.src = URL.createObjectURL(new Blob([u], { type: "video/mp4" }));
    const ok = await new Promise((r) => { v.onloadeddata = () => r(true); v.onerror = () => r(false); setTimeout(() => r(false), 8000); });
    if (!ok) return { decodes: false, canPlay: v.canPlayType('video/mp4; codecs="hvc1.2.4.L120.B0"') };
    v.currentTime = 0.2; await new Promise((r) => (v.onseeked = r));
    const c = document.createElement("canvas"); c.width = W; c.height = H; const g = c.getContext("2d"); g.drawImage(v, 0, 0, W, H);
    const d = g.getImageData(0, 0, W, H).data, px = new Array(W * H * 3); for (let i = 0, j = 0; i < d.length; i += 4) { px[j++] = d[i]; px[j++] = d[i + 1]; px[j++] = d[i + 2]; }
    if (!px.some((x) => x > 8)) return { decodes: false, canPlay: "black frame (codec not decoded: " + v.canPlayType('video/quicktime; codecs="apco"') + ")" };
    return { decodes: true, px };
  }, { b64: bytes.toString("base64"), W, H });
  if (!br.decodes) console.log(`  Edge's own rendering: cannot decode this clip here (canPlayType HEVC: "${br.canPlay}")`);
  else { const s = score(samplePatches(br.px)); console.log(`  ${"Edge's own rendering".padEnd(20)} dE grey ${s.grey} (max ${s.greyMax}) colour ${s.colour} skin ${JSON.stringify(s.skin)} | highlights ${JSON.stringify(s.rampLuma)} clipped=${s.clippedHi} hueErr ${JSON.stringify(s.hueErrDeg)}°`); }
}
await browser.close(); web.close();
