# Parachute issue: support chunked / range reads of note content over MCP

**For:** Aaron (Parachute maintainer)
**From:** Benjamin (via Prism integration work)
**Parachute version observed:** 0.5.x — MCP over Streamable HTTP, vault-scoped `/vault/{name}/mcp`; REST at `/vault/{name}/api`.

## Summary

There is no way to read a **large note's content in pieces** through the MCP `query-notes` tool. Any MCP client (Claude Code, Claude Desktop) that asks for a big note's content gets the entire body in a single tool response, which blows past the client's per-tool-result token limit. This makes large notes (in practice **> ~90 KB / ~25k tokens**) effectively unreadable by an MCP-only agent.

## Why the obvious client-side workaround doesn't work

When an MCP tool result is too large to inline, Claude Code spills it to a temp file and the agent reads it with the `Read` tool. But:

- The note **content is a single JSON string field**, i.e. one enormous line.
- `Read`'s `offset`/`limit` are **line-based**, so they cannot sub-divide a single line.
- Reading that one line exceeds the 25k-token `Read` cap → the read fails.

Net: line-based chunking can't split a one-line body, and there's no content-range parameter on the tool, so the agent has no MCP-native way to page through the content.

## Concrete failure

Processing Fathom meeting transcripts (an automated "meeting-processor" agent). Transcripts of **103 KB and 116 KB** could not be read via MCP at all. The only ways through were:
1. Drop to local **Bash**: `curl` the REST API for the content, write to a file, slice it with `head -c`/python, feed the model bounded chunks. (Works, but requires local shell + defeats the point of a clean MCP interface, and won't work for any remote/cloud MCP client.)
2. Get lucky with a secondary summarized source already in the vault.

## Request

Add **content range/pagination** to `query-notes` (and the equivalent REST "get note" endpoint), so clients can retrieve a note body in bounded slices. Suggested shape:

```jsonc
query-notes {
  id: "<note id or path>",
  include_content: true,
  content_offset: 0,        // start offset into the content
  content_length: 40000,    // max chars (or bytes) to return this call
}
// response adds:
{
  content: "<slice>",
  content_total_length: 118428,   // so the client knows how many more slices remain
  content_next_offset: 40000      // or null when done
}
```

Character-based offsets are fine (UTF-8 byte offsets also acceptable if simpler server-side). The key requirements:

- A client can read an arbitrarily large note's content in bounded chunks **without any Bash/REST workaround and without exceeding token limits**.
- A `content_total_length` (or total size) field so the client knows when it has read everything.
- Works identically for local and remote/cloud MCP clients (this is the part the Bash workaround can't give us — it unblocks scheduled/cloud agents).

Nice-to-have: a server-side `summary`/`head` convenience (e.g. return first N chars + total length) for agents that only need a preview.

## Secondary bug (lower priority)

`update-note` **link mutations** return an error response `"null is not an object"` even though the write **does commit** (verified by `updatedAt` bumping and the link appearing on subsequent reads). It's a post-commit response-rendering error, but it makes agents think the write failed and retry. Worth a look.

## Impact

Anything that reads long notes over MCP: meeting transcripts, long documents/specs, research notes. Today these silently fail or require a local-shell escape hatch; a content-range param makes large-note reads first-class and unblocks unattended/cloud agents.
