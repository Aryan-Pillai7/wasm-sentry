import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main: "index.html",                        // web dashboard
        popup: "src/popup/popup.html",             // extension popup
        background: "src/background/service-worker.ts",
        content: "src/content/injector.ts",
      },
      output: {
        entryFileNames: "[name].js",
      },
    },
  },
});