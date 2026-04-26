import express from "express";
import cors from "cors";
import { Router, Request, Response } from "express";

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

const router = Router();

router.get("/health", (req: Request, res: Response) => {
  res.json({ status: "ok" });
});

router.post("/api/analyze/wasm", (req: Request, res: Response) => {
  const { url, tabId, bytes, timestamp } = req.body;
  console.log(`[Backend] Received wasm from ${url} — ${bytes?.length} bytes`);
  res.json({
    job_id: `job-${Date.now()}`,
    status: "queued",
    message: "received — analysis not yet implemented"
  });
});

router.post("/api/analyze/js-bundle", (req: Request, res: Response) => {
  const { url, tabId } = req.body;
  console.log(`[Backend] Received JS bundle from ${url}`);
  res.json({
    job_id: `job-${Date.now()}`,
    status: "queued",
    message: "received — analysis not yet implemented"
  });
});

app.use(router);

app.listen(3000, () => {
  console.log("Backend running on http://localhost:3000");
});