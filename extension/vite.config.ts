import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * The popup and dashboard are the HTML entries. The content scripts and the service worker are built
 * by `scripts/build-scripts.mjs` -- see the note there for why.
 *
 * `emptyOutDir` is off because that script writes into the same `dist/`, and
 * whichever tool ran second would otherwise delete the other's output.
 */
export default defineConfig({
  plugins: [react()],
  build: {
    emptyOutDir: false,
    rollupOptions: {
      input: {
        popup: "src/popup/popup.html",
        dashboard: "src/dashboard/dashboard.html",
      },
      output: {
        entryFileNames: "[name].js",
      },
    },
  },
});
