// REAL rendering tests: real FFmpeg.wasm (0.12.15 wrapper + core 0.12.10, served locally), real H.264 sample clips, real Edge video decoding.
// The exported MP4 is inspected in the browser: container layout, dimensions, duration, playback and actual pixel colours per segment.
// Mocked: only the CLAQE API and Turnstile (see mocks.mjs). Slow (~1-3 min). Run: cd tests && npm run e2e
import { test, before, after, beforeEach, afterEach, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { devices } from "playwright-core";
import { staticServer, listen, launch, routeRealFfmpeg, FIXTURES } from "./lib.mjs";
import { routeTurnstileStub, solveTurnstile, routeApi, newApiState, openUrl } from "./mocks.mjs";

const fx = (n) => ({ name: n, mimeType: "video/mp4", buffer: fs.readFileSync(path.join(FIXTURES, n)) });
const RG = "red-green-3s.mp4", BLUE = "blue-3s.mp4", YEL = "yellow-3s.mp4", MAG = "magenta-3s.mp4";
let web, port, browser, ctx, page, api;
const after_cleanup = [];

before(async () => { web = staticServer(); port = await listen(web); browser = await launch(); });
after(async () => { await browser?.close(); web?.close(); after_cleanup.forEach((f) => f()); });
beforeEach(async () => {
  api = newApiState();
  ctx = await browser.newContext();
  await routeRealFfmpeg(ctx); await routeTurnstileStub(ctx); await routeApi(ctx, api);
  page = await ctx.newPage();
  page.on("console", (m) => /CLAQE lazy/.test(m.text()) && console.log("CONSOLE", m.text())); page.on("pageerror", (e) => console.log("pageerror:", String(e).slice(0, 200)));
});
afterEach(async () => { await ctx?.close(); });

const addClips = async (files) => { await page.setInputFiles("#clips", files.map(fx)); await page.waitForFunction(() => !document.getElementById("create").disabled, null, { timeout: 20000 }); };
const waitStatus = (re, timeout = 240000) => page.waitForFunction((s) => new RegExp(s).test(document.getElementById("status").textContent), re.source, { timeout });
const text = (s) => page.textContent(s);

// Decode the downloadable MP4 inside the page and measure it.
async function inspect(times) {
  return page.evaluate(async (times) => {
    const href = document.getElementById("download").href;
    const bytes = new Uint8Array(await (await fetch(href)).arrayBuffer());
    const latin = new TextDecoder("latin1").decode(bytes);
    const info = { size: bytes.length, ftyp: latin.slice(4, 8), moov: latin.indexOf("moov"), mdat: latin.indexOf("mdat") };
    const v = document.createElement("video"); v.muted = true; v.playsInline = true; v.src = href; v.preload = "auto";
    await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error("export is not playable: " + (v.error && v.error.message))); });
    info.w = v.videoWidth; info.h = v.videoHeight; info.duration = v.duration;
    const c = document.createElement("canvas"); c.width = 36; c.height = 64; const g = c.getContext("2d", { willReadFrequently: true });
    info.px = [];
    for (const t of times) {
      v.currentTime = t; await new Promise((r) => (v.onseeked = r));
      // 'seeked' can fire before the new frame is painted under load: sample until two consecutive reads agree.
      const sample = () => {
        g.drawImage(v, 0, 0, c.width, c.height);
        const d = g.getImageData(c.width / 2 - 3, c.height / 2 - 3, 6, 6).data; let r = 0, gg = 0, b = 0;
        for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; }
        const n = d.length / 4; return [Math.round(r / n), Math.round(gg / n), Math.round(b / n)];
      };
      let prev = null, cur = null;
      for (let k = 0; k < 20; k++) {
        await new Promise((r) => setTimeout(r, 120)); cur = sample();
        if (prev && prev.every((x, i) => Math.abs(x - cur[i]) < 4)) break;
        prev = cur;
      }
      info.px.push(cur);
    }
    v.currentTime = 0; await v.play(); await new Promise((r) => setTimeout(r, 700)); info.played = v.currentTime;
    return info;
  }, times);
}
const dom = ([r, g, b]) => (r > g + 50 && r > b + 50 && g < 110 ? "red" : g > r + 40 && g > b + 40 ? "green" : b > r + 50 && b > g + 50 ? "blue" : r > 120 && g > 120 && b < 90 ? "yellow" : r > 120 && b > 120 && g < 90 ? "magenta" : "other:" + [r, g, b]);

