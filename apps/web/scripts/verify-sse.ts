/**
 * Behavioral check for the fetch-based SSE helper (packages/core/src/lib/transport/sse.ts).
 * Run: node --import tsx apps/web/scripts/verify-sse.ts   (needs only a loopback http server)
 *
 * Covers: chunk-split parsing (CRLF, multi-line data, comments), Authorization header
 * pass-through, reconnect after a mid-stream drop with Last-Event-ID, server `retry:`,
 * no retry on 401, abort.
 */
import http from "node:http";
import assert from "node:assert/strict";
import { SSEParser, streamSSE, type SSEMessage } from "../../../packages/core/src/lib/transport/sse.ts";

// --- parser ---
const p = new SSEParser();
const got: SSEMessage[] = [];
for (const chunk of [": hi\r\nid: 1\r\nev", "ent: turn\r\ndata: a\r\ndata: b\r\n", "\r\ndata: x\n\n"]) got.push(...p.push(chunk));
assert.deepEqual(got, [
  { event: "turn", data: "a\nb", id: "1" },
  { event: "message", data: "x", id: undefined },
]);

// --- stream + reconnect ---
const seenHeaders: http.IncomingHttpHeaders[] = [];
let n = 0;
const server = http.createServer((req, res) => {
  seenHeaders.push(req.headers);
  if (req.url === "/denied") {
    res.writeHead(401).end();
    return;
  }
  n++;
  res.writeHead(200, { "content-type": "text/event-stream" });
  if (n === 1) {
    res.write("retry: 10\nid: 5\ndata: one\n\n");
    setTimeout(() => res.destroy(), 20); // drop mid-stream
  } else {
    res.write("id: 6\ndata: two\n\n");
    setTimeout(() => res.end(), 20);
  }
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const events: string[] = [];
const ac = new AbortController();
await streamSSE(`${base}/s`, {
  headers: { Authorization: "Bearer pd_test" },
  signal: ac.signal,
  onEvent: (m) => {
    events.push(m.data);
    if (m.data === "two") return "stop";
  },
});
assert.deepEqual(events, ["one", "two"]);
assert.equal(seenHeaders[0].authorization, "Bearer pd_test");
assert.equal(seenHeaders[0]["last-event-id"], undefined);
assert.equal(seenHeaders[1]["last-event-id"], "5", "reconnect resumes from the last id");

// --- fatal 401: no retry ---
let errs = 0;
await streamSSE(`${base}/denied`, { onEvent() {}, onError: (_e, i) => { errs++; assert.equal(i.willRetry, false); } });
assert.equal(errs, 1);

// --- abort ---
const ac2 = new AbortController();
setTimeout(() => ac2.abort(), 50);
await streamSSE(`${base}/s`, { signal: ac2.signal, reconnect: true, retryMs: 5, onEvent() {} });

server.close();
console.log("✓ verify-sse: parser, auth header, reconnect + Last-Event-ID, 401 fatal, abort");
