-- shotlist-db schema, copied VERBATIM from the remote database's sqlite_master (read-only query, 2026-11-14).
-- Reference/local use only. NEVER run this against the remote database: the tables already exist there.
CREATE TABLE budget_ledger (period TEXT PRIMARY KEY, used_usd REAL NOT NULL DEFAULT 0, updated_at INTEGER);
CREATE TABLE rate_limits (key TEXT NOT NULL, window_start INTEGER NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (key, window_start));
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE usage_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, user_id TEXT, ip_hash TEXT, provider TEXT, model TEXT, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, cost_usd REAL DEFAULT 0, status TEXT NOT NULL, duration_ms INTEGER, error TEXT);
CREATE TABLE users (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, plan TEXT NOT NULL DEFAULT 'free', status TEXT NOT NULL DEFAULT 'active', email TEXT);
CREATE INDEX idx_usage_ts ON usage_log(ts);
CREATE INDEX idx_usage_user_ts ON usage_log(user_id, ts);
