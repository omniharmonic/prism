/**
 * The conversion worker thread (see worker-pool.ts): content conversion for
 * exports, the whole CPU half of an import, and — through convert/service.ts —
 * every Markdown/HTML/ProseMirror conversion collab and the Prism MCP need. Nothing here may import the
 * database, the config or the network — a worker is a separate isolate with no
 * request context, and it is killed without warning when a task overruns.
 */
import { parentPort, workerData } from "node:worker_threads";
import { marked } from "marked";
import { sanitizeHtml } from "@prism/core/import-export";
import { ImportError, newTurndown, planUpload, type PlanRequest } from "./import-plan";

export type WorkerRequest =
  | { op: "to-markdown"; html: string }
  | { op: "to-html"; content: string; isHtml: boolean }
  | PlanRequest
  // The conversion service (convert/service.ts): collab seeding/folding/storing and the MCP note resource.
  | { op: "md-html"; content: string }
  | { op: "html-md"; html: string; flavor?: "blocks" }
  | { op: "doc-json"; content: string; markdown: boolean }
  | { op: "doc-seed"; content: string }
  | { op: "doc-html"; json: unknown };

const turndown = newTurndown();

// The document conversions pull in TipTap + a DOM; loaded on first use so an
// export/import worker that never needs them does not pay for it.
let docCore: Promise<typeof import("../convert/core")> | null = null;
const loadCore = () => (docCore ??= import("../convert/core"));

async function handle(req: WorkerRequest): Promise<{ value: unknown; transfer?: ArrayBuffer[] }> {
  switch (req.op) {
    case "md-html":
      return { value: (await loadCore()).markdownToHtmlSync(req.content) };
    case "html-md": {
      const c = await loadCore();
      return { value: req.flavor === "blocks" ? c.blocksHtmlToMarkdownSync(req.html) : c.htmlToMarkdownSync(req.html) };
    }
    case "doc-json": {
      const c = await loadCore();
      return { value: req.markdown ? c.contentToDocJsonSync(req.content) : c.htmlToDocJsonSync(req.content) };
    }
    case "doc-seed": {
      const seed = (await loadCore()).contentToSeedSync(req.content);
      // Hand back an exactly-sized buffer (the encoder's may be larger / shared).
      const bytes = seed.slice();
      return { value: bytes, transfer: [bytes.buffer as ArrayBuffer] };
    }
    case "doc-html":
      return { value: (await loadCore()).docJsonToHtmlSync(req.json) };
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

parentPort!.on("message", async (req: WorkerRequest) => {
  try {
    const { value, transfer } = await handle(req);
    parentPort!.postMessage({ ok: true, value }, transfer ?? []);
  } catch (e) {
    const err = e as Error;
    parentPort!.postMessage(e instanceof ImportError ? { ok: false, error: err.message, code: e.code, status: e.status } : { ok: false, error: "failed", code: "failed" });
  }
});

// The conversion service's threads load the document converters up front: a task's
// deadline must measure the conversion, not a module load.
if ((workerData as { preload?: string } | undefined)?.preload === "doc") await loadCore();

// Loaded: tasks may come (their deadline starts only now).
parentPort!.postMessage({ ready: true });
