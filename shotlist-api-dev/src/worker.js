const ALLOWED_ORIGIN = "https://claqe.com";
const PASS_TTL_SECONDS = 60 * 60 * 24 * 30;
const PASS_LIMIT = 30;
const IP_LIMIT = 60;
const WINDOW_SECONDS = 600;
const EST_COST = 0.003; // safe worst-case reservation per generate call
const MODEL = "claude-haiku-5-5";
const MAX_OUTPUT_TOKENS = 500;
const FREE_MAX_CLIPS = 4;
const FREE_MAX_SECONDS = 30;
const STYLES = ["cinematic", "dynamic", "vintage"];

function b64url(bytes) {
  let bin = "";
  bytes.forEach(b => bin += String.fromCharCode(b));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return b64url(new Uint8Array(sig));
}
async function sha256hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}
function getCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  const match = header.match(new RegExp("(?:^|; )" + name + "=([^;]+)"));
  return match ? match[1] : null;
}
async function issuePass(secret) {
  const uid = crypto.randomUUID();
  const exp = Math.floor(Date.now() / 1000) + PASS_TTL_SECONDS;
  const sig = await hmac(secret, uid + "." + exp);
  return { token: `${uid}.${exp}.${sig}`, uid, exp };
}
async function verifyPass(token, secret) {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [uid, exp, sig] = parts;
  const expected = await hmac(secret, uid + "." + exp);
  if (expected !== sig) return null;
  if (Number(exp) < Math.floor(Date.now() / 1000)) return null;
  return { uid, exp: Number(exp) };
}
async function verifyTurnstile(token, secret, ip) {
  if (!token) return false;
  const body = new FormData();
  body.append("secret", secret);
  body.append("response", token);
  if (ip) body.append("remoteip", ip);
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
    const data = await res.json();
    return data.success === true;
  } catch { return false; }
}
async function getSettings(db) {
  const { results } = await db.prepare("SELECT key, value FROM settings").all();
  const s = {};
  for (const row of results) s[row.key] = row.value;
  return s;
}
async function ensureUser(db, uid) {
  await db.prepare("INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)").bind(uid, Date.now()).run();
  return await db.prepare("SELECT plan, status FROM users WHERE id = ?").bind(uid).first();
}
// Successful generations (ok or fallback) this UTC month; failed upstream calls are never logged, so never counted.
async function monthlyUsage(db, uid) {
  const d = new Date();
  const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const row = await db.prepare("SELECT COUNT(*) AS n FROM usage_log WHERE user_id = ? AND ts >= ? AND status IN ('ok','fallback')")
    .bind(uid, monthStart).first();
  return row ? row.n : 0;
}
// Returns a non-negative integer, or null when missing/invalid. Callers MUST fail closed on null for free users.
function freeLimitOf(settings) {
  const v = String(settings.free_monthly_limit ?? "").trim();
  return /^[0-9]{1,6}$/.test(v) ? Number(v) : null;
}
async function checkAndIncrementLimit(db, key, limit) {
  const windowStart = Math.floor(Date.now() / 1000 / WINDOW_SECONDS) * WINDOW_SECONDS;
  const row = await db.prepare(
    `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
     ON CONFLICT(key, window_start) DO UPDATE SET count = count + 1
     RETURNING count`
  ).bind(key, windowStart).first();
  return { count: row.count, limit, allowed: row.count <= limit };
}
async function reserve(db, period, cost, limit) {
  await db.prepare("INSERT OR IGNORE INTO budget_ledger (period, used_usd, updated_at) VALUES (?, 0, ?)")
    .bind(period, Date.now()).run();
  const row = await db.prepare(
    `UPDATE budget_ledger SET used_usd = used_usd + ?, updated_at = ?
     WHERE period = ? AND used_usd + ? <= ?
     RETURNING used_usd`
  ).bind(cost, Date.now(), period, cost, limit).first();
  return !!row;
}
async function release(db, period, cost) {
  if (cost <= 0) return;
  await db.prepare("UPDATE budget_ledger SET used_usd = MAX(0, used_usd - ?) WHERE period = ?")
    .bind(cost, period).run();
}
function dailyPeriod() { const d = new Date(); return "d:" + d.getUTCFullYear() + "-" + (d.getUTCMonth() + 1) + "-" + d.getUTCDate(); }
function monthlyPeriod() { const d = new Date(); return "m:" + d.getUTCFullYear() + "-" + (d.getUTCMonth() + 1); }
async function ledgerValue(db, period) {
  const row = await db.prepare("SELECT used_usd FROM budget_ledger WHERE period = ?").bind(period).first();
  return row ? row.used_usd : 0;
}