describe("real MP4 export", () => {
  test("browser preview: valid playable MP4, 9:16, correct trims/order, re-render works", async () => {
    await page.goto(openUrl(port, false));
    await addClips([RG, BLUE]);
    await page.click("#create");
    await waitStatus(/Film ready|Export failed/);
    assert.match(await text("#status"), /Film ready/, await text("#status"));
    const m = await inspect([0.6, 2.2, 4.2]);
    assert.equal(m.ftyp, "ftyp"); assert.ok(m.moov > 0 && m.moov < m.mdat, "faststart: moov before mdat");
    assert.deepEqual([m.w, m.h], [360, 640]); // vertical 9:16
    assert.ok(Math.abs(m.duration - 5.6) < 0.25, "duration " + m.duration); // local plan: 2 x 2.8 s
    assert.deepEqual(m.px.map(dom), ["red", "green", "blue"]); // clip A red part, A green part, then clip B
    assert.ok(m.played > 0.3, "plays: " + m.played);
    assert.match(await text("#resultNote"), /^Footage-aware edit from local video analysis \(not AI\)/);
    // Second render in the same page (engine reuse, cleanup) with a different style/format.
    const first = await page.getAttribute("#download", "href");
    await page.click('button[data-style="vintage"]'); await page.click('button[data-format="landscape"]');
    await page.click("#create");
    await page.waitForFunction((f) => document.getElementById("download").href !== f && /Film ready/.test(document.getElementById("status").textContent), first, { timeout: 240000 });
    const m2 = await inspect([4.2]);
    assert.deepEqual([m2.w, m2.h], [640, 360]); // 16:9
    assert.equal(dom(m2.px[0]), "blue");
  });

  test("AI plan controls order AND trims in the real export (landscape 16:9)", async () => {
    await page.goto(openUrl(port, true));
    await addClips([RG, BLUE]);
    await page.click('button[data-plan="ai"]'); await page.click('button[data-format="landscape"]');
    await page.click("#create");
    await solveTurnstile(page);
    await waitStatus(/Film ready|Export failed/);
    assert.match(await text("#status"), /Film ready/, await text("#status"));
    // plan: [blue clip from 0.4 for 1.0 s] then [red/green clip from 1.8 for 1.0 s => green, NOT the red start]
    const m = await inspect([0.5, 1.5]);
    assert.deepEqual([m.w, m.h], [640, 360]);
    assert.ok(Math.abs(m.duration - 2.0) < 0.25, "duration " + m.duration);
    assert.deepEqual(m.px.map(dom), ["blue", "green"]);
    assert.match(await text("#resultNote"), /AI-assisted edit plan/);
    assert.deepEqual(api.calls.find((c) => c.path === "/generate").body.clips, [{ duration: 3 }, { duration: 3 }]); // real metadata, durations only
  });

  test("lazy source access (WORKERFS): mounts the File, same pixels/trims/duration, repeat render, no stale mounts", async () => {
    await page.addInitScript(() => { window.CLAQE_LAZY = true; });
    await page.goto(openUrl(port, false));
    await addClips([RG, BLUE]);
    for (let round = 0; round < 2; round++) {
      const before = await page.getAttribute("#download", "href");
      await page.click("#create");
      await page.waitForFunction((b) => /Film ready|Export failed/.test(document.getElementById("status").textContent) && document.getElementById("download").href !== b, before, { timeout: 240000 });
      assert.match(await text("#status"), /Film ready/, await text("#status"));
      const m = await inspect([0.6, 2.2, 4.2]);
      assert.deepEqual([m.w, m.h], [360, 640]);
      assert.ok(Math.abs(m.duration - 5.6) < 0.25, "duration " + m.duration);
      assert.deepEqual(m.px.map(dom), ["red", "green", "blue"]);
    }
    assert.equal(await page.evaluate(() => window.__claqeLazyCount), 4, "both clips mounted lazily in both renders");
  });

  test("4 clips: renders, correct order and total length; records time and JS heap", async () => {
    await page.goto(openUrl(port, false));
    await addClips([RG, BLUE, YEL, MAG]);
    const t0 = Date.now();
    await page.click("#create");
    await waitStatus(/Film ready|Export failed/);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    assert.match(await text("#status"), /Film ready/, await text("#status"));
    const heap = await page.evaluate(() => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : -1));
    const m = await inspect([4.2, 7.0, 9.8]);
    console.log(`# 4-clip 360x640 render: ${secs}s wall, JS heap ${heap} MB, output ${m.size} bytes`);
    assert.ok(Math.abs(m.duration - 11.2) < 0.3, "duration " + m.duration);
    assert.deepEqual(m.px.map(dom), ["blue", "yellow", "magenta"]);
  });
});

