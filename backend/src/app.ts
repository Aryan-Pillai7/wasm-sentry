/**
 * The HTTP API.
 *
 * Built as a factory taking its store and queue rather than reaching for
 * module-level singletons, so a test drives the real routes against an
 * in-memory database instead of asserting against a mock of them.
 *
 * The trust model is the extension's, restated: nothing the client says about
 * an artifact is believed. The bytes are re-sniffed and re-hashed here, and the
 * hash computed here is the one everything is keyed by. A client that supplies
 * a hash is supplying a *claim*, which is checked and rejected if it is wrong --
 * not because the claim is dangerous, but because a mismatch means the two ends
 * disagree about which module is being discussed, and that is worth failing on.
 */
import express from "express";
import cors from "cors";
import { isWasm, sha256 } from "@wasm-sentry/core";
import { parseResult } from "./db/index.js";
import type { Store } from "./db/index.js";
import type { Queue } from "./queue.js";

/** Matches the extension's cap. Anything larger was refused before it got here. */
export const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;

const HASH_PATTERN = /^[0-9a-f]{64}$/;

export interface AppOptions {
  store: Store;
  queue: Queue;
  version: string;
}

export function createApp(options: AppOptions): express.Express {
  const { store, queue, version } = options;
  const app = express();

  app.use(cors());
  app.disable("x-powered-by");

  /**
   * Artifacts arrive as raw bytes.
   *
   * The first prototype accepted a JSON array of numbers and paid roughly 4x
   * inflation for it, which is why its body limit had to be 50 MB. Raw octets
   * cost exactly what the module costs.
   */
  app.use(
    "/api/artifacts",
    express.raw({ type: "application/octet-stream", limit: MAX_ARTIFACT_BYTES }),
  );

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      service: "wasm-sentry-backend",
      version,
      queued: store.countJobs("queued"),
      running: store.countJobs("running"),
    });
  });

  app.post("/api/artifacts", (req, res) => {
    void (async () => {
      const body: unknown = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        res.status(400).json({
          error: "expected a non-empty application/octet-stream body",
        });
        return;
      }

      const bytes = new Uint8Array(body);

      // Magic bytes, not the declared type. An attacker controls the header; a
      // module that does not start with `\0asm` is not one the engine would run
      // either.
      if (!isWasm(bytes)) {
        res.status(415).json({ error: "not a WebAssembly module" });
        return;
      }

      const hash = await sha256(bytes);
      const claimed = req.header("x-artifact-hash");
      if (claimed !== undefined && claimed.toLowerCase() !== hash) {
        res.status(409).json({
          error: "X-Artifact-Hash does not match the bytes received",
          hash,
        });
        return;
      }

      // Already analysed: the verdict is a function of the bytes, and the bytes
      // have not changed. Re-queueing would spend a parse to produce the answer
      // already sitting in the row below.
      const existing = store.getResult(hash);
      store.putArtifact(hash, bytes);
      if (existing) {
        res.status(200).json({ status: "known", hash });
        return;
      }

      const job = store.enqueue(hash);
      queue.poke();
      res.status(202).json({ job_id: job.id, status: job.status, hash });
    })().catch((error: unknown) => {
      console.error("[wasm-sentry] upload failed", error);
      if (!res.headersSent) res.status(500).json({ error: "upload failed" });
    });
  });

  app.get("/api/jobs/:id", (req, res) => {
    const job = store.getJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: "no such job" });
      return;
    }
    res.json({
      job_id: job.id,
      hash: job.hash,
      status: job.status,
      created_at: job.created_at,
      started_at: job.started_at,
      finished_at: job.finished_at,
      ...(job.error !== null ? { error: job.error } : {}),
    });
  });

  app.get("/api/results/:hash", (req, res) => {
    const hash = req.params.hash.toLowerCase();
    if (!HASH_PATTERN.test(hash)) {
      res.status(400).json({ error: "hash must be 64 lowercase hex characters" });
      return;
    }

    const row = store.getResult(hash);
    if (!row) {
      // Distinguishing "queued" from "never heard of it" matters to a client
      // deciding whether to wait or to upload.
      res.status(404).json({
        error: "no result for this artifact",
        known: store.getArtifactBytes(hash) !== undefined,
      });
      return;
    }

    const { analysis, level, score } = parseResult(row);
    res.json({ hash, level, score, analysis, analysed_at: row.created_at });
  });

  return app;
}
