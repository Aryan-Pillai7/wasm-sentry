/**
 * SQLite storage for the backend.
 *
 * Uses Node's built-in `node:sqlite` rather than a native module. The point of
 * this project's dependency discipline is that the analysis engine has none at
 * all; a backend that needs a compiler toolchain to install is a backend nobody
 * runs, and the built-in driver is exactly as capable for a store this shape.
 *
 * Everything is synchronous. That is not a compromise: SQLite is a library, not
 * a server, and wrapping local file reads in promises would buy contention
 * management for a resource that has none.
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ArtifactAnalysis, RiskLevel } from "@wasm-sentry/core";

export type JobStatus = "queued" | "running" | "complete" | "failed";

export interface JobRow {
  id: string;
  hash: string;
  status: JobStatus;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  error: string | null;
}

export interface ResultRow {
  hash: string;
  job_id: string;
  analysis: string;
  risk_level: string | null;
  risk_score: number | null;
  created_at: number;
}

const SCHEMA = join(dirname(fileURLToPath(import.meta.url)), "schema.sql");

export interface Store {
  /** Record bytes, or bump the sighting count if the hash is already known. */
  putArtifact: (hash: string, bytes: Uint8Array) => { isNew: boolean };
  getArtifactBytes: (hash: string) => Uint8Array | undefined;
  enqueue: (hash: string) => JobRow;
  getJob: (id: string) => JobRow | undefined;
  /** The oldest queued job, or nothing. */
  nextQueued: () => JobRow | undefined;
  /** A job left `running` by a process that died. */
  nextRunning: () => JobRow | undefined;
  /** Put a job back in the queue, clearing whatever it recorded before. */
  requeue: (id: string) => void;
  markRunning: (id: string) => void;
  markComplete: (id: string) => void;
  markFailed: (id: string, error: string) => void;
  saveResult: (jobId: string, analysis: ArtifactAnalysis) => void;
  getResult: (hash: string) => ResultRow | undefined;
  countJobs: (status: JobStatus) => number;
  close: () => void;
}

/**
 * Open a store. `:memory:` gives an isolated database, which is what the tests
 * use -- a suite that shares a file with a running server is a suite that fails
 * for reasons that have nothing to do with the code.
 */
export function openStore(path: string): Store {
  const db = new DatabaseSync(path);
  // Write-ahead logging so a read while the queue is mid-write does not block.
  // Meaningless for `:memory:`, which is why the failure is ignored there.
  try {
    db.exec("PRAGMA journal_mode = WAL");
  } catch {
    /* Not supported for in-memory databases. */
  }
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(readFileSync(SCHEMA, "utf8"));

  const insertArtifact = db.prepare(
    `INSERT INTO artifacts (hash, size, bytes, first_seen, last_seen, seen_count)
     VALUES (?, ?, ?, ?, ?, 1)
     ON CONFLICT(hash) DO UPDATE SET last_seen = excluded.last_seen,
                                     seen_count = seen_count + 1`,
  );
  const selectArtifact = db.prepare("SELECT hash FROM artifacts WHERE hash = ?");
  const selectBytes = db.prepare("SELECT bytes FROM artifacts WHERE hash = ?");
  const insertJob = db.prepare(
    "INSERT INTO jobs (id, hash, status, created_at) VALUES (?, ?, 'queued', ?)",
  );
  const selectJob = db.prepare("SELECT * FROM jobs WHERE id = ?");
  const selectNext = db.prepare(
    "SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at, id LIMIT 1",
  );
  const selectRunning = db.prepare(
    "SELECT * FROM jobs WHERE status = 'running' ORDER BY created_at, id LIMIT 1",
  );
  const setQueued = db.prepare(
    "UPDATE jobs SET status = 'queued', started_at = NULL, error = NULL WHERE id = ?",
  );
  const setRunning = db.prepare("UPDATE jobs SET status = 'running', started_at = ? WHERE id = ?");
  const setComplete = db.prepare(
    "UPDATE jobs SET status = 'complete', finished_at = ? WHERE id = ?",
  );
  const setFailed = db.prepare(
    "UPDATE jobs SET status = 'failed', finished_at = ?, error = ? WHERE id = ?",
  );
  const upsertResult = db.prepare(
    `INSERT INTO results (hash, job_id, analysis, risk_level, risk_score, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(hash) DO UPDATE SET job_id = excluded.job_id,
                                     analysis = excluded.analysis,
                                     risk_level = excluded.risk_level,
                                     risk_score = excluded.risk_score,
                                     created_at = excluded.created_at`,
  );
  const selectResult = db.prepare("SELECT * FROM results WHERE hash = ?");
  const countByStatus = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = ?");

  let counter = 0;
  /** Monotonic within a process and unique across them. */
  const jobId = (): string => `job_${Date.now().toString(36)}_${(counter++).toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  return {
    putArtifact(hash, bytes) {
      const existing = selectArtifact.get(hash) !== undefined;
      const now = Date.now();
      insertArtifact.run(hash, bytes.length, bytes, now, now);
      return { isNew: !existing };
    },

    getArtifactBytes(hash) {
      const row = selectBytes.get(hash) as { bytes?: Uint8Array } | undefined;
      return row?.bytes;
    },

    enqueue(hash) {
      const id = jobId();
      const now = Date.now();
      insertJob.run(id, hash, now);
      return {
        id,
        hash,
        status: "queued",
        created_at: now,
        started_at: null,
        finished_at: null,
        error: null,
      };
    },

    getJob: (id) => selectJob.get(id) as JobRow | undefined,
    nextQueued: () => selectNext.get() as JobRow | undefined,
    nextRunning: () => selectRunning.get() as JobRow | undefined,
    requeue: (id) => void setQueued.run(id),
    markRunning: (id) => void setRunning.run(Date.now(), id),
    markComplete: (id) => void setComplete.run(Date.now(), id),
    markFailed: (id, error) => void setFailed.run(Date.now(), error.slice(0, 2000), id),

    saveResult(jobId, analysis) {
      upsertResult.run(
        analysis.hash,
        jobId,
        JSON.stringify(analysis),
        analysis.risk?.level ?? null,
        analysis.risk?.score ?? null,
        Date.now(),
      );
    },

    getResult: (hash) => selectResult.get(hash) as ResultRow | undefined,
    countJobs: (status) => Number((countByStatus.get(status) as { n: number }).n),
    close: () => db.close(),
  };
}

/** The stored analysis, parsed back out of its JSON column. */
export function parseResult(row: ResultRow): {
  analysis: ArtifactAnalysis;
  level: RiskLevel | null;
  score: number | null;
} {
  return {
    analysis: JSON.parse(row.analysis) as ArtifactAnalysis,
    level: (row.risk_level as RiskLevel | null) ?? null,
    score: row.risk_score,
  };
}
