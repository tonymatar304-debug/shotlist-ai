// FREE manual feasibility probe (no app changes, no packages): can the browser's WebCodecs VideoDecoder replace FFmpeg.wasm
// decoding for one shot? FFmpeg.wasm's own ffprobe lists the packets (file offset, size, pts, keyframe) and the codec config
// (avcC/hvcC extradata), so JS slices packets straight from the File -- no separate MP4 demuxer. Frames are scaled to
// 640x360 on a canvas and read back (what feeding FFmpeg as raw video would need). Compared with FFmpeg.wasm decoding the same
// shot. Usage: node e2e/webcodecs-probe.mjs <clip.mp4> [start=2] [dur=1.8]
import fs from "node:fs";
import path from "node:path";
import { staticServer, listen, launch, routeRealFfmpeg } from "./lib.mjs";

const [clip, start = "2", dur = "1.8"] = process.argv.slice(2);
const web = staticServer(), port = await listen(web), browser = await launch(), ctx = await browser.newContext(); await routeRealFfmpeg(ctx);
const page = await ctx.newPage(); await page.goto(`http://localhost:${port}/index.html`);
await page.evaluate(() => { const i = document.createElement("input"); i.type = "file"; i.id = "wcfile"; document.body.append(i); });
await page.setInputFiles("#wcfile", [clip]); // gives the page a real File (no copy through the test)
const r = await page.evaluate(async ({ start, dur }) => {
  const file = document.getElementById("wcfile").files[0], out = { api: typeof VideoDecoder === "function", configs: {} };
  for (const [k, codec] of Object.entries({ h264High4K: "avc1.640033", hevcMain: "hvc1.1.6.L153.B0", hevcMain10: "hvc1.2.4.L153.B0", vp9: "vp09.00.10.08", av1: "av01.0.08M.08" }))
    for (const hw of ["prefer-hardware", "prefer-software"]) { try { out.configs[k + "/" + hw] = (await VideoDecoder.isConfigSupported({ codec, codedWidth: 3840, codedHeight: 2160, hardwareAcceleration: hw })).supported; } catch (e) { out.configs[k + "/" + hw] = "error"; } }
  const base = "https://cdn.jsdelivr.net/npm/", blob = async (u, t) => URL.createObjectURL(new Blob([await (await fetch(u)).arrayBuffer()], { type: t }));
  const ff = new window.FFmpegWASM.FFmpeg(); const log = []; ff.on("log", (e) => log.push(e.message));
  await ff.load({ coreURL: await blob(base + "@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.js", "text/javascript"), wasmURL: await blob(base + "@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.wasm", "application/wasm") });
  await ff.createDir("/src"); await ff.mount("WORKERFS", { blobs: [{ name: "c.mp4", data: file }] }, "/src"); // no copy of the clip
  let t0 = performance.now();
  // 1) packet table (timing, file offset, size, keyframe); 2) stream info + codec config (extradata), reading one packet only
  await ff.ffprobe(["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time,size,pos,flags", "-of", "csv=p=0", "/src/c.mp4", "-o", "p.csv"]);
  out.indexMs = Math.round(performance.now() - t0); t0 = performance.now();
  await ff.ffprobe(["-v", "error", "-select_streams", "v:0", "-read_intervals", "%+#1", "-show_streams", "-show_data", "-of", "json", "/src/c.mp4", "-o", "s.json"]);
  out.configMs = Math.round(performance.now() - t0);
  const s = JSON.parse(new TextDecoder().decode(await ff.readFile("s.json"))).streams[0];
  const pk = new TextDecoder().decode(await ff.readFile("p.csv")).trim().split("\n").map((l) => { const [pts, size, pos, flags] = l.split(","); return { pts: +pts, pos: +pos, size: +size, key: /K/.test(flags) }; });
  out.stream = { codec: s.codec_name, w: s.width, h: s.height, profile: s.profile, packets: pk.length, extradata: !!s.extradata };
  if (!s.extradata) return out;
  const hex = s.extradata.split("\n").map((l) => l.replace(/^[0-9a-f]+:\s*/, "").slice(0, 39).replace(/\s/g, "")).join(""), desc = new Uint8Array(hex.match(/../g).map((h) => parseInt(h, 16)));
  const codec = s.codec_name === "h264" ? "avc1." + [1, 2, 3].map((i) => desc[i].toString(16).padStart(2, "0")).join("") : null;
  out.codecString = codec; if (!codec) return out;
  const t1 = +start, t2 = t1 + +dur; let k = 0; for (let i = 0; i < pk.length; i++) if (pk[i].key && pk[i].pts <= t1) k = i;
  const todo = pk.slice(k).filter((p, i) => i === 0 || p.pts < t2 + 0.5); // decode order; B-frames may need a few packets past t2
  const c = new OffscreenCanvas(640, 360), g = c.getContext("2d", { willReadFrequently: true }); let kept = 0, decoded = 0, readMs = 0;
  for (const hw of ["prefer-hardware", "prefer-software"]) {
    kept = decoded = readMs = 0; t0 = performance.now();
    const dec = new VideoDecoder({ output: (f) => { decoded++; const ts = f.timestamp / 1e6; if (ts >= t1 - 1e-3 && ts < t2) { const a = performance.now(); g.drawImage(f, 0, 0, 640, 360); g.getImageData(0, 0, 640, 360); readMs += performance.now() - a; kept++; } f.close(); }, error: (e) => (out.error = e.message) });
    dec.configure({ codec, description: desc, codedWidth: s.width, codedHeight: s.height, hardwareAcceleration: hw });
    for (const p of todo) { const data = new Uint8Array(await file.slice(p.pos, p.pos + p.size).arrayBuffer()); dec.decode(new EncodedVideoChunk({ type: p.key ? "key" : "delta", timestamp: Math.round(p.pts * 1e6), data })); }
    await dec.flush(); dec.close();
    out[hw] = { ms: Math.round(performance.now() - t0), packets: todo.length, decoded, kept, readbackMs: Math.round(readMs) };
  }
  // FFmpeg.wasm: the same shot, decoded and scaled to 640x360 (what the app does before its filters).
  t0 = performance.now(); await ff.exec(["-v", "error", "-ss", String(t1), "-t", String(dur), "-i", "/src/c.mp4", "-an", "-vf", "scale=640:360", "-f", "null", "-"]);
  out.ffmpegMs = Math.round(performance.now() - t0);
  return out;
}, { start, dur });
console.log(path.basename(clip), JSON.stringify(r, null, 1));
await browser.close(); web.close();
