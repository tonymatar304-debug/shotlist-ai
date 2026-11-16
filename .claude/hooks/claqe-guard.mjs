#!/usr/bin/env node
// CLAQE safeguard (Claude Code PreToolUse hook). Reads the tool call as JSON on stdin.
//  - exit 2 + stderr  -> the call is BLOCKED and the reason is shown to Claude.
//  - JSON "ask"       -> the user must approve it, even if a permission rule would allow it.
//  - exit 0, no output -> normal permission handling (default approval prompts stay on).
// Protects: main / production (GitHub Pages is served from main), deployments, DNS / Cloudflare changes, credentials,
// paid API calls, and the safeguard files themselves. Changes to this file must be made by the user.
import { execFileSync } from "node:child_process";

let input = "";
for await (const chunk of process.stdin) input += chunk;
let call; try { call = JSON.parse(input); } catch { process.exit(0); }
const tool = call.tool_name || "", ti = call.tool_input || {}, cwd = call.cwd || process.cwd();

const block = (why) => { process.stderr.write("CLAQE guard blocked this: " + why + " Ask the user if it is really needed.\n"); process.exit(2); };
const ask = (why) => { process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: "CLAQE: " + why } })); process.exit(0); };
const branch = () => { try { return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, encoding: "utf8" }).trim(); } catch { return ""; } };

// Credentials: never read, print or stage them (Worker secrets live in Cloudflare; local ones in .dev.vars / .env).
const SECRET_FILE = /(^|[\\/\s"'=])(\.dev\.vars[\w.-]*|\.env(\.[\w-]+)?|[\w.-]+\.(pem|key|p12|pfx)|credentials(\.json)?|\.npmrc|\.netrc|id_(rsa|ed25519)[\w.]*)(["'\s]|$)/i;
const isExample = (s) => /\.env\.(example|sample|template)\b/i.test(s);
// Safeguard files: only the user edits them.
const GUARDED = /[\\/]\.claude[\\/](settings(\.local)?\.json|hooks[\\/])/i;

if (/^(Read|Edit|Write|MultiEdit|NotebookEdit|Grep|Glob)$/.test(tool)) {
  const p = String(ti.file_path || ti.path || ti.notebook_path || "") + " " + String(ti.pattern && tool === "Glob" ? ti.pattern : "");
  const globSecret = tool === "Glob" && /\.dev\.vars|(^|[\\/])\.env(?!\.(example|sample|template))/i.test(String(ti.pattern || ""));
  if ((SECRET_FILE.test(" " + p + " ") && !isExample(p)) || globSecret) block("credential files (.dev.vars, .env, keys) must not be read or written.");
  if (/^(Edit|Write|MultiEdit)$/.test(tool) && GUARDED.test(p)) block("CLAQE safeguard files (.claude/settings*.json, .claude/hooks/) are changed by the user only.");
  process.exit(0);
}

if (/^mcp__.*cloudflare/i.test(tool)) {
  // Read-only Cloudflare tools are fine; anything that can change resources, DNS or run arbitrary API calls is not.
  if (/(_list|_get|search|docs|whoami|documentation|guide)$/i.test(tool)) process.exit(0);
  block("Cloudflare changes (resources, D1 queries, DNS, API execute) need the user.");
}

if (tool !== "Bash" && tool !== "PowerShell") process.exit(0);
const cmd = String(ti.command || "");
// normalised: single spaces, and "git -C dir / -c k=v push" treated as "git push"
const c = " " + cmd.replace(/\s+/g, " ").replace(/\bgit((\s+-[cC]\s+("[^"]*"|'[^']*'|\S+))+)/g, "git") + " ";

// --- credentials / paid APIs ---
if (/\b(cat|type|more|less|head|tail|gc|get-content|sls|select-string|grep|rg|findstr|code|notepad)\b[^|;&]*(\.dev\.vars|[\\/ ]\.env\b(?!\.(example|sample|template)))/i.test(c)) block("reading credential files.");
if (/\$(env:)?\{?[A-Z_]*(API_KEY|SECRET|TOKEN)\b|\bprintenv\b|\b(Get-ChildItem|gci|ls|dir)\s+env:|^\s*(env|set|export\s+-p)\s*$/i.test(c)) block("printing environment secrets.");
if (/\bwrangler\b[^|;&]*\bsecret\b/i.test(c)) block("Worker secrets are managed by the user.");
if (/api\.anthropic\.com|api\.openai\.com/i.test(c)) block("direct paid AI API calls need explicit approval.");
if (/\bgit\s+add\b[^|;&]*(\s-f\b|--force)/i.test(c) || /\bgit\s+add\b[^|;&]*(\.dev\.vars|\.env\b)/i.test(c)) block("staging ignored or credential files.");

// --- deployment / production / DNS ---
if (/\bwrangler\b[^|;&]*\b(deploy|publish|rollback|delete)\b/i.test(c) || /\bwrangler\b[^|;&]*\bversions\s+(deploy|upload)\b/i.test(c)) block("deployments need the user.");
if (/\bwrangler\b[^|;&]*\b(d1|kv|r2)\b[^|;&]*--remote\b/i.test(c) || /\bwrangler\b[^|;&]*\bkv\b[^|;&]*\b(put|delete)\b(?![^|;&]*--local)/i.test(c)) block("changing remote (production) data.");
if (/\b(npm|pnpm|yarn)\s+(run\s+)?deploy\b|\bcf\s+deploy\b|\bvercel\b|\bnetlify\s+deploy\b|\bfirebase\s+deploy\b|\bgh\s+(pr\s+merge|release\s+create|workflow\s+run)\b/i.test(c)) block("deploy / release / merge operations need the user.");
if (/api\.cloudflare\.com/i.test(c) || (/dns|cname|nameserver/i.test(c) && /\b(curl|Invoke-RestMethod|Invoke-WebRequest|irm|iwr|wrangler|cf)\b/i.test(c))) block("Cloudflare API / DNS changes need the user.");
if (/\bgit\b[^|;&]*\b(rm|mv)\b[^|;&]*\bCNAME\b/i.test(c)) block("CNAME (the production domain) is changed by the user only.");

// --- git: protect main, never rewrite shared history, every push is approved by the user ---
if (/\bgit\b/i.test(c)) {
  const onMain = () => /^(main|master)$/.test(branch());
  if (/\bgit\s+push\b/i.test(c)) {
    if (/\s(-f|--force|--force-with-lease|--mirror|--delete|-d)\b|\s\+\S+/i.test(c)) block("force, mirror or delete pushes.");
    if (/\s(\S*:)?(refs\/heads\/)?(main|master)(\s|$)/i.test(c.replace(/\bgit\s+push\b/i, ""))) block("pushing to main (production).");
    if (onMain()) block("pushing while main is checked out.");
    ask("every push needs your approval (CLAQE never pushes automatically).");
  }
  if (/\bgit\s+(checkout|switch)\s+(-\S+\s+)*(main|master)\b/i.test(c)) block("switching to main; CLAQE works on claude-development.");
  if (/\bgit\s+(commit|merge|rebase|cherry-pick|revert|reset|am|pull)\b/i.test(c) && onMain()) block("changing main; switch to claude-development.");
  if (/\bgit\s+branch\b[^|;&]*\s-(d|D|-delete|m|M|-move)\b[^|;&]*\b(main|master|claude-development)\b/i.test(c)) block("deleting or renaming protected branches.");
  if (/\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|filter-branch|filter-repo|update-ref\s+-d)\b/i.test(c)) ask("this discards work or rewrites history.");
}
process.exit(0);
