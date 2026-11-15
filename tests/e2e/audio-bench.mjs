// FREE manual benchmark: render the same real clips with original audio vs video-only (window.CLAQE_AUDIO=false).
// Measures FFmpeg exec time and peak memory of the whole Edge process tree (incl. the FFmpeg worker / WASM heap).
// Usage: node e2e/audio-bench.mjs <clip.mp4> <clip.mp4> ...
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { staticServer, listen, launch, routeRealFfmpeg } from "./lib.mjs";

const clips = process.argv.slice(2);
const treeMB = (root) => { // private bytes of the browser process and all its descendants
  const out = execFileSync("powershell.exe", ["-NoProfile", "-Command",
    "Get-CimInstance Win32_Process -Filter \"name='msedge.exe'\" | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId) $($_.PrivatePageCount)\" }"], { encoding: "utf8" });
  const rows = out.trim().split(/\r?\n/).map((l) => l.split(" ").map(Number)), keep = new Set([root]);
  for (let grew = true; grew;) { grew = false; for (const [p, pp] of rows) if (keep.has(pp) && !keep.has(p)) { keep.add(p); grew = true; } }
  return rows.filter(([p]) => keep.has(p)).reduce((s, r) => s + r[2], 0) / 1048576;
};
// Playwright's Edge is the msedge.exe started with --remote-debugging-pipe (the user's own Edge windows are ignored).
const rootPid = () => Number(execFileSync("powershell.exe", ["-NoProfile", "-Command",
  "(Get-CimInstance Win32_Process -Filter \"name='msedge.exe'\" | Where-Object { $_.CommandLine -match 'remote-debugging-pipe' -and $_.CommandLine -notmatch '--type=' } | Sort-Object CreationDate | Select-Object -Last 1).ProcessId"], { encoding: "utf8" }).trim()) || NaN;
const web = staticServer(), port = await listen(web);
const music = process.env.MUSIC; // optional: a music file you have the rights to (adds a "with-audio+music" run)
for (const mode of ["video-only", "with-audio", ...(music ? ["with-audio+music"] : [])]) {
  const browser = await launch(), pid = rootPid();
  const ctx = await browser.newContext(); await routeRealFfmpeg(ctx);
  const page = await ctx.newPage();
  if (mode === "video-only") await page.addInitScript(() => { window.CLAQE_AUDIO = false; });
  await page.goto(`http://localhost:${port}/index.html`);
  // encode time = from the "Making your film" status to "Film ready"
  await page.evaluate(() => { window.__exec = []; let t0 = 0; new MutationObserver(() => { const s = document.getElementById("status").textContent; if (/^Making your film/.test(s)) t0 = performance.now(); else if (/^Film ready/.test(s) && t0) { window.__exec.push(performance.now() - t0); t0 = 0; } }).observe(document.getElementById("status"), { childList: true, characterData: true, subtree: true }); });
  await page.setInputFiles("#clips", clips.map((f) => ({ name: path.basename(f), mimeType: "video/mp4", buffer: fs.readFileSync(f) })));
  await page.waitForFunction(() => !document.getElementById("create").disabled, null, { timeout: 60000 });
  if (mode.endsWith("music")) {
    const t0 = Date.now(); await page.setInputFiles("#music", music);
    await page.waitForFunction(() => /BPM|no clear beat|no steady beat|can't be read/.test(document.getElementById("musicNote").textContent), null, { timeout: 60000 });
    console.log(`music analysis ${((Date.now() - t0) / 1000).toFixed(1)} s: ${await page.textContent("#musicNote")}`);
  }
  for (let round = 1; round <= 2; round++) {
    const before = await page.getAttribute("#download", "href");
    let base = pid ? treeMB(pid) : NaN, peak = base, polling = true;
    const poll = (async () => { while (polling) { if (pid) peak = Math.max(peak, treeMB(pid)); await new Promise((r) => setTimeout(r, 300)); } })();
    await page.click("#create");
    await page.waitForFunction((b) => /Film ready|Export failed/.test(document.getElementById("status").textContent) && document.getElementById("download").href !== b, before, { timeout: 600000 });
    polling = false; await poll;
    const r = await page.evaluate(async () => ({ status: document.getElementById("status").textContent.slice(0, 40), note: document.getElementById("resultNote").textContent.slice(-60), exec: window.__exec.at(-1), size: (await (await fetch(document.getElementById("download").href)).arrayBuffer()).byteLength }));
    console.log(`${mode} round ${round}: ffmpeg ${(r.exec / 1000).toFixed(1)} s, Edge tree before ${base.toFixed(0)} MB, peak ${peak.toFixed(0)} MB (+${(peak - base).toFixed(0)}), output ${(r.size / 1024).toFixed(0)} KB | ${r.status} | …${r.note}`);
  }
  await browser.close();
}
web.close();
