/**
 * Collapse near-duplicates within each class by cosine similarity over the
 * model's own feature vector -- exact-hash dedup (dedupe-corpus.ts) does not
 * catch a miner rebuilt with a different compiler flag or embedded pool URL.
 *
 *   npm run cluster-corpus -w @wasm-sentry/core -- <corpus-dir> [--threshold 0.999] [--max-size-ratio 3]
 *
 * Within each class: clusters files whose vectors are more similar than
 * --threshold AND whose byte sizes are within --max-size-ratio of each
 * other, keeps one representative (alphabetically first) per cluster, moves
 * the rest into "<class>-near-duplicates/<cluster-id>/". Only clusters of
 * size > 1 produce a move; run this AFTER filter-corpus and dedupe-corpus,
 * and BEFORE split-holdout.
 *
 * The size guard exists because cosine similarity alone is not enough:
 * `vectorise()` is dominated by ratios and log-scaled magnitudes, and two
 * simple modules that share mostly-zero features (no float ops, no shared
 * memory, no kernel candidate -- the common case for small utility/glue
 * code) can point in nearly the same direction despite being completely
 * unrelated programs. Observed directly on a real corpus: a single cluster
 * spanning 2KB to 511KB -- a 250x size range -- got flagged as one cluster
 * by cosine similarity alone. A true rebuild of the same source at a
 * different optimisation level does not vary in size anywhere near that
 * much, so the two checks together are what "near-duplicate" actually means
 * here, not either one on its own.
 *
 * Membership is against a fixed seed representative, not transitive
 * (single-linkage/union-find) chaining. A -> B -> C -> D can each stay
 * within the size ratio of its immediate neighbour while A and D end up two
 * orders of magnitude apart -- observed directly: adding the size guard to
 * a union-find version of this script barely changed the result, because
 * the same 2KB-511KB cluster re-formed through a chain of pairwise-close
 * files. Every member here must be independently close to the one
 * representative, so a cluster's actual size spread is bounded by
 * --max-size-ratio, not by how long a chain the corpus happens to contain.
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { analyzeWasm } from "../src/analysis.js";
import { vectorise } from "../src/ml/features.js";

const args = process.argv.slice(2);
const corpusDir = args.find((arg) => !arg.startsWith("--"));
const thresholdIndex = args.indexOf("--threshold");
const threshold = thresholdIndex >= 0 ? Number(args[thresholdIndex + 1]) : 0.999;
const maxSizeRatioIndex = args.indexOf("--max-size-ratio");
const maxSizeRatio = maxSizeRatioIndex >= 0 ? Number(args[maxSizeRatioIndex + 1]) : 3;

if (!corpusDir) {
  console.error("usage: cluster-corpus <corpus-dir> [--threshold 0.999] [--max-size-ratio 3]");
  process.exit(2);
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return na === nb ? 1 : 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function clusterClass(className: "benign" | "malicious"): void {
  const dir = join(corpusDir!, className);
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".wasm"));
  } catch {
    console.log(`${className}: ${dir} not readable, skipping`);
    return;
  }
  names.sort();

  console.log(`${className}: parsing ${names.length} files...`);
  const items: { name: string; path: string; vector: number[]; size: number }[] = [];
  for (let i = 0; i < names.length; i++) {
    const name = names[i]!;
    const path = join(dir, name);
    const stat = statSync(path);
    if (!stat.isFile()) continue;
    const result = analyzeWasm(readFileSync(path));
    if (!result.ok) continue; // filter-corpus should already have removed these
    items.push({ name, path, vector: vectorise(result.features), size: stat.size });
    if ((i + 1) % 1000 === 0) console.log(`  ${className}: parsed ${i + 1}/${names.length}`);
  }

  // Seed/star clustering, not union-find: process candidates in name order so
  // the earliest (alphabetically) unassigned item becomes each cluster's
  // representative, exactly as before -- but every other member must match
  // THAT representative directly, never a chain of intermediate members.
  //
  // Sorting by size still makes candidate lookup fast (binary-search the
  // window within maxSizeRatio of the seed), it just no longer determines
  // cluster membership by itself the way union-find's traversal order did.
  const bySize = items.map((item, i) => ({ item, i })).sort((a, b) => a.item.size - b.item.size);
  const sizes = bySize.map((entry) => entry.item.size);
  const lowerBound = (value: number): number => {
    let lo = 0;
    let hi = sizes.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (sizes[mid]! < value) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  const byName = items.map((item, i) => ({ item, i })).sort((a, b) => a.item.name.localeCompare(b.item.name));
  const assigned = new Array<boolean>(items.length).fill(false);
  const clusters: number[][] = [];

  console.log(`${className}: clustering ${items.length} files (size-windowed against each seed)...`);
  for (let processed = 0; processed < byName.length; processed++) {
    const seed = byName[processed]!;
    if (assigned[seed.i]) continue;

    const seedSize = seed.item.size;
    const lo = lowerBound(seedSize / maxSizeRatio);
    const hi = lowerBound(seedSize * maxSizeRatio + 1); // +1: lowerBound is exclusive of an exact match at the edge
    const members = [seed.i];
    for (let k = lo; k < hi; k++) {
      const candidate = bySize[k]!;
      if (candidate.i === seed.i || assigned[candidate.i]) continue;
      if (cosineSimilarity(seed.item.vector, candidate.item.vector) >= threshold) members.push(candidate.i);
    }

    if (members.length > 1) {
      for (const i of members) assigned[i] = true;
      clusters.push(members);
    }
    if ((processed + 1) % 1000 === 0) console.log(`  ${className}: processed ${processed + 1}/${byName.length}`);
  }

  let collapsed = 0;
  let clusterCount = 0;
  for (const members of clusters) {
    clusterCount++;
    const sorted = members.map((i) => items[i]!).sort((a, b) => a.name.localeCompare(b.name));
    const [keep, ...rest] = sorted;
    const clusterDir = join(corpusDir!, `${className}-near-duplicates`, `cluster-${clusterCount}`);
    mkdirSync(clusterDir, { recursive: true });
    for (const dupe of rest) {
      renameSync(dupe.path, join(clusterDir, dupe.name));
      collapsed++;
    }
    console.log(`${className} cluster-${clusterCount}: kept ${keep!.name}, collapsed ${rest.length}`);
  }

  console.log(`${className}: ${items.length} files, ${clusterCount} clusters found, ${collapsed} moved aside`);
}

clusterClass("benign");
clusterClass("malicious");
console.log(
  "\nIf you compiled variants deliberately (self-compiled miners, multiple -O levels), " +
    "review each cluster before trusting the auto-picked representative -- " +
    "grouping intentional variants under one representative is correct; " +
    "collapsing an unrelated pair because two modules happen to be structurally similar is not.",
);
