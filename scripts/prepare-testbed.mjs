/**
 * Copies the built main-world injector next to the testbed page.
 *
 * `standalone.html` loads the real `injector.js` with a plain script tag, which
 * lets the capture layer -- worker instrumentation included -- be exercised in a
 * real browser without installing the extension. A static file server cannot
 * reach up out of the directory it serves, so the bundle is copied in rather
 * than linked.
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "extension", "dist", "injector.js");
const target = join(root, "testbed", "injector.js");

if (!existsSync(source)) {
  console.warn(
    "[testbed] extension/dist/injector.js is missing -- run `npm run build` first.\n" +
      "          The buttons on index.html still work; standalone.html will not.",
  );
} else {
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  console.log("[testbed] copied the built injector.js for standalone.html");
}
