// src/popup/Popup.tsx
import { useState, useEffect } from "react";
import type { Capture } from '../types/capture';

export default function Popup() {
  const [captures, setCaptures] = useState<Capture[]>([]);

  useEffect(() => {
    chrome.storage.local.get("captures", (result) => {
      const data = result['captures'] as Capture[]; 
      setCaptures(data || []);
    });
  }, []);

  return (
    <div style={{ width: 320, padding: 16 }}>
      <h2>WASM-Sentry</h2>
      <p>{captures.length} modules intercepted</p>
      {captures.map((c: Capture, i: number) => (
        <div key={i}>
          <span>{c.type.toUpperCase()}</span> — {c.url.slice(0, 50)}...
        </div>
      ))}
    </div>
  );
}