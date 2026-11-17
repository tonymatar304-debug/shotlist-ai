// MANUAL, PAID (only when confirmed): the v2 "timeline" vision call (one contact sheet per clip -> phase segments) through a
// LOCAL Worker (wrangler dev --local, local D1, Turnstile test secret). Not part of `npm test`. Nothing is deployed.
//
// Dry run (default, FREE): analyses the clips in the real page, builds the request, captures the contact sheets, saves them as
// JPEGs next to the request and prints the size + a cost estimate per model.
//   OUT=<folder outside the repo> node manual/real-timeline.mjs <clipA> <clipB> [...]
// Paid run (ONE request per model, only after approval). The reply works for every style (the planner applies the style):
//   CLAQE_CONFIRM_PAID=yes CLAQE_ENV_FILE=<file with ANTHROPIC_API_KEY=...> MODELS=claude-haiku-5-5,claude-sonnet-5-5 OUT=<folder> node manual/real-timeline.mjs <clips...>
// The key file is read by wrangler only; this script never opens, logs or forwards it.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startWorker, client, TS } from "../test/helpers.mjs";
import { PRICES, TL_MAX_TOKENS } from "../src/timeline.js";

const here = path.dirname(fileURLToPath(import.meta.url)), repo = path.join(here, "..", "..");
const V = createRequire(import.meta.url)(path.join(repo, "claqe-vision.js"));
const { staticServer, listen, launch } = await import(pathToFileURL(path.join(repo, "tests", "e2e", "lib.mjs")).href);
const clips = process.argv.slice(2), OUT = process.env.OUT || path.join(here, "runs"), STYLE = process.env.STYLE || "dynamic";
const MODELS = (process.env.MODELS || "claude-haiku-5-5").split(",").filter(Boolean);
if (clips.length < 2) { console.error("usage: node manual/real-timeline.mjs <clipA> <clipB> [...]"); process.exit(2); }
for (const m of MODELS) if (!PRICES[m]) { console.error("unknown or unpriced model: " + m); process.exit(2); }
const paid = process.env.CLAQE_CONFIRM_PAID === "yes";
if (paid && !(process.env.CLAQE_ENV_FILE && fs.existsSync(process.env.CLAQE_ENV_FILE))) { console.error("CLAQE_ENV_FILE must point to an existing env file"); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });

// 1) Real page: analysis + request + contact sheets (FREE).
const web = staticServer(), port = await listen(web), browser = await launch(), page = await (await browser.newContext()).newPage();
let prep;
try {
  await page.goto(`http://localhost:${port}/index.html`);
  await page.evaluate((n) => { for (let i = 0; i < n; i++) { const e = document.createElement("input"); e.type = "file"; e.id = "rt" + i; document.body.append(e); } }, clips.length);
  for (let i = 0; i < clips.length; i++) await page.setInputFiles("#rt" + i, clips[i]);
  prep = await page.evaluate(async ({ n, style }) => {
    const files = [], analysed = [];
    for (let i = 0; i < n; i++) { const f = document.getElementById("rt" + i).files[0], v = document.createElement("video"); v.src = URL.createObjectURL(f); await new Promise((r) => (v.onloadedmetadata = r)); files.push(f); analysed.push(await ClaqeAnalyze.analyzeClip(f, v.duration)); }
    const request = ClaqeVision.buildTimelineRequest(analysed, { style, filmSeconds: 30 });
    const images = await ClaqeVision.captureSheets(files, request);
    return { request, images, analysed };
  }, { n: clips.length, style: STYLE });
} finally { await browser.close(); web.close(); }
fs.writeFileSync(path.join(OUT, "timeline-request.json"), JSON.stringify({ request: prep.request, analysed: prep.analysed }));
const dims = prep.images.map((im) => { const b = Buffer.from(im.data, "base64"); fs.writeFileSync(path.join(OUT, `sheet-${im.id}.jpg`), b);
  for (let i = 2; i < b.length - 9;) { if (b[i] !== 0xff) { i++; continue; } const m = b[i + 1]; if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)]; i += 2 + b.readUInt16BE(i + 2); } return [0, 0]; });
const imgTokens = dims.reduce((a, [w, h]) => a + Math.ceil((w * h) / 750), 0), estIn = imgTokens + 1400;
console.log(`clips ${prep.request.clips.length}; tiles ${prep.request.clips.map((c) => c.tiles.length).join("/")}; sheets ${dims.map((d) => d.join("x")).join(", ")}; body ${(JSON.stringify(prep.images).length / 1024).toFixed(0)} KB`);
for (const m of MODELS) { const [pi, po] = PRICES[m], maxOut = /haiku/.test(m) ? TL_MAX_TOKENS : TL_MAX_TOKENS * 3;
  console.log(`${m}: ~${estIn} input tokens (${imgTokens} image), ~2500 output (cap ${maxOut}) -> ~$${((estIn * pi + 2500 * po) / 1e6).toFixed(4)}, at most $${((estIn * pi + maxOut * po) / 1e6).toFixed(4)}`); }
console.log("sheets saved in", OUT);
if (!paid) { console.log("\nDRY RUN: no request sent. Set CLAQE_CONFIRM_PAID=yes and CLAQE_ENV_FILE to make one paid call per model."); process.exit(0); }

// 2) One real call per model through the local Worker (real /vision v2 code path). Replies are saved for free replays.
let total = 0;
for (const model of MODELS) {
  const w = await startWorker({ turnstileSecret: TS.ALWAYS_PASS, envFile: process.env.CLAQE_ENV_FILE, vars: { VISION_MODEL: model } });
  try {
    const c = client(w.base);
    if ((await c.call("/pass", { method: "POST", json: { turnstileToken: TS.TOKEN } })).status !== 200) throw new Error("pass failed");
    const t0 = Date.now(), r = await c.call("/vision", { method: "POST", json: { request: prep.request, images: prep.images } });
    const [row] = w.sql("SELECT model, input_tokens, output_tokens, cost_usd, status, error FROM usage_log ORDER BY id DESC LIMIT 1");
    total += row.cost_usd || 0;
    console.log(`\n${model}: /vision -> ${r.status} in ${((Date.now() - t0) / 1000).toFixed(1)} s ${r.data.code || ""} | tokens in ${row.input_tokens} out ${row.output_tokens} | $${(row.cost_usd || 0).toFixed(4)} | ${row.status} ${row.error || ""}`);
    if (r.status !== 200) continue;
    const v = V.validateTimelineResponse(r.data.vision, prep.request);
    fs.writeFileSync(path.join(OUT, `timeline-${model}.json`), JSON.stringify({ model, usage: row, vision: v }, null, 1));
    console.log("story:", v.story);
    for (const cl of v.clips) { console.log(` clip ${cl.index}: ${cl.summary}`); for (const s of cl.segments) console.log(`   ${s.start.toFixed(1)}-${s.end.toFixed(1)} ${s.phase} q${s.quality} i${s.importance} | ${s.what}`); for (const m of cl.moments) console.log(`   moment ${m.t}s i${m.importance} | ${m.what}`); }
  } finally { await w.stop(); }
}
console.log(`\ntotal cost $${total.toFixed(4)}`);
