// STRESS / capacity tests (slow, minutes): progressively larger real H.264 files through the real renderer in real Edge.
// Not part of `npm test`. Run: cd tests && npm run stress   (env STRESS_MB="30,50,80,120" to choose sizes)
// Sources are generated in-page with FFmpeg.wasm (noisy test pattern, so file size tracks bitrate) and attached via DataTransfer.
// Memory = summed working set of the Playwright-launched Edge processes (Windows; approximate, shared pages double-counted).
// Output: a results table on stdout (lines starting "# ").
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { staticServer, listen, launch, routeRealFfmpeg } from "./lib.mjs";

const SIZES = (process.env.STRESS_MB || "30,50,80,120").split(",").map(Number);
const LAZY = process.env.LAZY === "1"; // LAZY=1 -> WORKERFS lazy source access (window.CLAQE_LAZY)
let web, port, browser;
before(async () => { web = staticServer(); port = await listen(web); browser = await launch(); });
after(async () => { await browser?.close(); web?.close(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function workingSetMB() {
  return new Promise((res) => execFile("powershell.exe", ["-NoProfile", "-Command",
    "(Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { $_.CommandLine -like '*playwright*' } | Measure-Object -Property WorkingSetSize -Sum).Sum"],
    (e, out) => res(Number(String(out).trim()) / 1048576 || 0)));
}
function startMemorySampler(page) {
  let peak = 0, heap = 0, stop = false;
  const heapLoop = (async () => { while (!stop) { try { heap = Math.max(heap, await page.evaluate(() => (performance.memory ? performance.memory.usedJSHeapSize / 1048576 : 0))); } catch {} await sleep(500); } })();
  const done = (async () => { while (!stop) { peak = Math.max(peak, await workingSetMB()); await sleep(1000); } })();
  return { async stop() { stop = true; await Promise.all([done, heapLoop]); return { peak: Math.round(peak), heap: Math.round(heap) }; } };
}

async function newPage() {
  const ctx = await browser.newContext();
  // Lift ONLY the render size gates so we can measure beyond the shipped limits.
  await ctx.addInitScript(() => { window.CLAQE_LIMITS = { renderMaxSize: 1e12, renderMaxTotal: 1e12, maxSize: 1e12, maxTotal: 1e12 }; });
  if (LAZY) await ctx.addInitScript(() => { window.CLAQE_LAZY = true; });
  await routeRealFfmpeg(ctx);
  const page = await ctx.newPage();
  page.crashed = false; page.on("crash", () => (page.crashed = true));
  await page.goto(`http://localhost:${port}/index.html`);
  return { ctx, page };
}

// Generate a real source clip inside the page: window.__gen[name] = File.
async function generate(page, name, { w, h, secs, mbps, audio = false }) {
  const t0 = Date.now();
  const size = await page.evaluate(async ({ name, w, h, secs, mbps, audio }) => {
    const base = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd/";
    const blob = async (u, t) => URL.createObjectURL(new Blob([await (await fetch(u)).arrayBuffer()], { type: t }));
    const ff = new window.FFmpegWASM.FFmpeg();
    await ff.load({ coreURL: await blob(base + "ffmpeg-core.js", "text/javascript"), wasmURL: await blob(base + "ffmpeg-core.wasm", "application/wasm") });
    const args = ["-f", "lavfi", "-i", `testsrc2=s=${w}x${h}:r=24:d=${secs}`];
    if (audio) args.push("-f", "lavfi", "-i", `sine=frequency=440:d=${secs}`);
    args.push("-vf", "noise=alls=25:allf=t", "-c:v", "libx264", "-preset", "ultrafast", "-b:v", mbps + "M", "-maxrate", mbps + "M", "-bufsize", 2 * mbps + "M", "-pix_fmt", "yuv420p", "-movflags", "+faststart");
    if (audio) args.push("-c:a", "aac", "-b:a", "128k", "-shortest");
    args.push("out.mp4");
    const code = await ff.exec(args);
    if (code !== 0) throw new Error("generator exited " + code);
    const data = await ff.readFile("out.mp4");
    (window.__gen = window.__gen || {})[name] = new File([data], name, { type: "video/mp4" });
    ff.terminate();
    return data.length;
  }, { name, w, h, secs, mbps, audio });
  return { size, genSecs: ((Date.now() - t0) / 1000).toFixed(1) };
}
const attach = (page, names) => page.evaluate((names) => {
  const dt = new DataTransfer(); names.forEach((n) => dt.items.add(window.__gen[n]));
  const input = document.getElementById("clips"); input.files = dt.files; input.dispatchEvent(new Event("change", { bubbles: true }));
}, names);

async function renderAndMeasure(page, { timeout = 900000 } = {}) {
  await page.waitForFunction(() => !document.getElementById("create").disabled || /Export failed|up to|need|cannot|can't/i.test(document.getElementById("renderNote").textContent), null, { timeout: 120000 });
  const enabled = !(await page.isDisabled("#create"));
  if (!enabled) return { ok: false, why: "blocked: " + (await page.textContent("#renderNote")) };
  const mem = startMemorySampler(page);
  const t0 = Date.now();
  await page.click("#create");
  let outcome;
  try {
    await page.waitForFunction(() => /Film ready|Export failed/.test(document.getElementById("status").textContent), null, { timeout });
    outcome = await page.textContent("#status");
  } catch (e) { outcome = page.crashed ? "PAGE CRASHED" : "TIMEOUT"; }
  const { peak: peakMB, heap: heapMB } = await mem.stop();
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (page.crashed) return { ok: false, why: "page crashed (out of memory?)", secs, peakMB };
  if (!/Film ready/.test(outcome)) return { ok: false, why: outcome.replace(/\s+/g, " ").slice(0, 160), secs, peakMB };
  const m = await page.evaluate(async () => {
    const v = document.createElement("video"); v.muted = true; v.src = document.getElementById("download").href;
    await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error("unplayable")); });
    return { w: v.videoWidth, h: v.videoHeight, duration: +v.duration.toFixed(2) };
  });
  return { ok: true, secs, peakMB, heapMB, ...m };
}
const row = (label, srcMB, r) => console.log(`# ${label.padEnd(34)} src ${String(srcMB).padStart(6)} MB | ${r.ok ? "OK " : "FAIL"} | render ${r.secs ?? "-"}s | peak browser ${r.peakMB ?? "-"} MB (JS heap ${r.heapMB ?? "-"} MB) | ${r.ok ? `${r.w}x${r.h} ${r.duration}s` : r.why}`);

for (const mb of SIZES) {
  test(`single ~${mb} MB 720p clip + small clip renders to a valid MP4`, { timeout: 1500000 }, async () => {
    const { ctx, page } = await newPage();
    try {
      const secs = Math.min(60, Math.max(20, Math.round(mb / 1.3)));            // <= 60 s product cap
      const mbps = Math.max(2, +(mb * 8 / secs).toFixed(1));
      const big = await generate(page, `big${mb}.mp4`, { w: 1280, h: 720, secs, mbps });
      await generate(page, "small.mp4", { w: 320, h: 180, secs: 2, mbps: 1 });
      console.log(`# generated ${(big.size / 1048576).toFixed(1)} MB (target ${mb}) in ${big.genSecs}s`);
      await attach(page, [`big${mb}.mp4`, "small.mp4"]);
      const r = await renderAndMeasure(page);
      row(`${LAZY ? "LAZY " : ""}1 big clip (${secs}s 720p)`, (big.size / 1048576).toFixed(1), r);
      assert.ok(r.ok, r.why);
      assert.deepEqual([r.w, r.h], [360, 640]);
    } finally { await ctx.close(); }
  });
}

test("5 mixed clips: portrait + landscape, 4K-ish + small, with and without audio", { timeout: 1500000 }, async () => {
  const { ctx, page } = await newPage();
  try {
    const specs = [["p1080.mp4", { w: 1080, h: 1920, secs: 8, mbps: 8 }], ["l720a.mp4", { w: 1280, h: 720, secs: 10, mbps: 6, audio: true }],
      ["l360.mp4", { w: 640, h: 360, secs: 6, mbps: 2 }], ["p720a.mp4", { w: 720, h: 1280, secs: 8, mbps: 5, audio: true }], ["l1080.mp4", { w: 1920, h: 1080, secs: 6, mbps: 8 }]];
    let total = 0;
    for (const [n, s] of specs) total += (await generate(page, n, s)).size;
    await attach(page, specs.map((s) => s[0]));
    const r = await renderAndMeasure(page);
    row("5 mixed clips (v/h, audio, 1080p)", (total / 1048576).toFixed(1), r);
    assert.ok(r.ok, r.why);
    assert.deepEqual([r.w, r.h], [360, 640]);
    assert.ok(r.duration > 20 && r.duration <= 30.5, "film length " + r.duration); // 38 s source -> <=30 s film
  } finally { await ctx.close(); }
});

// 5 x 1080p clips, ~STRESS5_MB each, 36 s each (=3 min source, the long-term requirement). Skipped unless STRESS5_MB is set.
test("5 x 1080p clips (3 min source) renders to a valid 30 s film", { timeout: 3000000, skip: !process.env.STRESS5_MB }, async () => {
  const each = Number(process.env.STRESS5_MB), secs = 36, mbps = +(each * 8 / secs).toFixed(1);
  const { ctx, page } = await newPage();
  try {
    let total = 0; const names = [];
    for (let i = 0; i < 5; i++) { const n = "c" + i + ".mp4"; const portrait = i % 2; names.push(n);
      total += (await generate(page, n, { w: portrait ? 1080 : 1920, h: portrait ? 1920 : 1080, secs, mbps, audio: i % 2 === 0 })).size; }
    await attach(page, names);
    const r = await renderAndMeasure(page);
    row(`${LAZY ? "LAZY " : ""}5 x 1080p (3 min)`, (total / 1048576).toFixed(1), r);
    assert.ok(r.ok, r.why);
    assert.ok(r.duration > 20 && r.duration <= 30.5, "film length " + r.duration);
  } finally { await ctx.close(); }
});
