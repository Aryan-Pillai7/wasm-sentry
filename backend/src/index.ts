/**
 * Wasm-Sentry backend.
 *
 * Deliberately thin as of Phase 1. The extension now analyses locally by
 * default and only uploads when the user opts in, so the backend is not on the
 * critical path for a capture. Phase 2 gives it the SQLite store and job queue
 * described in `docs/architecture.md`; until then it exposes health only,
 * rather than an endpoint that accepts artifacts and silently drops them.
 */
import express from "express";
import cors from "cors";

const PORT = Number(process.env["PORT"] ?? 3000);

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "wasm-sentry-backend", version: "0.1.0" });
});

app.listen(PORT, () => {
  console.log(`[wasm-sentry] backend listening on http://localhost:${PORT}`);
});
