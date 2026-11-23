/**
 * The exact multipart body the Comms apps send (PrismKit CommsClient `MultipartForm`), byte for
 * byte — NOT the one undici's FormData would build. `style: "legacy"` is the 0.2.x client
 * (non-ASCII names as an ASCII fallback + RFC 5987 `filename*=UTF-8''…`, which undici's parser
 * refuses outright); `"utf8"` is the fixed client (the raw UTF-8 name, `"` CR LF percent-escaped
 * as browsers do).
 */
export interface SwiftUpload {
  clientId: string;
  kind: string;
  w?: number;
  h?: number;
  durationMs?: number;
  filename: string;
  mime: string;
  bytes: Buffer;
  style?: "legacy" | "utf8";
}

const ATTR = /[A-Za-z0-9!#$&+\-.^_`|~]/;

export function swiftMultipart(u: SwiftUpload): { body: Buffer; contentType: string } {
  const boundary = `CommsBoundary-${crypto.randomUUID().toUpperCase()}`;
  const parts: Buffer[] = [];
  const field = (name: string, value: string) =>
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, "utf8"));
  field("clientId", u.clientId);
  field("kind", u.kind);
  if (u.durationMs !== undefined && (u.kind === "voice" || u.kind === "video")) field("durationMs", String(u.durationMs));
  if ((u.kind === "image" || u.kind === "video") && u.w && u.h) {
    field("w", String(u.w));
    field("h", String(u.h));
  }
  let disposition: string;
  if ((u.style ?? "legacy") === "legacy") {
    const ascii = [...u.filename].map((ch) => (ch.codePointAt(0)! < 0x80 ? ch : "_")).join("");
    disposition = `form-data; name="file"; filename="${ascii}"`;
    if (ascii !== u.filename) {
      const star = [...Buffer.from(u.filename, "utf8")].map((b) => (ATTR.test(String.fromCharCode(b)) ? String.fromCharCode(b) : `%${b.toString(16).toUpperCase().padStart(2, "0")}`)).join("");
      disposition += `; filename*=UTF-8''${star}`;
    }
  } else {
    disposition = `form-data; name="file"; filename="${u.filename.replace(/"/g, "%22").replace(/\r/g, "%0D").replace(/\n/g, "%0A")}"`;
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: ${disposition}\r\nContent-Type: ${u.mime}\r\n\r\n`, "utf8"));
  parts.push(u.bytes);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, "utf8")); // the streamed (fileURL) tail
  const body = Buffer.concat(parts);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

/** Request init for the app: the client's headers (Content-Length from the temp file's size). */
export function swiftUploadInit(u: SwiftUpload, auth: Record<string, string>): RequestInit {
  const { body, contentType } = swiftMultipart(u);
  return {
    method: "POST",
    headers: { ...auth, "content-type": contentType, "content-length": String(body.length), accept: "application/json", "user-agent": "Comms/0.2.3 PrismKit" },
    body,
  };
}
