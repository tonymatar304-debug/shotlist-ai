// Shared stubs / mocks for browser tests (Turnstile, CLAQE API, FFmpeg + video-metadata stand-ins).

// Fake Turnstile API: tests drive its callbacks (callback / expired-callback / error-callback / timeout-callback).
// Like the real widget, an unsolved/unused token expires after 300 s (expired-callback); reset() re-arms it.
export const TURNSTILE_STUB = `(()=>{const w=window;w.__ts={renders:0,resets:0,opts:null,timer:null};
const arm=()=>{clearTimeout(w.__ts.timer);w.__ts.timer=setTimeout(()=>w.__ts.opts&&w.__ts.opts["expired-callback"]&&w.__ts.opts["expired-callback"](),300000)};
w.turnstile={render(sel,o){w.__ts.renders++;w.__ts.opts=o;arm();return 7},reset(){w.__ts.resets++;arm()},remove(){}}})();`;
export async function routeTurnstileStub(ctx) {
  await ctx.route(/challenges\.cloudflare\.com\/turnstile\/v0\/api\.js/, (r) => r.fulfill({ contentType: "text/javascript", body: TURNSTILE_STUB }));
}
export const solveTurnstile = async (page, token = "tok-" + Math.random().toString(36).slice(2)) => {
  await page.waitForFunction(() => window.__ts && window.__ts.opts && window.__ts.renders > 0);
  await page.evaluate((t) => window.__ts.opts.callback(t), token);
  return token;
};
export const fireTurnstile = (page, name, arg) => page.evaluate(({ name, arg }) => window.__ts.opts[name](arg), { name, arg });

// Mock CLAQE API through request interception (no server). `state` is mutated by tests.
export function newApiState() {
  return { passed: false, used: 0, limit: 3, passFailuresLeft: 0, generate401: false, tokens: [], calls: [],
    order: [{ index: 1, start: 0.4, duration: 1 }, { index: 0, start: 1.8, duration: 1 }] };
}
export const API_BASE = "http://127.0.0.1:1";
export async function routeApi(ctx, st) {
  await ctx.route(API_BASE + "/**", async (route) => {
    const req = route.request(), p = new URL(req.url()).pathname;
    const cors = { "access-control-allow-origin": req.headers().origin || "*", "access-control-allow-credentials": "true", "access-control-allow-headers": "Content-Type", "access-control-allow-methods": "GET, POST, OPTIONS" };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const body = req.postData() ? JSON.parse(req.postData()) : null;
    st.calls.push({ path: p, body });
    const send = (status, json) => route.fulfill({ status, headers: cors, contentType: "application/json", body: JSON.stringify(json) });
    if (p === "/status") return send(200, { ok: true, ai_enabled: true, quota_configured: true, pass: st.passed ? { uid: "u", valid: true } : { valid: false }, free: st.passed ? { used: st.used, limit: st.limit } : undefined });
    if (p === "/pass") {
      st.tokens.push(body && body.turnstileToken);
      if (st.passFailuresLeft > 0) { st.passFailuresLeft--; return send(403, { ok: false, code: "verification_failed" }); }
      st.passed = true; return send(200, { ok: true, uid: "u" });
    }
    if (p === "/generate") {
      if (st.generate401) return send(401, { ok: false, code: "pass_required" });
      st.used++;
      return send(200, { ok: true, plan: { order: st.order, style: body.style, targetSeconds: body.targetSeconds }, usedFallback: false, passUsage: "1/30" });
    }
    send(404, { ok: false });
  });
}
export const openUrl = (port, ai) => `http://localhost:${port}/index.html` + (ai ? `?api=${API_BASE}&tskey=1x00000000000000000000AA` : "");

// Fast (non-rendering) tests only: record the FFmpeg command instead of running it.
export const FFMPEG_STUB = `window.FFmpegWASM={FFmpeg:class{on(){}async load(){}async writeFile(){}async exec(c){(window.__ffmpegCalls=window.__ffmpegCalls||[]).push(c);return window.__ffmpegExit||0}async readFile(){return new Uint8Array(4096)}async deleteFile(){}}};`;
// Stand-in for video metadata when files are not real videos: duration is encoded in the name (e.g. a_5.2s.mp4).
export const DURATION_STUB = `(()=>{const names=new Map(),orig=URL.createObjectURL.bind(URL);
URL.createObjectURL=o=>{const u=orig(o);if(o&&o.name)names.set(u,o.name);return u};
HTMLVideoElement.prototype.load=function(){const s=this.getAttribute("src");if(!s||!names.has(s))return;
const m=/_(\\d+(?:\\.\\d+)?)s\\./.exec(names.get(s));if(!m)return;Object.defineProperty(this,"duration",{value:parseFloat(m[1]),configurable:true});
setTimeout(()=>this.onloadedmetadata&&this.onloadedmetadata(),0)}})();`;
