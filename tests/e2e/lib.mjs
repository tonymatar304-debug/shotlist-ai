// Shared helpers for real-render tests: static server, local real FFmpeg.wasm routes (no CDN needed), Edge launcher.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright-core";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(HERE, "..", "..");
export const FIXTURES = path.join(HERE, "fixtures");
const NM = path.join(ROOT, "tests", "node_modules", "@ffmpeg");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

export function listen(server) { return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port))); }

export function staticServer() {
  return http.createServer((req, res) => {
    const file = path.join(ROOT, decodeURIComponent(new URL(req.url, "http://x").pathname));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
}

export const launch = () => chromium.launch({ channel: "msedge", headless: true });

// Benchmarks (Windows): private MB of the Playwright Edge process tree (incl. the FFmpeg worker / WASM heap).
export const treeMB = (root) => {
  const out = execFileSync("powershell.exe", ["-NoProfile", "-Command",
    "Get-CimInstance Win32_Process -Filter \"name='msedge.exe'\" | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId) $($_.PrivatePageCount)\" }"], { encoding: "utf8" });
  const rows = out.trim().split(/\r?\n/).map((l) => l.split(" ").map(Number)), keep = new Set([root]);
  for (let grew = true; grew;) { grew = false; for (const [p, pp] of rows) if (keep.has(pp) && !keep.has(p)) { keep.add(p); grew = true; } }
  return rows.filter(([p]) => keep.has(p)).reduce((s, r) => s + r[2], 0) / 1048576;
};
// Playwright's Edge is the msedge.exe started with --remote-debugging-pipe (the user's own Edge windows are ignored).
export const rootPid = () => Number(execFileSync("powershell.exe", ["-NoProfile", "-Command",
  "(Get-CimInstance Win32_Process -Filter \"name='msedge.exe'\" | Where-Object { $_.CommandLine -match 'remote-debugging-pipe' -and $_.CommandLine -notmatch '--type=' } | Sort-Object CreationDate | Select-Object -Last 1).ProcessId"], { encoding: "utf8" }).trim()) || NaN;

// Serve the REAL FFmpeg.wasm 0.12.15 / core 0.12.10 (the versions index.html pins) from tests/node_modules.
export async function routeRealFfmpeg(ctx) {
  // Run every real-render test against a chosen renderer: CLAQE_RENDER=single|sequential (app default: sequential).
  if (process.env.CLAQE_RENDER) await ctx.addInitScript((r) => { window.CLAQE_RENDER = r; }, process.env.CLAQE_RENDER);
  ctx.on("console", (m) => { if (/sequential render failed|CLAQE sequential:/.test(m.text())) console.log("# RENDERER FALLBACK: " + m.text().slice(0, 300)); });
  if (process.env.CLAQE_TONEMAP) await ctx.addInitScript((r) => { window.CLAQE_TONEMAP = r === "false" ? false : r; }, process.env.CLAQE_TONEMAP);
  if (process.env.CLAQE_INTERMEDIATE) await ctx.addInitScript((r) => { window.CLAQE_INTERMEDIATE = r; }, process.env.CLAQE_INTERMEDIATE);
  await ctx.route(/cdn\.jsdelivr\.net\/npm\/@ffmpeg\/(ffmpeg|core)@[\d.]+\/dist\/(umd|esm)\//, (route) => {
    const m = /@ffmpeg\/(ffmpeg|core)@[\d.]+\/dist\/(umd|esm)\/([\w.\-]+)/.exec(route.request().url());
    const file = path.join(NM, m[1], "dist", m[2], m[3]);
    if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: "" });
    route.fulfill({ body: fs.readFileSync(file), headers: { "access-control-allow-origin": "*" },
      contentType: file.endsWith(".wasm") ? "application/wasm" : "text/javascript" });
  });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.fulfill({ contentType: "text/css", body: "" }));
}

// Run FFmpeg.wasm inside a page that already loaded index.html (so window.FFmpegWASM exists). Returns output bytes.
export async function ffmpegInPage(page, args, out) {
  const b64 = await page.evaluate(async ({ args, out }) => {
    const base = "https://cdn.jsdelivr.net/npm/";
    const blob = async (u, t) => URL.createObjectURL(new Blob([await (await fetch(u)).arrayBuffer()], { type: t }));
    const ff = new window.FFmpegWASM.FFmpeg();
    await ff.load({
      coreURL: await blob(base + "@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.js", "text/javascript"),
      wasmURL: await blob(base + "@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.wasm", "application/wasm"),
    });
    const code = await ff.exec(args);
    if (code !== 0) throw new Error("ffmpeg exited " + code);
    const data = await ff.readFile(out);
    let s = ""; for (let i = 0; i < data.length; i += 0x8000) s += String.fromCharCode.apply(null, data.subarray(i, i + 0x8000));
    return btoa(s);
  }, { args, out });
  return Buffer.from(b64, "base64");
}
