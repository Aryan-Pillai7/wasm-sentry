-- backend/src/db/schema.sql
--
-- Applied on every start; every statement is idempotent, so starting against an
-- existing database is the same as starting against a new one.
--
-- Identity is the artifact's content hash, exactly as it is in the extension.
-- A URL is attacker-controlled, cache-busted and sometimes single-use; the hash
-- is none of those, and using the same key in both places is what lets a
-- verdict computed here mean the same thing as one computed in the browser.

CREATE TABLE IF NOT EXISTS artifacts (
    hash        TEXT PRIMARY KEY,       -- SHA-256 of bytes, lowercase hex
    size        INTEGER NOT NULL,
    bytes       BLOB NOT NULL,          -- kept so a rule change can re-run
    first_seen  INTEGER NOT NULL,
    last_seen   INTEGER NOT NULL,
    seen_count  INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS jobs (
    id          TEXT PRIMARY KEY,
    hash        TEXT NOT NULL,
    status      TEXT NOT NULL,          -- queued | running | complete | failed
    created_at  INTEGER NOT NULL,
    started_at  INTEGER,
    finished_at INTEGER,
    error       TEXT,
    FOREIGN KEY (hash) REFERENCES artifacts(hash)
);

CREATE INDEX IF NOT EXISTS jobs_by_hash ON jobs(hash);
CREATE INDEX IF NOT EXISTS jobs_by_status ON jobs(status);

-- One row per artifact, not per job: re-analysing a module replaces its verdict
-- rather than accumulating a history of the same answer.
CREATE TABLE IF NOT EXISTS results (
    hash        TEXT PRIMARY KEY,
    job_id      TEXT NOT NULL,
    analysis    TEXT NOT NULL,          -- ArtifactAnalysis as JSON
    risk_level  TEXT,
    risk_score  INTEGER,
    created_at  INTEGER NOT NULL,
    FOREIGN KEY (job_id) REFERENCES jobs(id)
);

CREATE INDEX IF NOT EXISTS results_by_level ON results(risk_level);
