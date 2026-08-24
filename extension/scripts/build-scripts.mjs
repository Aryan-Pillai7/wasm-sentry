/**
 * Bundles the non-HTML extension entry points.
 *
 * Vite owns the HTML entries (the popup and the dashboard) because it handles
 * asset graphs; it cannot own these, because Rollup will not emit several IIFE
 * bundles from one multi-entry build and MV3 content scripts cannot be ES
 * modules. esbuild does exactly this job in a few milliseconds, so the two
 * tools split along that line rather than fighting over it.
 *
 * The worker prelude is built first and to a string rather than to a file. It
 * does not run as an extension script at all: the page main world publishes it
 * as a `blob:` URL and workers load it from there, so what the injector needs
 * is its *source*, inlined at build time.
 */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const production = process.env["NODE_ENV"] === "production" || process.argv.includes("--prod");

const shared = {
  absWorkingDir: root,
  bundle: true,
  platform: "browser",
  target: "chrome111",
  minify: production,
};

/**
 * The prelude is always minified and never carries a source map: it is embedded
 * as a string literal inside another bundle, and an inline map would be a
 * second copy of the same code again.
 */
const prelude = await build({
  ...shared,
  entryPoints: ["src/content/worker-prelude.ts"],
  format: "iife",
  minify: true,
  write: false,
  logLevel: "warning",
});

const preludeSource = prelude.outputFiles[0].text;
console.log(`  worker prelude  ${(preludeSource.length / 1024).toFixed(1)}kb (inlined)`);

/** Content scripts must be classic scripts; the service worker is a module. */
const targets = [
  { entry: "src/content/injector.ts", outfile: "dist/injector.js", format: "iife" },
  { entry: "src/content/bridge.ts", outfile: "dist/bridge.js", format: "iife" },
  { entry: "src/background/service-worker.ts", outfile: "dist/background.js", format: "esm" },
];

await Promise.all(
  targets.map(({ entry, outfile, format }) =>
    build({
      ...shared,
      entryPoints: [entry],
      outfile,
      format,
      sourcemap: production ? false : "inline",
      define: {
        __WASM_SENTRY_WORKER_PRELUDE__: JSON.stringify(preludeSource),
      },
      logLevel: "info",
    }),
  ),
);
