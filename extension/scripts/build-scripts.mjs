/**
 * Bundles the three non-HTML extension entry points.
 *
 * Vite owns the HTML entries (popup, and later the dashboard) because it
 * handles asset graphs; it cannot own these three, because Rollup will not emit
 * several IIFE bundles from one multi-entry build and MV3 content scripts
 * cannot be ES modules. esbuild does exactly this job in a few milliseconds, so
 * the two tools split along that line rather than fighting over it.
 */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const production = process.env["NODE_ENV"] === "production" || process.argv.includes("--prod");

/** Content scripts must be classic scripts; the service worker is a module. */
const targets = [
  { entry: "src/content/injector.ts", outfile: "dist/injector.js", format: "iife" },
  { entry: "src/content/bridge.ts", outfile: "dist/bridge.js", format: "iife" },
  { entry: "src/background/service-worker.ts", outfile: "dist/background.js", format: "esm" },
];

await Promise.all(
  targets.map(({ entry, outfile, format }) =>
    build({
      absWorkingDir: root,
      entryPoints: [entry],
      outfile,
      bundle: true,
      format,
      platform: "browser",
      target: "chrome111",
      minify: production,
      sourcemap: production ? false : "inline",
      logLevel: "info",
    }),
  ),
);
