/**
 * Deduplicate a corpus by SHA-256, within and across classes.
 *
 *   npm run dedupe-corpus -w @wasm-sentry/core -- <corpus-dir>
 *
 * Within a class: keeps the first file (alphabetical) for each hash, moves
 * the rest into "<class>-duplicates". Across classes: a hash appearing in
 * both benign/ and malicious/ is a labelling contradiction and is never
 * resolved automatically -- it is printed so you resolve it by hand.
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "../src/hash.js";

const corpusDir = process.argv[2];
if (!corpusDir) {
  console.error("usage: dedupe-corpus <corpus-dir>");
  process.exit(2);
}

interface Entry {
  className: "benign" | "malicious";
  name: string;
  path: string;
  hash: string;
}

async function loadClass(className: "benign" | "malicious"): Promise<Entry[]> {
  const dir = join(corpusDir!, className);
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".wasm"));
  } catch {
    return [];
  }
  names.sort();

  const entries: Entry[] = [];
  for (const name of names) {
    const path = join(dir, name);
    if (!statSync(path).isFile()) continue;
    const hash = await sha256(readFileSync(path));
    entries.push({ className, name, path, hash });
  }
  return entries;
}

const benign = await loadClass("benign");
const malicious = await loadClass("malicious");
const all = [...benign, ...malicious];

const byHash = new Map<string, Entry[]>();
for (const entry of all) {
  const bucket = byHash.get(entry.hash) ?? [];
  bucket.push(entry);
  byHash.set(entry.hash, bucket);
}

let withinDupes = 0;
let contradictions = 0;

for (const [hash, entries] of byHash) {
  if (entries.length < 2) continue;

  const classes = new Set(entries.map((e) => e.className));
  if (classes.size > 1) {
    contradictions++;
    console.log(`CONTRADICTION ${hash.slice(0, 12)}: ${entries.map((e) => e.path).join(" == ")}`);
    continue;
  }

  const [keep, ...rest] = entries;
  for (const dupe of rest) {
    const dupDir = join(corpusDir!, `${dupe.className}-duplicates`);
    mkdirSync(dupDir, { recursive: true });
    renameSync(dupe.path, join(dupDir, dupe.name));
    withinDupes++;
  }
  console.log(`duplicate ${hash.slice(0, 12)}: kept ${keep!.path}, moved ${rest.length}`);
}

console.log(`\n${all.length} files, ${byHash.size} unique hashes`);
console.log(`  ${withinDupes} within-class duplicates moved aside`);
if (contradictions > 0) {
  console.error(
    `  ${contradictions} cross-class contradictions -- resolve by hand before training. Nothing was moved for these.`,
  );
  process.exit(1);
}
