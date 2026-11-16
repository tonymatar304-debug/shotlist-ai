// One-off generator for phone-style fixtures (committed, small): 10-bit .mov like iPhones record (HLG / PQ / SDR),
// a portrait clip with rotation metadata, and a variable-frame-rate H.264 clip. Every clip carries a flash + 1 kHz beep
// at 0.5, 2.0 and 3.5 s (A/V sync). Chart values: see phone-chart.mjs. Run: cd tests && node e2e/make-phone-fixtures.mjs
import fs from "node:fs";
import path from "node:path";
import { staticServer, listen, launch, routeRealFfmpeg, FIXTURES } from "./lib.mjs";
import { W, H, frame } from "./phone-chart.mjs";

const FPS = 30, SECS = 4, isFlash = (k) => (k / FPS + 1) % 1.5 < 0.08;
// Chart / flash frames (2-frame raw input) -> 4 s at 30 fps, flash frames where isFlash.
// FFmpeg 5.1 takes the stream's colour tags from the frames, so they are set with setparams (not encoder options).
function timeline([prim, trc, space]) {
  const segs = []; for (let k = 0; k < FPS * SECS; k++) { const f = isFlash(k); if (segs.length && segs.at(-1).f === f) segs.at(-1).n++; else segs.push({ f, n: 1 }); }
  const g = [`[0:v]split=${segs.length}` + segs.map((_, i) => `[s${i}]`).join("")];
  segs.forEach((s, i) => g.push(`[s${i}]trim=start_frame=${s.f ? 1 : 0}:end_frame=${s.f ? 2 : 1},setpts=PTS-STARTPTS,loop=loop=${s.n - 1}:size=1:start=0[t${i}]`));
  g.push(segs.map((_, i) => `[t${i}]`).join("") + `concat=n=${segs.length}:v=1:a=0,setpts=N/${FPS}/TB,format=yuv422p10le,` +
    `setparams=range=tv:color_primaries=${prim}:color_trc=${trc}:colorspace=${space}[v]`);
  return g.join(";");
}
// Portrait like an iPhone: landscape frames + a 90 degree tkhd display matrix on the video track (patched after muxing;
// FFmpeg 5.1 has no option to write it). Matrix = [0 1 0; -1 0 0; 0 0 1] in 16.16 / 2.30 fixed point.
function portrait(b) {
  const i = b.indexOf("tkhd"); if (i < 0) throw new Error("no tkhd");
  const m = [0, 0x10000, 0, -0x10000, 0, 0, 0, 0, 0x40000000]; m.forEach((v, k) => b.writeInt32BE(v, i + 44 + 4 * k));
  // tkhd width/height = presentation size after the transform (360 x 640)
  b.writeUInt32BE(H << 16, i + 80); b.writeUInt32BE(W << 16, i + 84); return b;
}
const beep = ["-f", "lavfi", "-i", "aevalsrc='if(lt(mod(t+1,1.5),0.06),0.5*sin(2*PI*1000*t),0)|if(lt(mod(t+1,1.5),0.06),0.5*sin(2*PI*1000*t),0)':s=48000:d=" + SECS];
const raw = ["-f", "rawvideo", "-pix_fmt", "yuv444p10le", "-s", `${W}x${H}`, "-framerate", String(FPS), "-i", "chart.raw"];
// 10-bit ProRes 422 Proxy in .mov (iPhone Pro "ProRes HLG" format). libx265 cannot run in this single-threaded FFmpeg.wasm
// (it needs worker threads), so HEVC itself is covered by real phone recordings (docs/phone-footage-testing.md).
const prores = (tags) => ["-filter_complex", timeline(tags), "-map", "[v]", "-map", "1:a", "-c:v", "prores_ks", "-profile:v", "0", "-vendor", "apl0",
  "-pix_fmt", "yuv422p10le", "-c:a", "aac", "-b:a", "96k", "-shortest", "-movflags", "+faststart"];
