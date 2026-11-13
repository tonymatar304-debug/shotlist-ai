// Shared helpers for real-render tests: static server, local real FFmpeg.wasm routes (no CDN needed), Edge launcher.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

// Serve the REAL FFmpeg.wasm 0.12.15 / core 0.12.10 (the versions index.html pins) from tests/node_modules.
export async function routeRealFfmpeg(ctx) {
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
