# Backend tests

Run: `npm test` (from `shotlist-api-dev/`). Everything is local: a temp local D1, `wrangler dev --local`, a mock Anthropic
server, and Cloudflare's official Turnstile dummy secrets (siteverify is called; free). No deploy, no remote D1, no paid API.

## Schema
`../schema.sql` is copied verbatim from the remote `shotlist-db` (read-only `sqlite_master` query, 2026-11-14); `seed.sql` mirrors its
`settings` rows. Never run `schema.sql` against the remote DB.

Remaining notes:
- `users` and `settings.free_monthly_limit` exist remotely but the Worker never uses them (pass uid is a random UUID).
- `usage_log.duration_ms` is always written as 0; `error` is never written.
- No cleanup of old `rate_limits` rows exists; the table grows unbounded.
- `used_usd` is a float; repeated reserve/release can drift slightly.
- Duplicate Turnstile tokens are tested via the official "already spent" secret, not real token reuse.
