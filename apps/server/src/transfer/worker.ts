/**
 * The transfer worker thread (see worker-pool.ts): content conversion for
 * exports and the whole CPU half of an import. Nothing here may import the
 * database, the config or the network — a worker is a separate isolate with no
 * request context, and it is killed without warning when a task overruns.
 */
import { parentPort } from "node:worker_threads";
import { marked } from "marked";
import { sanitizeHtml } from "@prism/core/import-export";
import { ImportError, newTurndown, planUpload, type PlanRequest } from "./import-plan";

export type WorkerRequest =
  | { op: "to-markdown"; html: string }
  | { op: "to-html"; content: string; isHtml: boolean }
  | PlanRequest;

const turndown = newTurndown();

function handle(req: WorkerRequest): { value: unknown; transfer?: ArrayBuffer[] } {
  switch (req.op) {
    case "to-markdown":
      return { value: turndown.turndown(req.html) };
    case "to-html":
      // Stored HTML and rendered Markdown alike leave through the allowlist sanitiser.
      return { value: sanitizeHtml(req.isHtml ? req.content : (marked.parse(req.content) as string)) };
    case "import-plan": {
      const result = planUpload(req);
      return { value: result, transfer: result.assets.map((a) => a.bytes.buffer as ArrayBuffer) };
    }
  }
}

parentPort!.on("message", (req: WorkerRequest) => {
  try {
    const { value, transfer } = handle(req);
    parentPort!.postMessage({ ok: true, value }, transfer ?? []);
  } catch (e) {
    const err = e as Error;
    parentPort!.postMessage(e instanceof ImportError ? { ok: false, error: err.message, code: e.code, status: e.status } : { ok: false, error: "failed", code: "failed" });
  }
});

// Loaded: tasks may come (their deadline starts only now).
parentPort!.postMessage({ ready: true });
