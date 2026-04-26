// src/types/capture.ts

export type CaptureType = "wasm" | "js";

export interface Capture {
  type: CaptureType;
  url: string;
  tabId: number;
  timestamp: number;
}

export interface AnalysisResult {
  job_id: string;
  url: string;
  risk_level: string;
  raw_json: object;
}