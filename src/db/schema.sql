CREATE TABLE IF NOT EXISTS source_events (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    repo_id TEXT NOT NULL,
    author_id TEXT,
    event_ts DATETIME NOT NULL,
    raw_url TEXT NOT NULL,
    tier TEXT NOT NULL DEFAULT 'A'
);
CREATE INDEX IF NOT EXISTS idx_source_events_repo_ts
    ON source_events (repo_id, event_ts);
CREATE INDEX IF NOT EXISTS idx_source_events_ts
    ON source_events (event_ts);

CREATE TABLE IF NOT EXISTS repositories (
    repo_id TEXT PRIMARY KEY,
    repo_url TEXT NOT NULL,
    created_at DATETIME,
    stars INTEGER DEFAULT 0,
    last_seen_at DATETIME
);

CREATE TABLE IF NOT EXISTS repo_score_snapshots (
    repo_id TEXT NOT NULL,
    window_start DATETIME NOT NULL,
    window_end DATETIME NOT NULL,
    mention_count INTEGER NOT NULL,
    unique_source_count INTEGER NOT NULL,
    star_delta INTEGER NOT NULL,
    score REAL NOT NULL,
    PRIMARY KEY (repo_id, window_end)
);
CREATE INDEX IF NOT EXISTS idx_repo_score_snapshots_window_end
    ON repo_score_snapshots (window_end);

CREATE TABLE IF NOT EXISTS alerts_sent (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id TEXT NOT NULL,
    score REAL NOT NULL,
    sent_to TEXT NOT NULL,
    sent_at DATETIME NOT NULL,
    is_critical INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_alerts_sent_repo_target_ts
    ON alerts_sent (repo_id, sent_to, sent_at DESC);

CREATE TABLE IF NOT EXISTS source_health (
    source TEXT PRIMARY KEY,
    success_count INTEGER NOT NULL DEFAULT 0,
    failure_count INTEGER NOT NULL DEFAULT 0,
    consecutive_rate_limit_failures INTEGER NOT NULL DEFAULT 0,
    last_status INTEGER,
    last_error TEXT,
    last_success_at DATETIME,
    last_failure_at DATETIME,
    is_disabled INTEGER NOT NULL DEFAULT 0,
    updated_at DATETIME NOT NULL
);
