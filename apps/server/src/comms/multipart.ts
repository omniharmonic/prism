/**
 * Multipart compatibility for the Comms uploads.
 *
 * undici's `Request.formData()` (Node 22, undici 6) refuses a whole body when ANY part's
 * Content-Disposition carries an RFC 5987 `filename*=` parameter — and the Comms apps up to 0.2.x
 * sent one for every non-ASCII file name (macOS screenshots have a U+202F before "AM"/"PM", photos
 * named in any non-Latin script, emoji…). The upload then failed as "The upload could not be read."
 * before anything was sent (owner report 2026-11-22).
 *
 * `normalizeFilenameStar` rewrites ONLY the part headers: a `filename*=UTF-8''…` parameter is
 * percent-decoded and replaces the part's `filename="…"` (written the way browsers send it: raw
 * UTF-8 with `"`, CR and LF percent-escaped — which undici reads). Part bodies are copied untouched;
 * a body with no `filename*` is returned as is (the same Buffer). Anything it does not understand is
 * left alone, so the parser's verdict stands. Called only after the parser refused a body.
 */

const MAX_HEADER_BLOCK = 16 * 1024;

export function multipartBoundary(contentType: string): string | null {
  const m = /;\s*boundary=(?:"([^"]{1,70})"|([^\s;"]{1,70}))/i.exec(contentType);
  return m ? (m[1] ?? m[2] ?? null) : null;
}

export function normalizeFilenameStar(raw: Buffer, contentType: string): Buffer {
  const boundary = multipartBoundary(contentType);
  if (!boundary) return raw;
  const delim = Buffer.from(`--${boundary}`, "latin1");
  const out: Buffer[] = [];
  let pos = raw.indexOf(delim);
  if (pos < 0) return raw;
  out.push(raw.subarray(0, pos));
  let changed = false;
  while (pos >= 0) {
    const afterDelim = pos + delim.length;
    // Closing delimiter: copy the rest verbatim.
    if (raw[afterDelim] === 0x2d && raw[afterDelim + 1] === 0x2d) {
      out.push(raw.subarray(pos));
      break;
    }
    const headStart = raw.indexOf("\r\n", afterDelim, "latin1");
    if (headStart < 0) { out.push(raw.subarray(pos)); break; }
    const headEnd = raw.indexOf("\r\n\r\n", headStart, "latin1");
    if (headEnd < 0 || headEnd - headStart > MAX_HEADER_BLOCK) { out.push(raw.subarray(pos)); break; }
    out.push(raw.subarray(pos, headStart));
    const head = raw.subarray(headStart, headEnd);
    const rewritten = rewriteHead(head.toString("utf8"));
    if (rewritten !== null) { out.push(Buffer.from(rewritten, "utf8")); changed = true; } else out.push(head);
    // The body runs to the next "\r\n--boundary".
    const next = raw.indexOf(Buffer.concat([Buffer.from("\r\n", "latin1"), delim]), headEnd + 4);
    if (next < 0) { out.push(raw.subarray(headEnd)); break; }
    out.push(raw.subarray(headEnd, next + 2));
    pos = next + 2;
  }
  return changed ? Buffer.concat(out) : raw;
}

/** The header block with its Content-Disposition's `filename*` folded into `filename`, or null. */
function rewriteHead(head: string): string | null {
  let changed = false;
  const lines = head.split("\r\n").map((line) => {
    if (!/^content-disposition\s*:/i.test(line)) return line;
    const star = /;\s*filename\*\s*=\s*([^;]*)/i.exec(line);
    if (!star) return line;
    const name = decodeExtValue(star[1]!.trim());
    let next = line.slice(0, star.index) + line.slice(star.index + star[0].length);
    if (name !== null) {
      const quoted = `filename="${name.replace(/"/g, "%22").replace(/\r/g, "%0D").replace(/\n/g, "%0A")}"`;
      const plain = /;\s*filename\s*=\s*(?:"(?:[^"\\]|\\.)*"|[^;]*)/i.exec(next);
      next = plain ? `${next.slice(0, plain.index)}; ${quoted}${next.slice(plain.index + plain[0].length)}` : `${next}; ${quoted}`;
    }
    changed = true;
    return next;
  });
  return changed ? lines.join("\r\n") : null;
}

/** RFC 5987 ext-value (`UTF-8''pct-encoded`, or quoted by a lenient sender). Null if unusable. */
function decodeExtValue(v: string): string | null {
  const s = v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v;
  const m = /^utf-8'[^']*'(.*)$/i.exec(s);
  if (!m) return null;
  try {
    const decoded = decodeURIComponent(m[1]!);
    return decoded.length > 0 && decoded.length <= 1024 ? decoded : null;
  } catch {
    return null;
  }
}
