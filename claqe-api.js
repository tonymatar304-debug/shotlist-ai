/* CLAQE API client: talks to the shotlist-api Worker (/pass, /status, /generate).
 * Framework-free. Browser: window.ClaqeAPI. Node (tests): require()/import. No endpoint is hard-coded:
 * set window.CLAQE_API_BASE (or, on localhost only, ?api=http://127.0.0.1:8787). */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ClaqeAPI = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

  // Where the API lives. Only an explicit global or (on localhost) ?api= is honoured, so a crafted link on the
  // live site cannot point the page at another server.
  function resolveBase({ configured, search = "", hostname = "" } = {}) {
    let raw = configured || null;
    if (!raw && LOCAL_HOSTS.includes(hostname)) raw = new URLSearchParams(search).get("api");
    if (!raw) return null;
    let u;
    try { u = new URL(raw); } catch { return null; }
    const local = LOCAL_HOSTS.includes(u.hostname);
    if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return null;
    return u.origin + u.pathname.replace(/\/+$/, "");
  }

  // Worker error code -> actionable text. Every `code` the Worker emits must appear here (checked by tests).
  const MESSAGES = {
    origin_not_allowed: { text: "This page isn't allowed to use the CLAQE server. Open CLAQE from its official address.", retry: false },
    verification_failed: { text: "Human verification failed. Complete the check again and retry.", retry: true },
    pass_required: { text: "Please complete the human check first, then try again.", retry: true },
    ai_disabled: { text: "AI editing is paused right now. You can still make a browser preview.", retry: false },
    rate_limited: { text: "Too many requests. Wait a few minutes and try again.", retry: true },
    invalid_request: { text: "Those clips couldn't be sent. Check that you have 2 to 5 valid clips (up to 60 seconds each) and try again.", retry: false },
    free_limit: { text: "You've used all your free AI edits for this month. You can still make a browser preview.", retry: false },
    quota_unconfigured: { text: "AI editing is temporarily unavailable. You can still make a browser preview.", retry: false },
    account_inactive: { text: "This account can't use AI editing.", retry: false },
    budget_daily: { text: "CLAQE's AI capacity for today is used up. Try again tomorrow, or make a browser preview.", retry: false },
    budget_monthly: { text: "CLAQE's AI capacity for this month is used up. You can still make a browser preview.", retry: false },
    ai_unavailable: { text: "The AI editor is temporarily unavailable. Your free edit was not used. Try again shortly.", retry: true },
    vision_unusable: { text: "The AI vision reply couldn't be used, so your film uses local footage analysis instead. Your free edit was not used.", retry: true },
    network: { text: "Couldn't reach the CLAQE server. Check your connection and try again.", retry: true },
    bad_response: { text: "The CLAQE server sent an unexpected reply. Try again later.", retry: true },
    server_error: { text: "Something went wrong on the server. Try again.", retry: true },
  };

  function toError(status, data) {
    let code = data && typeof data === "object" && typeof data.code === "string" ? data.code : null;
    if (!code) code = status === 401 ? "pass_required" : status >= 500 ? "server_error" : "bad_response";
    const m = MESSAGES[code] || MESSAGES.server_error;
    return { ok: false, status, code, message: m.text, retryable: m.retry };
  }

  function createClient({ baseUrl, fetch: fetchImpl } = {}) {
    if (!baseUrl) throw new Error("CLAQE API base URL is not configured.");
    const doFetch = fetchImpl || ((...a) => fetch(...a));
    async function request_(path, o) { return request(path, o); }
    async function request(path, { method = "GET", body } = {}) {
      let res;
      try {
        res = await doFetch(baseUrl + path, {
          method, credentials: "include", mode: "cors",
          headers: body === undefined ? {} : { "Content-Type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch { return toError(0, { code: "network" }); }
      let data = null;
      try { data = await res.json(); } catch { return toError(res.status, { code: "bad_response" }); }
      if (!res.ok || !data || data.ok !== true) return toError(res.status, data);
      return { ok: true, status: res.status, data };
    }
    return {
      // Semantic vision: one call per film. `request` is ClaqeVision.buildVisionRequest(); `images` = [{id, data(base64 JPEG)}].
      // Returns { ok, vision } (UNVALIDATED: pass through ClaqeVision.validateVisionResponse) or an error.
      async vision({ request, images }) {
        const r = await request_("/vision", { method: "POST", body: { request, images } });
        return r.ok ? { ok: true, status: r.status, vision: r.data.vision, passUsage: r.data.passUsage } : r;
      },
      // Exchange a Turnstile token for the pass cookie (HttpOnly; the page never sees it).
      async pass(turnstileToken) {
        if (!turnstileToken) return toError(403, { code: "verification_failed" });
        return request("/pass", { method: "POST", body: { turnstileToken } });
      },
      async status() { return request("/status"); },
      // Returns { ok, source: "ai" | "server-fallback", plan } or an error. NEVER invents a plan on failure.
      async generate({ clips, style, targetSeconds }) {
        const r = await request("/generate", { method: "POST", body: { clips: clips.map((c) => ({ duration: c.duration })), style, targetSeconds } });
        if (!r.ok) return r;
        const d = r.data;
        return { ok: true, status: r.status, source: d.usedFallback ? "server-fallback" : "ai", plan: d.plan, passUsage: d.passUsage };
      },
    };
  }

  // One-line quota text from a /status response (`data`). Never claims availability the server didn't confirm.
  function describeQuota(s) {
    if (!s || s.ok !== true) return "AI status unknown.";
    if (s.ai_enabled === false) return "AI editing is paused right now.";
    if (!s.pass || !s.pass.valid) return "Complete the human check to use AI editing.";
    if (s.quota_configured === false || !s.free) return "AI editing is temporarily unavailable.";
    const left = Math.max(0, s.free.limit - s.free.used);
    return s.free.used + " of " + s.free.limit + " free AI edits used this month" + (left === 0 ? " · none left" : "");
  }

  // Honest labelling: the browser-only plan is never presented as AI.
  const SOURCE_LABELS = {
    ai: "AI-assisted edit plan",
    "server-fallback": "Standard edit plan (the AI reply wasn't usable, so this is not AI-edited)",
    "ai-vision": "AI-assisted edit: an AI model described sampled frames; cuts combine that with local analysis",
    "local-analysis": "Footage-aware edit from local video analysis (not AI)",
    "browser-preview": "Browser preview · no AI",
  };
  const describeSource = (source) => SOURCE_LABELS[source] || SOURCE_LABELS["browser-preview"];

  return { resolveBase, createClient, describeQuota, describeSource, MESSAGES };
});
