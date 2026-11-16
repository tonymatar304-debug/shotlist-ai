// CLAQE safeguard hook (.claude/hooks/claqe-guard.mjs): blocks main/production/deploy/DNS/credential operations,
// asks for every push, and lets ordinary development through. Runs the real hook with Claude Code's stdin JSON.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const HOOK = path.join(ROOT, ".claude", "hooks", "claqe-guard.mjs");
function run(tool_name, tool_input) {
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ tool_name, tool_input, cwd: ROOT }), encoding: "utf8" });
  if (r.status === 2) return "block";
  if (r.status === 0 && /"permissionDecision":"ask"/.test(r.stdout)) return "ask";
  if (r.status === 0) return "allow";
  return "error " + r.status + " " + r.stderr;
}
const sh = (command) => ["Bash", "PowerShell"].map((t) => run(t, { command }));

test("blocked: main / force pushes, deploys, remote data, DNS, CNAME, secrets, paid API calls", () => {
  for (const cmd of [
    "git push origin main", "git push origin HEAD:main", "git push -f origin claude-development", "git push --force-with-lease",
    "git push origin +claude-development", "git push origin --delete claude-development", "git -C . push origin main",
    "git checkout main", "git switch main", "git branch -D claude-development",
    "npx wrangler deploy", "cd shotlist-api-dev && wrangler deploy --env production", "wrangler versions deploy", "wrangler secret put ANTHROPIC_API_KEY",
    "wrangler d1 execute claqe --remote --command 'DELETE FROM quota'", "npm run deploy", "gh pr merge 3", "gh release create v1",
    "curl -X POST https://api.cloudflare.com/client/v4/zones/x/dns_records", "git rm CNAME",
    "cat shotlist-api-dev/.dev.vars", "Get-Content .env", "echo $ANTHROPIC_API_KEY", "echo $env:ANTHROPIC_API_KEY", "printenv", "Get-ChildItem env:",
    "curl https://api.anthropic.com/v1/messages -d @x.json", "git add -f .dev.vars", "git add shotlist-api-dev/.dev.vars",
  ]) assert.deepEqual(sh(cmd), ["block", "block"], cmd);
});

test("every push to the development branch needs the user's approval", () => {
  for (const cmd of ["git push origin claude-development", "git push origin 33feec6:claude-development", "git push"]) assert.deepEqual(sh(cmd), ["ask", "ask"], cmd);
  assert.deepEqual(sh("git reset --hard HEAD~1"), ["ask", "ask"]);
});

test("ordinary development is not blocked (default permission prompts still apply)", () => {
  for (const cmd of ["git status --short", "git log --oneline -5", "git add index.html claqe-color.js", "git commit -m 'Fix main menu: keep the main flow'",
    "git diff main..claude-development --stat", "git fetch origin", "cd tests && npm test", "node e2e/render-bench.mjs clip.mp4", "npx wrangler dev --env dev",
    "wrangler d1 execute claqe --local --command 'SELECT 1'", "Get-Content index.html", "cat .env.example"]) assert.deepEqual(sh(cmd), ["allow", "allow"], cmd);
});

test("files: credentials and the safeguard files are protected; code is not", () => {
  assert.equal(run("Read", { file_path: path.join(ROOT, "shotlist-api-dev", ".dev.vars") }), "block");
  assert.equal(run("Read", { file_path: path.join(ROOT, ".env.local") }), "block");
  assert.equal(run("Glob", { pattern: "**/.env*" }), "block");
  assert.equal(run("Edit", { file_path: path.join(ROOT, ".claude", "settings.json") }), "block");
  assert.equal(run("Write", { file_path: path.join(ROOT, ".claude", "hooks", "claqe-guard.mjs") }), "block");
  assert.equal(run("Read", { file_path: path.join(ROOT, ".claude", "settings.json") }), "allow");
  assert.equal(run("Edit", { file_path: path.join(ROOT, "index.html") }), "allow");
  assert.equal(run("Edit", { file_path: path.join(ROOT, "docs", "CLAQE_ROADMAP.md") }), "allow");
  assert.equal(run("Read", { file_path: path.join(ROOT, ".env.example") }), "allow");
});

test("Cloudflare tools: read-only allowed, changes blocked", () => {
  assert.equal(run("mcp__claude_ai_Cloudflare_Developer_Platform__workers_list", {}), "allow");
  assert.equal(run("mcp__plugin_cloudflare_cloudflare__search", {}), "allow");
  assert.equal(run("mcp__plugin_cloudflare_cloudflare__execute", {}), "block");
  assert.equal(run("mcp__claude_ai_Cloudflare_Developer_Platform__d1_database_query", {}), "block");
  assert.equal(run("mcp__claude_ai_Cloudflare_Developer_Platform__kv_namespace_delete", {}), "block");
});
