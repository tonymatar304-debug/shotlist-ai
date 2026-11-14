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
await browser.close(); web.close();
