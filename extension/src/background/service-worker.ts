// src/background/service-worker.ts
import { saveCapture } from "../utils/db";
import type { Capture } from "../types/capture";

chrome.webRequest.onCompleted.addListener(
  (details) => {
    const url = details.url;
    const type = details.type;

    if (url.endsWith(".wasm") || (type === "other" && url.includes("wasm"))) {
      console.log("[WASM-Sentry] Wasm module detected:", url);
      void logCapture({ type: "wasm", url, tabId: details.tabId ?? -1, timestamp: Date.now() });
    }

    if (type === "script") {
      console.log("[WASM-Sentry] JS bundle detected:", url);
      void logCapture({ type: "js", url, tabId: details.tabId ?? -1, timestamp: Date.now() });
    }
  },
  { urls: ["<all_urls>"] }
);

// now async, no more await-inside-non-async error
async function logCapture(entry: Capture): Promise<void> {
  await saveCapture(entry);
  await captureAndForward(entry.url, entry.tabId);
}

async function captureAndForward(url: string, tabId: number): Promise<void> {
  try {
    const response = await fetch(url);
    const buffer = await response.arrayBuffer();
    const bytes = Array.from(new Uint8Array(buffer));

    await fetch("http://localhost:3000/api/analyze/wasm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, tabId, bytes, timestamp: Date.now() }),
    });

    console.log("[WASM-Sentry] Forwarded:", url, `(${bytes.length} bytes)`);
  } catch (err) {
    console.error("[WASM-Sentry] Capture failed:", err);
  }
}