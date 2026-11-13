// Test helpers: start an isolated LOCAL wrangler dev instance (local D1 in a temp dir, no remote access)
// and a mock Anthropic server. Nothing here deploys or contacts the production Worker / remote D1.
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const wrangler = join(root, "node_modules", "wrangler", "bin", "wrangler.js");
export const ORIGIN = "https://claqe.com";

// Cloudflare's official Turnstile dummy secrets / token.
export const TS = {
  ALWAYS_PASS: "1x0000000000000000000000000000000AA",
  ALWAYS_FAIL: "2x0000000000000000000000000000000AA",
  TOKEN_SPENT: "3x0000000000000000000000000000000AA",
  TOKEN: "XXXX.DUMMY.TOKEN.XXXX",
};

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
    s.on("error", rej);
  });
}

export async function startMockAnthropic() {
  const mock = { calls: [], response: null, server: null, url: "" };
  mock.respond = (status, body) => { mock.response = { status, body }; };
  mock.server = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      mock.calls.push({ url: req.url, headers: req.headers, body: data });
      const r = mock.response || { status: 500, body: { error: { message: "no mock response set" } } };
      res.writeHead(r.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(r.body));
    });
  });
  const port = await freePort();
  await new Promise((r) => mock.server.listen(port, "127.0.0.1", r));
  mock.url = `http://127.0.0.1:${port}/v1/messages`;
  mock.close = () => new Promise((r) => mock.server.close(r));
  return mock;
}

export async function startWorker({ turnstileSecret = TS.ALWAYS_PASS, anthropicUrl } = {}) {
  const state = mkdtempSync(join(tmpdir(), "claqe-test-"));
  for (const f of [join(root, "schema.sql"), join(root, "test", "seed.sql")]) {
    const run = spawnSync(process.execPath, [wrangler, "d1", "execute", "DB", "--local", "--persist-to", state, "--file", f], { cwd: root, encoding: "utf8" });
    if (run.status !== 0) throw new Error("local D1 setup failed (" + f + "):\n" + run.stdout + run.stderr);
  }

  const port = await freePort(), inspector = await freePort();
  const args = [wrangler, "dev", "--local", "--port", String(port), "--inspector-port", String(inspector), "--persist-to", state,
    "--var", "TURNSTILE_SECRET:" + turnstileSecret, "--var", "PASS_SECRET:local-test-pass-secret", "--var", "ANTHROPIC_API_KEY:mock-key-not-real"];
  if (anthropicUrl) args.push("--var", "ANTHROPIC_API_URL:" + anthropicUrl);
  const child = spawn(process.execPath, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("wrangler dev did not start:\n" + log)), 90000);
    const onData = (d) => { log += d; if (log.includes("Ready on")) { clearTimeout(timer); resolve(); } };
    child.stdout.on("data", onData); child.stderr.on("data", onData);
    child.on("exit", (c) => { clearTimeout(timer); reject(new Error("wrangler exited " + c + ":\n" + log)); });
  });

  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    // Run a read-only query against the LOCAL temp D1.
    sql(query) {
      const r = spawnSync(process.execPath, [wrangler, "d1", "execute", "DB", "--local", "--persist-to", state, "--json", "--command", query], { cwd: root, encoding: "utf8" });
      return JSON.parse(r.stdout)[0].results;
    },
    async stop() {
      child.removeAllListeners("exit");
      if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
      else child.kill("SIGKILL");
      await new Promise((r) => setTimeout(r, 500));
      try { rmSync(state, { recursive: true, force: true }); } catch {}
    },
  };
}

// Small HTTP client with Origin + cookie handling.
export function client(base) {
  let cookie = "";
  let n = 0;
  const ip = "10.1." + Math.floor(Math.random() * 250) + "." + (1 + Math.floor(Math.random() * 250));
  async function call(path, { method = "GET", json, raw, headers = {}, origin = ORIGIN, useCookie = true, ipOverride } = {}) {
    const h = { ...headers, "CF-Connecting-IP": ipOverride || ip };
    if (origin) h.Origin = origin;
    if (useCookie && cookie) h.Cookie = cookie;
    let body;
    if (raw !== undefined) { body = raw; h["Content-Type"] = "application/json"; }
    else if (json !== undefined) { body = JSON.stringify(json); h["Content-Type"] = "application/json"; }
    const res = await fetch(base + path, { method, headers: h, body });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    n++;
    return { status: res.status, data, headers: res.headers, setCookie };
  }
  return { call, get cookie() { return cookie; }, set cookie(v) { cookie = v; }, ip };
}
