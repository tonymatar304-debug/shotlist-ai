// FREE: contact sheet (one frame every 2 s) for each rendered comparison video, to judge the films visually.
// Usage: node manual/contact-sheet.mjs manual/runs/videos/*.mp4  -> <video>.png next to each file
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url)), repo = path.join(here, "..", "..");
const { staticServer, listen, launch } = await import(pathToFileURL(path.join(repo, "tests", "e2e", "lib.mjs")).href);
const web = staticServer(), port = await listen(web), browser = await launch(), page = await (await browser.newContext()).newPage();
await page.goto(`http://localhost:${port}/index.html`);
for (const file of process.argv.slice(2)) {
  await page.route("**/sheet.mp4*", (r) => r.fulfill({ body: fs.readFileSync(file), contentType: "video/mp4" }));
  const out = await page.evaluate(async () => {
    const v = document.createElement("video"); v.muted = true; v.src = URL.createObjectURL(await (await fetch("/sheet.mp4?" + Math.random())).blob()); // blob URL: seekable
    await new Promise((r, j) => { v.onloadeddata = r; v.onerror = () => j(new Error("decode")); });
    const times = []; for (let t = 1; t < v.duration; t += 2) times.push(t);
    const tw = v.videoWidth >= v.videoHeight ? 192 : 108, th = Math.round(tw * v.videoHeight / v.videoWidth), cols = 8, rows = Math.ceil(times.length / cols);
    const c = document.createElement("canvas"); c.width = cols * tw; c.height = rows * (th + 14); const g = c.getContext("2d");
    g.fillStyle = "#111"; g.fillRect(0, 0, c.width, c.height); g.font = "11px sans-serif"; g.fillStyle = "#fff";
    for (let i = 0; i < times.length; i++) {
      await new Promise((r) => { v.onseeked = r; v.currentTime = times[i]; }); await new Promise((r) => setTimeout(r, 80));
      const x = (i % cols) * tw, y = Math.floor(i / cols) * (th + 14); g.drawImage(v, x, y + 14, tw, th); g.fillText(times[i] + "s", x + 3, y + 11);
    }
    return { png: c.toDataURL("image/png").split(",")[1], duration: v.duration };
  });
  const dst = file.replace(/\.mp4$/, ".png"); fs.writeFileSync(dst, Buffer.from(out.png, "base64"));
  console.log(path.basename(file), out.duration.toFixed(1) + "s ->", dst);
  await page.unroute("**/sheet.mp4*");
}
await browser.close(); web.close();
