// One-off generator for the small real H.264 sample clips in ./fixtures (committed). Run: node e2e/make-fixtures.mjs
import fs from "node:fs";
import path from "node:path";
import { staticServer, listen, launch, routeRealFfmpeg, ffmpegInPage, FIXTURES } from "./lib.mjs";

const enc = ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "30", "-pix_fmt", "yuv420p", "-movflags", "+faststart"];
const solid = (color, size, d) => ["-f", "lavfi", "-i", `color=c=${color}:s=${size}:d=${d}:r=24`];
const jobs = {
  // red for 1.5 s then green for 1.5 s: lets tests prove WHICH part of a clip (trim start) was rendered
  "red-green-3s.mp4": [...solid("red", "320x180", 1.5), ...solid("green", "320x180", 1.5), "-filter_complex", "[0][1]concat=n=2:v=1:a=0[o]", "-map", "[o]", ...enc],
  "blue-3s.mp4": [...solid("blue", "320x180", 3), ...enc],
  "yellow-3s.mp4": [...solid("yellow", "320x180", 3), ...enc],
  "magenta-3s.mp4": [...solid("magenta", "320x180", 3), ...enc],
  "hd-blue-3s.mp4": [...solid("blue", "1280x720", 3), ...enc],
  "hd-yellow-3s.mp4": [...solid("yellow", "1280x720", 3), ...enc],
};
// 20 s clips for footage-analysis tests: still colour bars (no motion) vs busy moving test pattern with noise, in either order.
const bars = (d) => ["-f", "lavfi", "-i", `smptebars=s=320x180:d=${d}:r=24`];
const busy = (d) => ["-f", "lavfi", "-i", `testsrc2=s=320x180:d=${d}:r=24`];
jobs["still-then-busy-20s.mp4"] = [...bars(10), ...busy(10), "-filter_complex", "[1]noise=alls=20:allf=t[b];[0][b]concat=n=2:v=1:a=0[o]", "-map", "[o]", ...enc];
jobs["busy-then-still-20s.mp4"] = [...busy(10), ...bars(10), "-filter_complex", "[0]noise=alls=20:allf=t[b];[b][1]concat=n=2:v=1:a=0[o]", "-map", "[o]", ...enc];
jobs["gray-20s.mp4"] = [...solid("0x606060", "320x180", 20), ...enc];
// A/V sync clip: dark frames with a 2-frame white flash and a 60 ms 1 kHz beep at the SAME instants (0.5, 2.0, 3.5, 5.0 s).
// Mono AAC 44.1 kHz (the renderer resamples to 48 kHz stereo).
jobs["beep-flash-6s.mp4"] = ["-f", "lavfi", "-i", "color=c=0x202020:s=320x180:d=6:r=24,drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='lt(mod(t+1,1.5),0.08)'",
  "-f", "lavfi", "-i", "aevalsrc='if(lt(mod(t+1,1.5),0.06),0.8*sin(2*PI*1000*t),0)':s=44100:d=6",
  ...enc, "-c:a", "aac", "-b:a", "96k", "-shortest"];
// Same pattern 20 dB quieter (levelling test).
jobs["beep-flash-quiet-6s.mp4"] = ["-f", "lavfi", "-i", "color=c=0x202020:s=320x180:d=6:r=24,drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='lt(mod(t+1,1.5),0.08)'",
  "-f", "lavfi", "-i", "aevalsrc='if(lt(mod(t+1,1.5),0.06),0.08*sin(2*PI*1000*t),0)':s=44100:d=6",
  ...enc, "-c:a", "aac", "-b:a", "96k", "-shortest"];
// Continuous 1 kHz tone (ducking test): grey picture.
jobs["tone-6s.mp4"] = [...solid("0x505050", "320x180", 6), "-f", "lavfi", "-i", "sine=f=1000:sample_rate=48000:d=6,volume=0.3", ...enc, "-c:a", "aac", "-b:a", "96k", "-shortest"];
// Generated (CLAQE-owned) music, 12 s: 0.4 s of silence, then a soft 60 Hz kick every 0.5 s (120 BPM) over a 330 Hz pad.
// Nothing near 1 kHz, so the beep of the sync clip can still be measured through a high-pass filter.
const k = "mod(t-0.4,0.5)";
jobs["music-120bpm.m4a"] = ["-f", "lavfi", "-i", `aevalsrc='if(gte(t,0.4),0.7*min(1,${k}/0.005)*exp(-${k}/0.06)*sin(2*PI*60*${k})+0.15*sin(2*PI*330*t),0)':s=44100:d=12`,
  "-c:a", "aac", "-b:a", "128k"];
// An audio stream FFmpeg cannot decode: the sync clip with its AAC sample entry renamed (patched after encoding).
const patch = { "bad-audio-6s.mp4": { from: "beep-flash-6s.mp4", fn: (b) => {
  const i = b.indexOf("mp4a"); if (i < 0) throw new Error("no mp4a"); b.write("zzzz", i, "latin1");
  // esds DecoderConfigDescriptor: objectTypeIndication 0x40 (AAC) + streamType byte 0x15 -> unknown object type 0xFE
  const e = b.indexOf("esds", i), o = b.indexOf(Buffer.from([0x40, 0x15]), e); if (e < 0 || o < 0 || o - e > 40) throw new Error("no esds"); b[o] = 0xfe; return b; } } };
const web = staticServer(); const port = await listen(web);
const browser = await launch(); const ctx = await browser.newContext(); await routeRealFfmpeg(ctx);
const page = await ctx.newPage();
await page.goto(`http://localhost:${port}/index.html`);
fs.mkdirSync(FIXTURES, { recursive: true });
const only = process.argv.slice(2);
for (const [name, args] of Object.entries(jobs)) {
  if (only.length && !only.includes(name)) continue;
  const buf = await ffmpegInPage(page, [...args, name], name);
  fs.writeFileSync(path.join(FIXTURES, name), buf);
  console.log(name, buf.length, "bytes");
}
for (const [name, p] of Object.entries(patch)) {
  if (only.length && !only.includes(name)) continue;
  fs.writeFileSync(path.join(FIXTURES, name), p.fn(fs.readFileSync(path.join(FIXTURES, p.from))));
  console.log(name, "patched from", p.from);
}
await browser.close(); web.close();