const jobs = {
  // iPhone HDR: 10-bit, BT.2020, HLG
  "hlg-prores-4s.mov": { chart: ["hlg", "bt2020"], args: prores(["bt2020", "arib-std-b67", "bt2020nc"]) },
  // Same, filmed in portrait: landscape frames + 90 degree display matrix (how iPhones store portrait video)
  "hlg-prores-portrait-4s.mov": { chart: ["hlg", "bt2020"], args: prores(["bt2020", "arib-std-b67", "bt2020nc"]), patch: portrait },
  // HDR10 (PQ), e.g. some Android phones and edited exports
  "pq-prores-4s.mov": { chart: ["pq", "bt2020"], args: prores(["bt2020", "smpte2084", "bt2020nc"]) },
  // 10-bit SDR, BT.709: must NOT be tone mapped
  "sdr10-prores-4s.mov": { chart: ["sdr709", "bt709"], args: prores(["bt709", "bt709", "bt709"]) },
};
// Variable frame rate H.264 SDR (phones drop to VFR in low light): ~30 fps with +/-12 ms jitter, flash drawn at true time.
const vfr = ["-f", "lavfi", "-i", `color=c=0x202020:s=640x360:d=6:r=30,settb=1/30000,setpts='(N/30+0.012*sin(N*1.7))/TB',` +
  "drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='lt(mod(t+1,1.5),0.08)'",
  "-f", "lavfi", "-i", "aevalsrc='if(lt(mod(t+1,1.5),0.06),0.8*sin(2*PI*1000*t),0)':s=44100:d=6",
  "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28", "-pix_fmt", "yuv420p", "-vsync", "vfr", "-enc_time_base", "1/30000",
  "-video_track_timescale", "30000", "-c:a", "aac", "-b:a", "96k", "-shortest", "-movflags", "+faststart"];

const web = staticServer(), port = await listen(web), browser = await launch(), ctx = await browser.newContext(); await routeRealFfmpeg(ctx);
const page = await ctx.newPage(); await page.goto(`http://localhost:${port}/index.html`);
await page.evaluate(async () => {
  const base = "https://cdn.jsdelivr.net/npm/", blob = async (u, t) => URL.createObjectURL(new Blob([await (await fetch(u)).arrayBuffer()], { type: t }));
  const ff = new window.FFmpegWASM.FFmpeg(); window.__log = []; ff.on("log", (e) => window.__log.push(e.message));
  await ff.load({ coreURL: await blob(base + "@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.js", "text/javascript"), wasmURL: await blob(base + "@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.wasm", "application/wasm") });
  window.__gen = ff;
});
async function run(args, out, input) {
  if (input) await page.evaluate(async (b64) => { const s = atob(b64), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); await window.__gen.writeFile("chart.raw", u); }, input.toString("base64"));
  const b64 = await page.evaluate(async ({ args, out }) => {
    window.__log = []; const code = await window.__gen.exec(["-y", ...args, out]);
    if (code !== 0) throw new Error("ffmpeg exited " + code + "\n" + window.__log.slice(-15).join("\n"));
    const d = await window.__gen.readFile(out); await window.__gen.deleteFile(out);
    let s = ""; for (let i = 0; i < d.length; i += 0x8000) s += String.fromCharCode.apply(null, d.subarray(i, i + 0x8000)); return btoa(s);
  }, { args, out });
  return Buffer.from(b64, "base64");
}
const only = process.argv.slice(2);
for (const [name, j] of Object.entries(jobs)) {
  if (only.length && !only.includes(name)) continue;
  let buf = await run([...raw, ...beep, ...j.args], name, Buffer.concat([frame(...j.chart), frame(...j.chart, true)]));
  if (j.patch) buf = j.patch(buf);
  fs.writeFileSync(path.join(FIXTURES, name), buf); console.log(name, buf.length, "bytes");
}
// MPEG-TS (some Android / action cameras): Edge cannot open it at all, FFmpeg can (duration fallback test).
if (!only.length || only.includes("sdr-h264-4s.ts")) {
  const buf = await run(["-f", "lavfi", "-i", "testsrc2=s=320x180:d=4:r=30", "-f", "lavfi", "-i", "sine=f=440:sample_rate=48000:d=4,volume=0.3",
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "30", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "64k", "-shortest", "-f", "mpegts"], "sdr-h264-4s.ts");
  fs.writeFileSync(path.join(FIXTURES, "sdr-h264-4s.ts"), buf); console.log("sdr-h264-4s.ts", buf.length, "bytes");
}
if (!only.length || only.includes("vfr-h264-6s.mp4")) {
  const buf = await run(vfr, "vfr-h264-6s.mp4"); fs.writeFileSync(path.join(FIXTURES, "vfr-h264-6s.mp4"), buf); console.log("vfr-h264-6s.mp4", buf.length, "bytes");
}
await browser.close(); web.close();
