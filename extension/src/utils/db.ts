// src/utils/db.ts
import type { Capture, AnalysisResult } from "../types/capture";

const DB_NAME = "wasm-sentry";
const DB_VERSION = 1;

export function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      if (!db.objectStoreNames.contains("captures")) {
        const store = db.createObjectStore("captures", {
          keyPath: "id",
          autoIncrement: true,
        });
        store.createIndex("by_tab", "tabId", { unique: false });
        store.createIndex("by_type", "type", { unique: false });
      }

      if (!db.objectStoreNames.contains("results")) {
        const store = db.createObjectStore("results", { keyPath: "job_id" });
        store.createIndex("by_url", "url", { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveCapture(entry: Capture): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("captures", "readwrite");
    const store = tx.objectStore("captures");
    const request = store.add(entry);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function saveResult(result: AnalysisResult): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("results", "readwrite");
    const store = tx.objectStore("results");
    const request = store.put(result);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function getCapturesByTab(tabId: number): Promise<Capture[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("captures", "readonly");
    const store = tx.objectStore("captures");
    const index = store.index("by_tab");
    const request = index.getAll(tabId);
    request.onsuccess = () => resolve(request.result as Capture[]);
    request.onerror = () => reject(request.error);
  });
}