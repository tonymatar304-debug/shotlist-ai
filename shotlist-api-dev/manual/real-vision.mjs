// MANUAL, PAID (when confirmed): one controlled real Claude Haiku 5.5 vision call through a LOCAL Worker (wrangler dev --local).
// Not part of `npm test`. Nothing is deployed; local D1 only; Turnstile uses Cloudflare's test secret.
//
// Dry run (default, FREE): analyses the sample clips, picks frames, captures JPEGs and prints the exact request size + cost estimate.
//   node manual/real-vision.mjs <clipA.mp4> <clipB.mp4>
// Paid run (ONE request, only after approval):
//   CLAQE_CONFIRM_PAID=yes CLAQE_ENV_FILE=<path to a file containing ANTHROPIC_API_KEY=...> node manual/real-vision.mjs <clipA> <clipB>
// The key file is read by wrangler only; this script never opens, logs or forwards it. Keep that file outside the repo.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startWorker, client, TS } from "../test/helpers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url)), repo = path.join(here, "..", "..");
const req = createRequire(import.meta.url);
const A = req(path.join(repo, "claqe-analyze.js")), V = req(path.join(repo, "claqe-vision.js"));
const { staticServer, listen, launch } = await import(pathToFileURL(path.join(repo, "tests", "e2e", "lib.mjs")).href);
const PRICE_IN = 0.10, PRICE_OUT = 0.50; // USD / MTok, Claude Haiku 5.5, prompts <= 100K tokens (pricing page checked 2026-11-14)
const MAX_OUT = 900, STYLE = process.env.STYLE || "cinematic", FILM = 20;

const clips = process.argv.slice(2);
if (clips.length < 2) { console.error("usage: node manual/real-vision.mjs <clipA> <clipB> [...]"); process.exit(2); }
const paid = process.env.CLAQE_CONFIRM_PAID === "yes";
if (paid && !(process.env.CLAQE_ENV_FILE && fs.existsSync(process.env.CLAQE_ENV_FILE))) { console.error("CLAQE_ENV_FILE must point to an existing env file"); process.exit(2); }

// 1) Real browser: analyse clips, choose frames, capture JPEGs (same code the page uses).
const web = staticServer(), port = await listen(web), browser = await launch(), page = await (await browser.newContext()).newPage();
await page.goto(`http://localhost:${port}/index.html`);
await page.route("**/sample/*", (r) => r.fulfill({ body: fs.readFileSync(clips[Number(new URL(r.request().url()).pathname.split("/").pop())]), contentType: "video/mp4" }));
const prep = await page.evaluate(async ({ n, style, film }) => {
  const files = [], analysed = [];
  for (let i = 0; i < n; i++) {
    const f = new File([await (await fetch("/sample/" + i)).arrayBuffer()], "clip" + i + ".mp4", { type: "video/mp4" });
    const d = await new Promise((r) => { const v = document.createElement("video"); v.src = URL.createObjectURL(f); v.onloadedmetadata = () => r(v.duration); });
    files.push(f); analysed.push(await ClaqeAnalyze.analyzeClip(f, d));
  }
  ClaqeAnalyze.planFilm(analysed, style, film); // scores samples
  const request = ClaqeVision.buildVisionRequest(analysed, { style, filmSeconds: film });
  const images = await ClaqeVision.captureForRequest(files, request);
  const dims = await Promise.all(images.map((im) => new Promise((r) => { const g = new Image(); g.onload = () => r([g.width, g.height]); g.src = "data:image/jpeg;base64," + im.data; })));
  return { analysed, request, images, dims };
}, { n: clips.length, style: STYLE, film: FILM });
await browser.close(); web.close();

const imgTokens = prep.dims.reduce((t, [w, h]) => t + Math.ceil(w / 28) * Math.ceil(h / 28), 0);
const estIn = imgTokens + 900; // + system prompt and per-frame labels (approx.)
console.log(`frames: ${prep.images.length} (max ${V.MAX_FRAMES}); sizes ${[...new Set(prep.dims.map((d) => d.join("x")))].join(", ")}; JPEG total ${Math.round(prep.images.reduce((n, i) => n + i.data.length * 0.75, 0) / 1024)} KB`);
console.log(`estimate: ~${estIn} input tokens (${imgTokens} image), <= ${MAX_OUT} output -> <= $${((estIn * PRICE_IN + MAX_OUT * PRICE_OUT) / 1e6).toFixed(5)} per film`);
console.log("frame times:", prep.request.clips.map((c) => `clip${c.index}: ` + c.frames.map((f) => f.t).join(",")).join(" | "));
if (!paid) { console.log("\nDRY RUN: no request sent. Set CLAQE_CONFIRM_PAID=yes and CLAQE_ENV_FILE to make ONE paid call."); process.exit(0); }

// 2) ONE real call through the local Worker (real /vision code path, local D1, test Turnstile).
const w = await startWorker({ turnstileSecret: TS.ALWAYS_PASS, envFile: process.env.CLAQE_ENV_FILE });
try {
  const c = client(w.base);
  if ((await c.call("/pass", { method: "POST", json: { turnstileToken: TS.TOKEN } })).status !== 200) throw new Error("pass failed");
  const t0 = Date.now(), r = await c.call("/vision", { method: "POST", json: { request: prep.request, images: prep.images } });
  console.log(`\n/vision -> ${r.status} in ${Date.now() - t0} ms`, r.data.code || "");
  const [row] = w.sql("SELECT model, input_tokens, output_tokens, cost_usd, status FROM usage_log ORDER BY id DESC LIMIT 1");
  console.log("usage:", row, `actual cost $${((row.input_tokens * PRICE_IN + row.output_tokens * PRICE_OUT) / 1e6).toFixed(5)}`);
  if (r.status !== 200) process.exit(1);
  const v = V.validateVisionResponse(r.data.vision, prep.request);
  console.log("story:", v.story);
  for (const f of v.frames) console.log(` ${f.id} t=${f.t}s imp=${f.importance} conf=${f.confidence} role=${f.role} shot=${f.shotType} | ${f.subject} | ${f.action} | ${f.setting}`);
  const analysed = prep.analysed; V.applyVision(analysed, prep.request, v);
  const plan = A.planFilm(analysed, STYLE, FILM);
  console.log("\nplan:", plan.plan.map((p) => `clip${p.src} ${p.start}+${p.duration} [${p.reason}]`).join("\n      "));
} finally { await w.stop(); }
