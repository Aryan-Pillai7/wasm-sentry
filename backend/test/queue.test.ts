import { test } from "node:test";
import assert from "node:assert/strict";
import { createQueue } from "../src/queue.js";
import type { JobRow, Store } from "../src/db/index.js";

/**
 * The queue against a stub store.
 *
 * `api.test.ts` drives the queue through SQLite, which is the right way to test
 * the happy path and the wrong way to test the unhappy ones: the schema's
 * foreign key makes a job without its artifact impossible to create, so the
 * branch that handles one can only be reached from here. That branch is not
 * dead code -- it is what stops a job nothing can finish from sitting in the
 * queue forever -- and a defence nobody has ever executed is a defence nobody
 * knows works.
 */

interface Stub extends Store {
  jobs: Map<string, JobRow>;
  results: string[];
}

function stubStore(overrides: { bytes?: Uint8Array } = {}): Stub {
  const jobs = new Map<string, JobRow>();
  const results: string[] = [];
  let counter = 0;

  const store: Stub = {
    jobs,
    results,
    putArtifact: () => ({ isNew: true }),
    getArtifactBytes: () => overrides.bytes,
    enqueue: (hash) => {
      const job: JobRow = {
        id: `job-${counter++}`,
        hash,
        status: "queued",
        created_at: counter,
        started_at: null,
        finished_at: null,
        error: null,
      };
      jobs.set(job.id, job);
      return job;
    },
    getJob: (id) => jobs.get(id),
    nextQueued: () => [...jobs.values()].find((job) => job.status === "queued"),
    nextRunning: () => [...jobs.values()].find((job) => job.status === "running"),
    requeue: (id) => void (jobs.get(id)!.status = "queued"),
    markRunning: (id) => void (jobs.get(id)!.status = "running"),
    markComplete: (id) => void (jobs.get(id)!.status = "complete"),
    markFailed: (id, error) => {
      const job = jobs.get(id)!;
      job.status = "failed";
      job.error = error;
    },
    saveResult: (_jobId, analysis) => void results.push(analysis.hash),
    getResult: () => undefined,
    staleHashes: () => [],
    countJobs: (status) => [...jobs.values()].filter((job) => job.status === status).length,
    close: () => {},
  };
  return store;
}

/** Smallest legal module: magic and version, no sections. */
const MODULE = Uint8Array.of(0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00);

test("a job whose artifact has vanished fails instead of hanging", async () => {
  const store = stubStore();
  const queue = createQueue({ store });
  const job = store.enqueue("deadbeef");

  queue.poke();
  await queue.drain();

  const failed = store.getJob(job.id)!;
  assert.equal(failed.status, "failed");
  assert.match(failed.error ?? "", /no longer stored/);
  assert.deepEqual(store.results, [], "and no verdict is invented for it");
});

test("jobs are worked oldest first, one at a time", async () => {
  const store = stubStore({ bytes: MODULE });
  const order: string[] = [];
  const queue = createQueue({ store, onFinished: (_id, hash) => order.push(hash) });

  store.enqueue("first");
  store.enqueue("second");
  store.enqueue("third");

  queue.poke();
  await queue.drain();

  assert.deepEqual(order, ["first", "second", "third"]);
  assert.equal(store.countJobs("complete"), 3);
  assert.equal(queue.busy(), false);
});

test("draining an empty queue resolves rather than waiting for work", async () => {
  const queue = createQueue({ store: stubStore({ bytes: MODULE }) });
  await queue.drain();
});

test("a store that throws does not wedge the queue", async () => {
  const store = stubStore({ bytes: MODULE });
  store.enqueue("boom");
  store.markRunning = () => {
    throw new Error("database is locked");
  };

  const queue = createQueue({ store });
  queue.poke();

  // The failure is logged and the queue goes idle. A queue that stayed `busy`
  // after throwing would refuse every job that came after it.
  await queue.drain();
  assert.equal(queue.busy(), false);
});