function fallbackPlan(clips, targetSeconds) {
  const n = clips.length;
  const base = targetSeconds / n;
  return clips.map((c, i) => {
    const duration = Math.max(0.8, Math.min(c.duration - 0.1, base));
    const start = Math.max(0, Math.min(c.duration - duration - 0.05, i % 2 === 0 ? 0.2 : 0.5));
    return { index: i, start: Math.round(start * 10) / 10, duration: Math.round(duration * 10) / 10 };
  });
}
function validatePlan(plan, clips, targetSeconds) {
  if (!Array.isArray(plan) || plan.length !== clips.length) return false;
  const seen = new Set();
  let total = 0;
  for (const item of plan) {
    if (typeof item.index !== "number" || typeof item.start !== "number" || typeof item.duration !== "number") return false;
    if (seen.has(item.index)) return false;
    seen.add(item.index);
    const clip = clips[item.index];
    if (!clip) return false;
    if (item.start < 0 || item.duration < 0.5) return false;
    if (item.start + item.duration > clip.duration + 0.2) return false;
    total += item.duration;
  }
  if (seen.size !== clips.length) return false;
  if (total > targetSeconds + 1.5) return false;
  return true;
}
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
async function callClaude(apiKey, clips, style, targetSeconds, apiUrl) {
  const clipList = clips.map((c, i) => `${i}: ${c.duration.toFixed(1)}s long`).join("\n");
  const prompt = `You are editing a short ${style} film from these raw clips (metadata only, you cannot see the footage):\n${clipList}\n\nDecide the play order, a start time and a duration for each clip. Rules:\n- Every clip index 0 to ${clips.length - 1} appears exactly once.\n- start + duration must not exceed that clip's own length.\n- Each duration is at least 1 second.\n- The total of all durations must not exceed ${targetSeconds} seconds.\n- Vary durations naturally rather than splitting evenly, fitting the "${style}" feel (cinematic = slower, longer holds; dynamic = short punchy cuts with variation; vintage = medium, slightly uneven pacing).\n\nReply with ONLY this JSON shape, nothing else, no code fences, no commentary:\n{"order":[{"index":0,"start":0,"duration":4.5}]}`;

  const res = await fetch(apiUrl || ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      messages: [{ role: "user", content: prompt }]
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error("Claude API error: " + (data.error?.message || res.status));
  const text = (data.content || []).map(b => b.text || "").join("");
  const usage = data.usage || { input_tokens: 0, output_tokens: 0 };
  let parsed;
  try {
    const match = text.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(match ? match[0] : text);
  } catch { parsed = null; }
  return { order: parsed?.order, usage };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    const headers = {
      "Content-Type": "application/json",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Credentials": "true",
      "Vary": "Origin"
    };
    if (origin === ALLOWED_ORIGIN) headers["Access-Control-Allow-Origin"] = ALLOWED_ORIGIN;
    const reply = (body, status = 200, extraHeaders = {}) =>
      new Response(JSON.stringify(body, null, 2), { status, headers: { ...headers, ...extraHeaders } });

    if (origin && origin !== ALLOWED_ORIGIN) return reply({ ok: false, code: "origin_not_allowed", error: "Origin not allowed" }, 403);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });

    try {
      if (url.pathname === "/test") {
        return reply({ ok: true, service: "shotlist-api-dev", time: new Date().toISOString() });
      }

      if (url.pathname === "/pass") {
        let turnstileToken = null;
        if (request.method === "POST") {
          try { turnstileToken = (await request.json()).turnstileToken; } catch {}
        }
        const ip = request.headers.get("CF-Connecting-IP") || "unknown";
        const passed = await verifyTurnstile(turnstileToken, env.TURNSTILE_SECRET, ip);
        if (!passed) return reply({ ok: false, code: "verification_failed", error: "Human verification failed. Please try again." }, 403);
        const { token, uid, exp } = await issuePass(env.PASS_SECRET);
        await ensureUser(env.DB, uid);
        return reply(
          { ok: true, message: "Pass issued.", uid, expires: new Date(exp * 1000).toISOString() },
          200,
          { "Set-Cookie": `slai_pass=${token}; Max-Age=${PASS_TTL_SECONDS}; Path=/; Secure; HttpOnly; SameSite=None` }
        );
      }

      if (url.pathname === "/status") {
        const pass = await verifyPass(getCookie(request, "slai_pass"), env.PASS_SECRET);
        const settings = await getSettings(env.DB);
        const dUsed = await ledgerValue(env.DB, dailyPeriod());
        const mUsed = await ledgerValue(env.DB, monthlyPeriod());
        const freeLimit = freeLimitOf(settings);
        const free = pass && freeLimit !== null ? { used: await monthlyUsage(env.DB, pass.uid), limit: freeLimit } : undefined;
        return reply({
          ok: true,
          quota_configured: freeLimit !== null,
          free,
          pass: pass ? { uid: pass.uid, valid: true } : { valid: false, message: "No valid pass. Visit /pass first." },
          ai_enabled: settings.ai_enabled === "1",
          budget: { daily_used: dUsed.toFixed(4), daily_limit: settings.daily_budget_usd, monthly_used: mUsed.toFixed(4), monthly_limit: settings.monthly_budget_usd }
        });
      }

      if (url.pathname === "/generate") {
        const pass = await verifyPass(getCookie(request, "slai_pass"), env.PASS_SECRET);
        if (!pass) return reply({ ok: false, code: "pass_required", error: "No valid pass. Visit /pass first, then retry." }, 401);

        const settings = await getSettings(env.DB);
        if (settings.ai_enabled !== "1") return reply({ ok: false, code: "ai_disabled", error: "Generation is currently disabled." }, 403);

        const ip = request.headers.get("CF-Connecting-IP") || "unknown";
        const ipHash = await sha256hex(ip);
        // IP limit counts every request (including malformed ones) as abuse protection.
        const ipLimitRes = await checkAndIncrementLimit(env.DB, "ip:" + ipHash, IP_LIMIT);
        if (!ipLimitRes.allowed) {
          return reply({ ok: false, code: "rate_limited", error: "Rate limit reached. Try again later." }, 429);
        }

        let body;
        try { body = await request.json(); } catch { return reply({ ok: false, code: "invalid_request", error: "Invalid request." }, 400); }
        if (!body || typeof body !== "object") return reply({ ok: false, code: "invalid_request", error: "Invalid request." }, 400);
        const clips = Array.isArray(body.clips) ? body.clips : [];
        const style = STYLES.includes(body.style) ? body.style : "cinematic";
        const targetSeconds = Math.min(FREE_MAX_SECONDS, Math.max(5, Number(body.targetSeconds) || FREE_MAX_SECONDS));

        if (clips.length < 2 || clips.length > FREE_MAX_CLIPS) {
          return reply({ ok: false, code: "invalid_request", error: `Select between 2 and ${FREE_MAX_CLIPS} clips.` }, 400);
        }
        for (const c of clips) {
          if (!c || typeof c.duration !== "number" || !Number.isFinite(c.duration) || c.duration < 1 || c.duration > 300) {
            return reply({ ok: false, code: "invalid_request", error: "Each clip needs a valid duration." }, 400);
          }
        }

        // Per-user monthly quota (users.plan / users.status / settings.free_monthly_limit). Checked after validation.
        const user = await ensureUser(env.DB, pass.uid);
        if (user.status !== "active") return reply({ ok: false, code: "account_inactive", error: "This account is not active." }, 403);
        const freeLimit = freeLimitOf(settings);
        if (user.plan === "free" && freeLimit === null) {
          return reply({ ok: false, code: "quota_unconfigured", error: "Generation is temporarily unavailable." }, 503);
        }
        if (user.plan === "free" && (await monthlyUsage(env.DB, pass.uid)) >= freeLimit) {
          return reply({ ok: false, code: "free_limit", error: "Free monthly limit reached." }, 429);
        }

        // The user's generation allowance is only charged for well-formed requests.
        const passLimit = await checkAndIncrementLimit(env.DB, "pass:" + pass.uid, PASS_LIMIT);
        if (!passLimit.allowed) {
          return reply({ ok: false, code: "rate_limited", error: "Rate limit reached. Try again later." }, 429);
        }

        const dPeriod = dailyPeriod(), mPeriod = monthlyPeriod();
        const dailyLimit = parseFloat(settings.daily_budget_usd || "0");
        const monthlyLimit = parseFloat(settings.monthly_budget_usd || "0");

        const dOk = await reserve(env.DB, dPeriod, EST_COST, dailyLimit);
        if (!dOk) return reply({ ok: false, code: "budget_daily", error: "Daily budget cap reached." }, 402);
        const mOk = await reserve(env.DB, mPeriod, EST_COST, monthlyLimit);
        if (!mOk) { await release(env.DB, dPeriod, EST_COST); return reply({ ok: false, code: "budget_monthly", error: "Monthly budget cap reached." }, 402); }

        let order, usage, usedFallback = false, status = "ok";
        try {
          // ANTHROPIC_API_URL is only set in local tests (mock server); production uses the default.
          const result = await callClaude(env.ANTHROPIC_API_KEY, clips, style, targetSeconds, env.ANTHROPIC_API_URL);
          usage = result.usage;
          if (validatePlan(result.order, clips, targetSeconds)) {
            order = result.order;
          } else {
            order = fallbackPlan(clips, targetSeconds);
            usedFallback = true;
          }
        } catch (err) {
          console.error(err);
          await release(env.DB, dPeriod, EST_COST);
          await release(env.DB, mPeriod, EST_COST);
          return reply({ ok: false, code: "ai_unavailable", error: "The AI editor is temporarily unavailable. Please try again." }, 502);
        }

        const inTok = usage?.input_tokens || 0;
        const outTok = usage?.output_tokens || 0;
        const realCost = (inTok / 1e6) * 0.10 + (outTok / 1e6) * 0.50;
        const refund = Math.max(0, EST_COST - realCost);
        await release(env.DB, dPeriod, refund);
        await release(env.DB, mPeriod, refund);

        await env.DB.prepare(
          `INSERT INTO usage_log (ts, user_id, ip_hash, provider, model, input_tokens, output_tokens, cost_usd, status, duration_ms)
           VALUES (?, ?, ?, 'anthropic', ?, ?, ?, ?, ?, 0)`
        ).bind(Date.now(), pass.uid, ipHash, MODEL, inTok, outTok, realCost, usedFallback ? "fallback" : "ok").run();

        return reply({ ok: true, plan: { order, style, targetSeconds }, usedFallback, passUsage: `${passLimit.count}/${PASS_LIMIT}`, ipUsage: `${ipLimitRes.count}/${IP_LIMIT}` });
      }

      return reply({ ok: false, error: "Unknown path" }, 404);
    } catch (err) {
      console.error(err);
      return reply({ ok: false, error: "Something went wrong. Please try again." }, 500);
    }
  }
};