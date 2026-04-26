// backend/src/routes/analyze.ts
import { Router, Request, Response } from 'express';

const router = Router();

router.post("/api/analyze/wasm", async (req: Request, res: Response) => {
    const { url, tabId, bytes, timestamp } = req.body;

    // stub: just log and return a fake job_id
    console.log(`[Backend] Received wasm from ${url} — ${bytes.length} bytes`);

    // later: enqueue to job queue, run WABT, etc.
    res.json({
        job_id: `job-${Date.now()}`,
        status: "queued",
        message: "received — analysis not yet implemented"
    });
});

export default router;