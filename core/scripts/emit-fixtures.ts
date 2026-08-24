/**
 * Write the test fixtures out as real .wasm files.
 *
 * Used for end-to-end testing: serve them from a page and check that the
 * extension captures, parses and scores them the same way the unit tests do.
 * The "miner" fixture only performs arithmetic in a loop -- it computes nothing
 * and talks to nothing. It is shaped like a mining kernel so the detector has
 * something honest to fire on, without a real malware sample in the repository.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  benignModule,
  minerLikeModule,
  sustainedKernelModule,
  syntheticMinerModule,
} from "../test/fixtures.js";

const outDir = process.argv[2] ?? "fixtures-out";
mkdirSync(outDir, { recursive: true });

const files = {
  "miner.wasm": syntheticMinerModule(),
  "miner-no-threads.wasm": syntheticMinerModule({ shared: false }),
  "kernel-only.wasm": minerLikeModule(),
  "sustained-kernel.wasm": sustainedKernelModule(),
  "benign.wasm": benignModule(),
};

for (const [name, bytes] of Object.entries(files)) {
  const path = join(outDir, name);
  writeFileSync(path, bytes);
  console.log(`${path}  ${bytes.length} B  engineValid=${WebAssembly.validate(bytes)}`);
}