describe("intake limits (no render)", () => {
  test("5 clips allowed; more than 5 refused", async () => {
    await page.goto(openUrl(port, false));
    await page.setInputFiles("#clips", [RG, BLUE, YEL, MAG, RG].map((n, i) => ({ ...fx(n), name: i + "_" + n })));
    await page.waitForFunction(() => !document.getElementById("create").disabled, null, { timeout: 20000 });
    await page.setInputFiles("#clips", [{ ...fx(YEL), name: "sixth.mp4" }]);
    await waitStatus(/up to 5 clips/, 10000);
  });
  test("a clip over 80 MB is refused for browser rendering with an actionable note", async () => {
    await page.goto(openUrl(port, false));
    const big = path.join(os.tmpdir(), "claqe-big-" + process.pid + ".mp4");
    fs.closeSync(fs.openSync(big, "w")); fs.truncateSync(big, 81 * 1024 * 1024); // sparse 81 MB file
    after_cleanup.push(() => fs.rmSync(big, { force: true }));
    await page.setInputFiles("#clips", [path.join(FIXTURES, RG), big]);
    await page.waitForFunction(() => /server rendering/.test(document.getElementById("renderNote").textContent), null, { timeout: 30000 });
    assert.equal(await page.isDisabled("#create"), true);
  });
});

describe("mobile (Pixel 7 emulation: touch, 412x915; real Android/iOS memory is NOT testable here)", () => {
  test("layout fits, tap targets are usable, and a real render works with touch", async () => {
    const mctx = await browser.newContext({ ...devices["Pixel 7"] });
    await routeRealFfmpeg(mctx);
    const mp = await mctx.newPage();
    try {
      await mp.goto(openUrl(port, false));
      assert.equal(await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "no horizontal scroll");
      await mp.setInputFiles("#clips", [fx(RG), fx(BLUE)]);
      await mp.waitForFunction(() => !document.getElementById("create").disabled, null, { timeout: 20000 });
      const box = await mp.locator("#create").boundingBox();
      assert.ok(box.height >= 44 && box.x >= 0 && box.x + box.width <= 412, "create button usable: " + JSON.stringify(box));
      for (const sel of ['button[data-style="dynamic"]', 'button[data-format="landscape"]']) {
        const b = await mp.locator(sel).boundingBox(); assert.ok(b.height >= 40, sel + " tap target " + b.height);
      }
      await mp.tap("#create");
      await mp.waitForFunction(() => /Film ready|Export failed/.test(document.getElementById("status").textContent), null, { timeout: 240000 });
      assert.match(await mp.textContent("#status"), /Film ready/);
      assert.equal(await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "no horizontal scroll after result");
    } finally { await mctx.close(); }
  });
});
