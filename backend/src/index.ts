/**
 * Wasm-Sentry backend.
 *
 * Optional and off by default. The extension analyses locally and only uploads
 * when the user turns it on, so nothing here is on the critical path of a
 * capture -- which is the point: a security tool that ships every module a page
 * runs to a server by default is an exfiltration channel wearing a badge.
 *
 * What it adds when it is switched on is a place to keep artifacts across
 * browsers and re-run analysis after a rule change, without the browser having
 * to see the module again.
 */
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createApp } from "./app.js";
import { openStore } from "./db/index.js";
import { createQueue, requeueAbandoned } from "./queue.js";

const VERSION = "0.2.0";
const PORT = Number(process.env["PORT"] ?? 3000);
const DB_PATH = resolve(process.env["WASM_SENTRY_DB"] ?? "data/wasm-sentry.sqlite");

mkdirSync(dirname(DB_PATH), { recursive: true });

const store = openStore(DB_PATH);
const queue = createQueue({ store });

// A process killed mid-analysis leaves a job marked `running` that nothing will
// ever finish. Analysis is deterministic, so re-running one costs a parse.
const resumed = requeueAbandoned(store);
if (resumed > 0) console.log(`[wasm-sentry] re-queued ${resumed} job(s) abandoned by a restart`);

const app = createApp({ store, queue, version: VERSION });

const server = app.listen(PORT, () => {
  console.log(`[wasm-sentry] backend listening on http://localhost:${PORT}`);
  console.log(`[wasm-sentry] store: ${DB_PATH}`);
  queue.poke();
});

/** Close the database on the way out, so a WAL is checkpointed rather than left. */
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
  });
}
