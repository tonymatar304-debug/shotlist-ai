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
const MAX_OUT = 2000, STYLE = process.env.STYLE || "cinematic", FILM = Number(process.env.FILM || 30);
const REPLAY = process.env.CLAQE_REPLAY; // replay a saved run (FREE): no browser, no Worker, no API call

const clips = process.argv.slice(2);
if (!REPLAY && clips.length < 2) { console.error("usage: node manual/real-vision.mjs <clipA> <clipB> [...]"); process.exit(2); }
const paid = process.env.CLAQE_CONFIRM_PAID === "yes";
if (paid && !(process.env.CLAQE_ENV_FILE && fs.existsSync(process.env.CLAQE_ENV_FILE))) { console.error("CLAQE_ENV_FILE must point to an existing env file"); process.exit(2); }

let prep;
if (REPLAY) prep = JSON.parse(fs.readFileSync(REPLAY, "utf8"));
else {
// 1) Real browser: analyse clips, choose frames, capture JPEGs (same code the page uses).
const web = staticServer(), port = await listen(web), browser = await launch(), page = await (await browser.newContext()).newPage();
await page.goto(`http://localhost:${port}/index.html`);
await page.route("**/sample/*", (r) => r.fulfill({ body: fs.readFileSync(clips[Number(new URL(r.request().url()).pathname.split("/").pop())]), contentType: "video/mp4" }));
prep = await page.evaluate(async ({ n, style, film }) => {
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
}

// ---------- comparison helpers (pure) ----------
const fmt = (p) => p.plan.map((x) => `c${x.src} ${x.start.toFixed(1)}+${x.duration.toFixed(1)}`).join("  ");
const near = (x, f, r = 1.5) => Math.max(0, Math.min(x.start + x.duration, f.t + r) - Math.max(x.start, f.t - r));
function metrics(p, vision, req, analysed) {
  const fr = vision ? vision.frames.map((f) => ({ ...f, ci: Number(f.id.slice(1, f.id.indexOf("f"))) })) : [];
  const secs = (roles) => p.plan.reduce((t, x) => t + fr.filter((f) => f.ci === x.src && roles.includes(f.role)).reduce((a, f) => a + near(x, f), 0), 0);
  const scenes = new Set(p.plan.map((x) => { const sc = A.sceneRanges(analysed[x.src]); return x.src + ":" + sc.findIndex((r) => x.start >= r.start - 0.01 && x.start < r.end); }));
  const lens = p.plan.map((x) => x.duration), first = p.plan[0], last = p.plan[p.plan.length - 1];
  return { shots: p.plan.length, meanLen: +(p.total / p.plan.length).toFixed(2), lens: lens.join(","), total: p.total,
    perClip: req.clips.map((c) => +p.plan.filter((x) => x.src === c.index).reduce((t, x) => t + x.duration, 0).toFixed(1)).join("/"),
    scenesUsed: scenes.size, highlightSecs: +secs(["highlight"]).toFixed(1), avoidSecs: vision ? +avoidedSecs(p, vision, req, analysed).toFixed(1) : 0,
    clipSequence: p.plan.map((x) => x.src).filter((v, i, a) => !i || a[i - 1] !== v).join(""),
    roleSequence: p.plan.map((x) => ({ opener: "O", highlight: "H", closer: "C", filler: "f" })[x.role] || "-").join(""),
    progressionsKept: analysed.map((c, ci) => (A.clipStory(c).progression ? p.plan.filter((x) => x.src === ci).every((x, i, a) => !i || x.start > a[i - 1].start) : null)).filter((x) => x !== null).every(Boolean),
    opensOnOpener: !!first && fr.some((f) => f.ci === first.src && f.role === "opener" && near(first, f, 1) > 0),
    endsOnCloser: !!last && fr.some((f) => f.ci === last.src && f.role === "closer" && near(last, f, 1) > 0) };
}
function avoidedSecs(p, vision, req, analysed) {
  const an = JSON.parse(JSON.stringify(analysed)); V.applyVision(an, req, vision);
  return p.plan.reduce((t, x) => t + an[x.src].samples.filter((q) => q.sem && q.sem.avoid && q.t >= x.start && q.t < x.start + x.duration).length, 0); // ~1 s per sample
}
const sharedSecs = (a, b) => a.plan.reduce((t, x) => t + b.plan.filter((y) => y.src === x.src).reduce((u, y) => u + Math.max(0, Math.min(x.start + x.duration, y.start + y.duration) - Math.max(x.start, y.start)), 0), 0);
// order change at film level: share of clip pairs whose first appearance swaps between the two plans (0 = same order, 1 = reversed)
function orderChange(a, b) {
  const fa = new Map(), fb = new Map(); a.plan.forEach((x, i) => fa.has(x.src) || fa.set(x.src, i)); b.plan.forEach((x, i) => fb.has(x.src) || fb.set(x.src, i));
  const ids = [...fa.keys()].filter((k) => fb.has(k)); let n = 0, d = 0;
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) { n++; if (Math.sign(fa.get(ids[i]) - fa.get(ids[j])) !== Math.sign(fb.get(ids[i]) - fb.get(ids[j]))) d++; }
  return n ? +(d / n).toFixed(2) : 0;
}
const clone = (o) => JSON.parse(JSON.stringify(o));
function compare(vision) {
  for (const style of ["cinematic", "dynamic", "vintage"]) {
    const local = A.planFilm(clone(prep.analysed), style, FILM);
    console.log(`\n[${style}] local: ${fmt(local)}`);
    let ai = null;
    if (vision) { const an = clone(prep.analysed); V.applyVision(an, prep.request, vision); ai = A.planFilm(an, style, FILM); console.log(`[${style}] AI   : ${fmt(ai)}`); console.log("   AI reasons:", ai.plan.map((x) => x.reason).join(" | ")); }
    console.log("   local metrics:", JSON.stringify(metrics(local, vision, prep.request, prep.analysed)));
    if (ai) { console.log("   AI metrics   :", JSON.stringify(metrics(ai, vision, prep.request, prep.analysed))); console.log(`   same footage in both: ${sharedSecs(local, ai).toFixed(1)} of ${local.total}s; same order: ${fmt(local) === fmt(ai)}; clip-order change ${orderChange(local, ai)}; AI plan uses roles: ${ai.semantic}`); }
  }
}

const imgTokens = prep.dims.reduce((t, [w, h]) => t + Math.ceil(w / 28) * Math.ceil(h / 28), 0);
const estIn = imgTokens + 900; // + system prompt and per-frame labels (approx.)
console.log(`clips: ${prep.request.clips.map((c) => c.duration + "s").join(", ")}; film ${FILM}s`);
console.log(`frames: ${prep.request.clips.reduce((n, c) => n + c.frames.length, 0)} (max ${V.MAX_FRAMES}); sizes ${[...new Set(prep.dims.map((d) => d.join("x")))].join(", ")}`);
console.log(`estimate: ~${estIn} input tokens (${imgTokens} image), <= ${MAX_OUT} output -> <= $${((estIn * PRICE_IN + MAX_OUT * PRICE_OUT) / 1e6).toFixed(5)} per film`);
console.log("frame times:", prep.request.clips.map((c) => `clip${c.index}: ` + c.frames.map((f) => f.t).join(",")).join(" | "));
if (REPLAY) { const v = V.validateVisionResponse(prep.vision, prep.request); console.log("story:", v.story); compare(v); process.exit(0); }
if (!paid && process.env.CLAQE_SAVE_DRY) { fs.mkdirSync(path.join(here, "runs"), { recursive: true }); fs.writeFileSync(path.join(here, "runs", "dry.json"), JSON.stringify({ request: prep.request, dims: prep.dims, analysed: prep.analysed })); console.log("saved manual/runs/dry.json (no images, no AI)"); }
if (!paid) { compare(null); console.log("\nDRY RUN: no request sent. Set CLAQE_CONFIRM_PAID=yes and CLAQE_ENV_FILE to make ONE paid call."); process.exit(0); }

// 2) ONE real call through the local Worker (real /vision code path, local D1, test Turnstile). The run is saved for free replays.
const w = await startWorker({ turnstileSecret: TS.ALWAYS_PASS, envFile: process.env.CLAQE_ENV_FILE });
try {
  const c = client(w.base);
  if ((await c.call("/pass", { method: "POST", json: { turnstileToken: TS.TOKEN } })).status !== 200) throw new Error("pass failed");
  const t0 = Date.now(), r = await c.call("/vision", { method: "POST", json: { request: prep.request, images: prep.images } });
  console.log(`\n/vision -> ${r.status} in ${Date.now() - t0} ms`, r.data.code || "");
  const [row] = w.sql("SELECT model, input_tokens, output_tokens, cost_usd, status, error FROM usage_log ORDER BY id DESC LIMIT 1");
  console.log("usage:", row, `actual cost $${((row.input_tokens * PRICE_IN + row.output_tokens * PRICE_OUT) / 1e6).toFixed(5)}`);
  if (r.status !== 200) process.exit(1);
  const v = V.validateVisionResponse(r.data.vision, prep.request);
  const out = path.join(here, "runs"); fs.mkdirSync(out, { recursive: true });
  const file = path.join(out, "run-" + new Date().toISOString().replace(/[:.]/g, "-") + ".json");
  fs.writeFileSync(file, JSON.stringify({ request: prep.request, dims: prep.dims, analysed: prep.analysed, vision: r.data.vision, usage: row }));
  console.log("saved for free replay:", path.relative(process.cwd(), file));
  console.log("story:", v.story);
  for (const f of v.frames) console.log(` ${f.id} t=${f.t}s imp=${f.importance} conf=${f.confidence} role=${f.role} shot=${f.shotType} | ${f.subject} | ${f.action} | ${f.setting}`);
  compare(v);
} finally { await w.stop(); }
