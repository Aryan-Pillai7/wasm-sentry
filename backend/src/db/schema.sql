-- backend/src/db/schema.sql

CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    tab_id INTEGER,
    site TEXT,
    created_at INTEGER
);

CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    type TEXT,        -- 'wasm' or 'js'
    url TEXT,
    status TEXT,      -- 'queued', 'processing', 'complete', 'failed'
    created_at INTEGER,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE results (
    id TEXT PRIMARY KEY,
    job_id TEXT,
    raw_json TEXT,    -- full analysis result stored as JSON string
    risk_level TEXT,
    created_at INTEGER,
    FOREIGN KEY (job_id) REFERENCES jobs(id)
);