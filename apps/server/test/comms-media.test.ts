/**
 * Comms media + avatar proxy (Task 10). The client gets a short-lived,
 * device-bound HMAC token, never Matrix credentials or a raw mxc:// URL; the
 * server streams the bytes through from authenticated media. Synthetic data only.
 */
process.env.SECRETS_KEY ??= Buffer.alloc(32, 7).toString("base64");
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app";
import { config } from "../src/config";
import { resolveVaultEntry } from "../src/db";
import { putSecret } from "../src/secrets";
import { issueDeviceToken } from "../src/auth/device";
import { mintMediaToken, setCommsMediaFetcherForTests, clampThumb, MEDIA_TOKEN_BUCKET_MS } from "../src/comms/media";
import { withIdentityEncoding } from "../src/comms/media-route";
import { consumeRateLimit } from "../src/middleware/ratelimit";
import { MatrixClient } from "../src/worker/matrix";
import { resetDb, makeSession, sessionCookie } from "./helpers";

const MXC = "mxc://example.test/AbCdEf123";
const prev = process.env.COMMS_ENABLED;
type Call = { mxc: string; opts: { thumb?: { w: number; h: number }; range?: string } };
let calls: Call[] = [];
let respond: (call: Call) => Response = () => new Response("PNGDATA", { status: 200, headers: { "content-type": "image/png", "content-length": "7" } });

beforeEach(() => {
  resetDb();
  process.env.COMMS_ENABLED = "true";
  putSecret(resolveVaultEntry(undefined).id, config.ownerEmail, "matrix", JSON.stringify({ homeserver: "https://matrix.example.test", accessToken: "syt_secret" }));
  calls = [];
  setCommsMediaFetcherForTests(() => ({
    downloadMedia: async (mxc: string, opts: Call["opts"] = {}) => {
      const call = { mxc, opts };
      calls.push(call);
      return respond(call);
    },
  }));
});
afterEach(() => {
  setCommsMediaFetcherForTests(null);
  respond = () => new Response("PNGDATA", { status: 200, headers: { "content-type": "image/png", "content-length": "7" } });
  if (prev === undefined) delete process.env.COMMS_ENABLED; else process.env.COMMS_ENABLED = prev;
});

const sessionHeaders = () => ({ cookie: sessionCookie(makeSession(config.ownerEmail)) });
const get = (token: string, headers: Record<string, string> = sessionHeaders()) =>
  createApp().request(`/api/comms/media/${token}`, { headers });

test("valid token streams bytes and content-type", async () => {
  const r = await get(mintMediaToken(MXC, { email: config.ownerEmail }));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "image/png");
  assert.equal(r.headers.get("cache-control"), "private, max-age=21600");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.equal(await r.text(), "PNGDATA");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.mxc, MXC);
});

test("device-bound token works for that device", async () => {
  const dev = issueDeviceToken(config.ownerEmail, "Comms (test)", "omni-native");
  const r = await get(mintMediaToken(MXC, { email: config.ownerEmail, deviceId: dev.id }), { authorization: `Bearer ${dev.token}` });
  assert.equal(r.status, 200);
});

test("token from another device → 403", async () => {
  const a = issueDeviceToken(config.ownerEmail, "A", "omni-native");
  const b = issueDeviceToken(config.ownerEmail, "B", "omni-native");
  const token = mintMediaToken(MXC, { email: config.ownerEmail, deviceId: a.id });
  assert.equal((await get(token, { authorization: `Bearer ${b.token}` })).status, 403);
  // A device token is not valid from a cookie session either, nor a session token from a device.
  assert.equal((await get(token)).status, 403);
  assert.equal((await get(mintMediaToken(MXC, { email: config.ownerEmail }), { authorization: `Bearer ${a.token}` })).status, 403);
  assert.equal(calls.length, 0);
});

test("expired token → 410", async () => {
  const r = await get(mintMediaToken(MXC, { email: config.ownerEmail }, { now: Date.now() - 8 * 3_600_000 }));
  assert.equal(r.status, 410);
  assert.equal(r.headers.get("cache-control"), "private, no-store");
  assert.equal(calls.length, 0);
});

test("tampered token → 403", async () => {
  const token = mintMediaToken(MXC, { email: config.ownerEmail });
  const [payload, sig] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload!, "base64url").toString()), m: "mxc://evil.test/other" })).toString("base64url");
  for (const bad of [
    `${forged}.${sig}`,
    `${payload}.${sig!.slice(0, -2)}AA`,
    `${payload}.`,
    payload!,
    "not-a-token",
    `${payload}.${sig}.extra`,
  ]) {
    const r = await get(encodeURIComponent(bad));
    assert.equal(r.status, 403, bad);
  }
  assert.equal(calls.length, 0);
});

test("non-owner gets 403 even with a valid token", async () => {
  const token = mintMediaToken(MXC, { email: config.ownerEmail });
  assert.equal((await get(token, { cookie: sessionCookie(makeSession("stranger@test.local")) })).status, 403);
});

test("range request passes through 206", async () => {
  respond = () => new Response("NGD", { status: 206, headers: { "content-type": "video/mp4", "content-range": "bytes 1-3/7", "content-length": "3", "accept-ranges": "bytes", etag: '"abc"' } });
  const r = await get(mintMediaToken(MXC, { email: config.ownerEmail }), { ...sessionHeaders(), range: "bytes=1-3" });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get("content-range"), "bytes 1-3/7");
  assert.equal(r.headers.get("accept-ranges"), "bytes");
  assert.equal(r.headers.get("etag"), '"abc"');
  assert.equal(await r.text(), "NGD");
  assert.equal(calls[0]!.opts.range, "bytes=1-3");
});

test("malformed range header is not forwarded", async () => {
  for (const range of ["bytes=0-1,5-9", "bytes=9-1", "bytes=-", "items=0-1", `bytes=0-${"9".repeat(70)}`]) {
    await (await get(mintMediaToken(MXC, { email: config.ownerEmail }), { ...sessionHeaders(), range })).arrayBuffer();
    assert.equal(calls.at(-1)!.opts.range, undefined, range);
  }
});

test("non-mxc input refused at mint", () => {
  for (const bad of ["https://example.test/a.png", "mxc://example.test/../x", "mxc://exa mple/x", "mxc://host/", "mxc:///id", "mxc://host/id?x=1", "", "mxc://host/id/extra"]) {
    assert.throws(() => mintMediaToken(bad, { email: config.ownerEmail }), bad);
  }
});

test("upstream 404 → 404 media_unavailable", async () => {
  respond = () => new Response(JSON.stringify({ errcode: "M_NOT_FOUND" }), { status: 404, headers: { "content-type": "application/json" } });
  const r = await get(mintMediaToken(MXC, { email: config.ownerEmail }));
  assert.equal(r.status, 404);
  assert.deepEqual(await r.json(), { error: "media_unavailable" });
  assert.equal(r.headers.get("cache-control"), "private, no-store");
});

test("upstream failure → 502 media_upstream", async () => {
  respond = () => new Response("boom", { status: 500 });
  const r = await get(mintMediaToken(MXC, { email: config.ownerEmail }));
  assert.equal(r.status, 502);
  assert.deepEqual(await r.json(), { error: "media_upstream" });
  respond = () => { throw new Error("network down"); };
  const r2 = await get(mintMediaToken(MXC, { email: config.ownerEmail }));
  assert.equal(r2.status, 502);
});

test("html/svg are served as octet-stream attachments; only allowed headers pass", async () => {
  for (const ct of ["text/html; charset=utf-8", "image/svg+xml", "application/xhtml+xml", "text/xml", "application/javascript", "garbage"]) {
    respond = () => new Response("<script>x</script>", { status: 200, headers: { "content-type": ct, "set-cookie": "a=b", "x-upstream": "1", "content-disposition": "inline" } });
    const r = await get(mintMediaToken(MXC, { email: config.ownerEmail }));
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "application/octet-stream", ct);
    assert.equal(r.headers.get("content-disposition"), "attachment");
    assert.equal(r.headers.get("set-cookie"), null);
    assert.equal(r.headers.get("x-upstream"), null);
    await r.arrayBuffer();
  }
});

test("thumbnail sizes are clamped and carried in the token", async () => {
  assert.deepEqual(clampThumb({ w: 1, h: 100 }), { w: 64, h: 128 });
  assert.deepEqual(clampThumb({ w: 5000, h: 300 }), { w: 1024, h: 512 });
  assert.deepEqual(clampThumb({ w: Number.NaN, h: -5 }), { w: 64, h: 64 });
  await get(mintMediaToken(MXC, { email: config.ownerEmail }, { thumb: { w: 90, h: 90 } }));
  assert.deepEqual(calls[0]!.opts.thumb, { w: 128, h: 128 });
});

test("oversized upstream content-length is refused", async () => {
  respond = () => new Response("x", { status: 200, headers: { "content-type": "video/mp4", "content-length": String(500 * 1024 * 1024) } });
  const r = await get(mintMediaToken(MXC, { email: config.ownerEmail }));
  assert.equal(r.status, 502);
});

test("MatrixClient.downloadMedia uses authenticated media endpoints, no redirects", async () => {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const fake = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;
  const mc = new MatrixClient({ homeserver: "https://matrix.example.test/", accessToken: "syt_secret" }, fake);
  await mc.downloadMedia("mxc://example.test:8448/Abc_-1");
  await mc.downloadMedia("mxc://[::1]/Abc", { thumb: { w: 64, h: 128 }, range: "bytes=0-9" });
  assert.equal(seen[0]!.url, "https://matrix.example.test/_matrix/client/v1/media/download/example.test%3A8448/Abc_-1");
  assert.equal(seen[1]!.url, "https://matrix.example.test/_matrix/client/v1/media/thumbnail/%5B%3A%3A1%5D/Abc?width=64&height=128&method=scale");
  assert.equal(seen[0]!.init.redirect, "manual");
  assert.equal((seen[0]!.init.headers as Record<string, string>).Authorization, "Bearer syt_secret");
  assert.equal((seen[1]!.init.headers as Record<string, string>).Range, "bytes=0-9");
  await assert.rejects(mc.downloadMedia("https://evil.test/x"));
  // A redirect to another host is never followed (and never gets the bearer).
  const redirecting = new MatrixClient({ homeserver: "https://matrix.example.test", accessToken: "syt_secret" },
    (async (url: string) => { seen.push({ url, init: {} }); return new Response(null, { status: 302, headers: { location: "https://evil.test/steal" } }); }) as unknown as typeof fetch);
  const before = seen.length;
  const res = await redirecting.downloadMedia(MXC);
  assert.equal(seen.length, before + 1);
  assert.ok(res.status >= 300 && res.status < 400);
});

test("an undeclared body past the byte cap is cut off mid-stream", async () => {
  const chunk = new Uint8Array(1024 * 1024);
  let produced = 0;
  respond = () => new Response(new ReadableStream<Uint8Array>({
    pull(ctrl) { produced++; ctrl.enqueue(chunk); },
  }), { status: 200, headers: { "content-type": "video/mp4" } });
  const r = await get(mintMediaToken(MXC, { email: config.ownerEmail }));
  assert.equal(r.status, 200);
  await assert.rejects(r.arrayBuffer());
  assert.ok(produced <= 210, `upstream kept producing: ${produced}`);
});

const HOUR = MEDIA_TOKEN_BUCKET_MS;
const T0 = 1_900_000_000_000 - (1_900_000_000_000 % HOUR) + 60_000; // one minute past an hour boundary

test("same inputs within the hour mint the identical token; other inputs differ", () => {
  const owner = { email: config.ownerEmail };
  const a = mintMediaToken(MXC, owner, { thumb: { w: 90, h: 90 }, now: T0 });
  assert.equal(mintMediaToken(MXC, owner, { thumb: { w: 90, h: 90 }, now: T0 + 50 * 60_000 }), a);
  assert.equal(mintMediaToken(MXC, owner, { thumb: { w: 128, h: 128 }, now: T0 }), a); // same clamped size
  assert.notEqual(mintMediaToken(MXC, owner, { thumb: { w: 90, h: 90 }, now: T0 + HOUR }), a);
  assert.notEqual(mintMediaToken(MXC, owner, { now: T0 }), a);
  assert.notEqual(mintMediaToken(MXC, { ...owner, deviceId: "dev-1" }, { thumb: { w: 90, h: 90 }, now: T0 }), a);
  assert.notEqual(mintMediaToken("mxc://example.test/Other", owner, { thumb: { w: 90, h: 90 }, now: T0 }), a);
  const body = JSON.parse(Buffer.from(a.split(".")[0]!, "base64url").toString());
  assert.equal(body.x, T0 - 60_000 + HOUR + 6 * HOUR);
  assert.equal("e" in body, false, "no email in the token");
  assert.equal(JSON.stringify(body).includes(config.ownerEmail), false);
});

test("max-age never outlives the token", async () => {
  const r = await get(mintMediaToken(MXC, { email: config.ownerEmail }, { now: Date.now() - HOUR }));
  assert.equal(r.status, 200);
  const age = Number(/^private, max-age=(\d+)$/.exec(r.headers.get("cache-control") ?? "")?.[1]);
  assert.ok(age > 4 * 3600 && age <= 6 * 3600 - 1, String(age));
  await r.arrayBuffer();
});

test("upstream 401/403 → 503 source_unconfigured", async () => {
  for (const status of [401, 403]) {
    respond = () => new Response(JSON.stringify({ errcode: "M_UNKNOWN_TOKEN" }), { status });
    const r = await get(mintMediaToken(MXC, { email: config.ownerEmail }));
    assert.equal(r.status, 503);
    assert.deepEqual(await r.json(), { error: "source_unconfigured" });
  }
});

test("a still-encoded upstream: no Content-Length / Accept-Ranges forwarded, 206 refused", async () => {
  respond = () => new Response("PNGDATA", { status: 200, headers: { "content-type": "image/png", "content-encoding": "gzip", "content-length": "3", "accept-ranges": "bytes" } });
  const r = await get(mintMediaToken(MXC, { email: config.ownerEmail }));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-length"), null);
  assert.equal(r.headers.get("accept-ranges"), null);
  assert.equal(r.headers.get("content-encoding"), null);
  assert.equal(await r.text(), "PNGDATA");
  respond = () => new Response("NGD", { status: 206, headers: { "content-type": "video/mp4", "content-encoding": "gzip", "content-range": "bytes 1-3/7" } });
  assert.equal((await get(mintMediaToken(MXC, { email: config.ownerEmail }), { ...sessionHeaders(), range: "bytes=1-3" })).status, 502);
  // A declared compressed size never trips (or dodges) the up-front cap either.
  respond = () => new Response("x", { status: 200, headers: { "content-type": "video/mp4", "content-encoding": "br", "content-length": String(500 * 1024 * 1024) } });
  const big = await get(mintMediaToken(MXC, { email: config.ownerEmail }));
  assert.equal(big.status, 200);
  assert.equal(await big.text(), "x");
});

test("withIdentityEncoding asks for identity and keeps the other headers", async () => {
  let seen: Headers | null = null;
  const f = withIdentityEncoding((async (_u: unknown, init?: RequestInit) => { seen = new Headers(init?.headers); return new Response("ok"); }) as typeof fetch);
  const mc = new MatrixClient({ homeserver: "https://matrix.example.test", accessToken: "syt_secret" }, f);
  await mc.downloadMedia(MXC, { range: "bytes=0-1" });
  assert.equal(seen!.get("accept-encoding"), "identity");
  assert.equal(seen!.get("authorization"), "Bearer syt_secret");
  assert.equal(seen!.get("range"), "bytes=0-1");
});

// Last in the file: it fills the owner's JSON bucket for the rest of the minute.
test("media requests use their own bucket, never the JSON API's", async () => {
  for (let i = 0; i < 599; i++) consumeRateLimit(`comms:${config.ownerEmail}`, 600, 60_000);
  for (let i = 0; i < 5; i++) {
    const r = await get(mintMediaToken(MXC, { email: config.ownerEmail }));
    assert.equal(r.status, 200);
    await r.arrayBuffer();
  }
  const caps = () => createApp().request("/api/integrations/comms/capabilities", { headers: sessionHeaders() });
  assert.equal((await caps()).status, 200); // the 600th JSON hit: media spent none of it
  assert.equal((await caps()).status, 429);
  const m = await get(mintMediaToken(MXC, { email: config.ownerEmail })); // media still flows
  assert.equal(m.status, 200);
  await m.arrayBuffer();
});

// ── token refresh (owner report: photos in a transcript left open past the TTL would not open) ──

const refresh = (tokens: unknown, headers: Record<string, string> = sessionHeaders()) =>
  createApp().request(`/api/comms/media/refresh`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ tokens }) });

test("refresh: an expired token is exchanged for a fresh one for the SAME media and size; it then streams", async () => {
  const old = mintMediaToken(MXC, { email: config.ownerEmail }, { thumb: { w: 512, h: 512 }, now: Date.now() - 8 * 3_600_000 });
  assert.equal((await get(old)).status, 410);
  const r = await refresh([old]);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "private, no-store");
  const fresh = ((await r.json()) as { tokens: Record<string, string | null> }).tokens[old]!;
  assert.ok(fresh && fresh !== old);
  const got = await get(fresh);
  assert.equal(got.status, 200);
  assert.deepEqual(calls.at(-1)!.opts.thumb, { w: 512, h: 512 });
  assert.equal(calls.at(-1)!.mxc, MXC);
});

test("refresh: device binding still holds, forged and too-old tokens map to null, non-owner 403, bad bodies 400", async () => {
  const a = issueDeviceToken(config.ownerEmail, "A", "omni-native");
  const b = issueDeviceToken(config.ownerEmail, "B", "omni-native");
  const forA = mintMediaToken(MXC, { email: config.ownerEmail, deviceId: a.id }, { now: Date.now() - 8 * 3_600_000 });
  // Device B cannot refresh device A's token; device A can, and the fresh one is bound to A.
  const byB = ((await (await refresh([forA], { authorization: `Bearer ${b.token}` })).json()) as { tokens: Record<string, string | null> }).tokens;
  assert.equal(byB[forA], null);
  const byA = ((await (await refresh([forA], { authorization: `Bearer ${a.token}` })).json()) as { tokens: Record<string, string | null> }).tokens;
  assert.ok(byA[forA]);
  assert.equal((await get(byA[forA]!, { authorization: `Bearer ${a.token}` })).status, 200);
  assert.equal((await get(byA[forA]!, { authorization: `Bearer ${b.token}` })).status, 403);
  // Tampered, and older than the 30-day grace.
  const tampered = `${forA.split(".")[0]}.${"A".repeat(43)}`;
  const ancient = mintMediaToken(MXC, { email: config.ownerEmail }, { now: Date.now() - 40 * 24 * 3_600_000 });
  const res = ((await (await refresh([tampered, ancient, "junk"])).json()) as { tokens: Record<string, string | null> }).tokens;
  assert.deepEqual(res, { [tampered]: null, [ancient]: null, junk: null });
  assert.equal((await refresh([ancient], { cookie: sessionCookie(makeSession("stranger@test.local")) })).status, 403);
  assert.equal((await refresh("nope")).status, 400);
  assert.equal((await refresh(Array.from({ length: 101 }, () => "x"))).status, 400);
  assert.equal(calls.length, 1, "refresh never contacts the homeserver");
});

// ── playable audio: Ogg/Opus voice notes → AAC .m4a (owner-testing round 4) ────────────────────

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { join as joinPath } from "node:path";
import { tmpdir as osTmp } from "node:os";
import { _clearAudioCacheForTests, ffmpegPath, needsTranscode, setFfmpegPathForTests, sniffAudio, transcodeStats } from "../src/comms/audio-transcode";

/** A real 1-second Ogg/Opus voice note made by ffmpeg (skips when ffmpeg is not installed). */
function oggOpusFixture(): Buffer | null {
  const bin = ffmpegPath();
  if (!bin) return null;
  const dir = mkdtempSync(joinPath(osTmp(), "ogg-"));
  const out = joinPath(dir, "voice.ogg");
  try {
    execFileSync(bin, ["-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1:sample_rate=48000", "-c:a", "libopus", "-b:a", "24k", "-ac", "1", "-y", out]);
    return readFileSync(out);
  } catch {
    return null;
  }
}

test("sniffing: Ogg/AMR/WebM need a playable rendition; AAC/MP3/CAF/WAV do not (bytes beat the declared type)", () => {
  const b = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));
  assert.equal(sniffAudio(b("OggS\0\x02")), "audio/ogg");
  assert.equal(needsTranscode(b("OggS\0\x02"), "audio/mp4"), true);
  assert.equal(needsTranscode(b("#!AMR\n"), null), true);
  assert.equal(needsTranscode(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]), null), true);
  assert.equal(needsTranscode(b("\0\0\0\x20ftypM4A "), "audio/ogg"), false);
  assert.equal(needsTranscode(b("caff\0\x01"), null), false);
  assert.equal(needsTranscode(b("ID3\x04"), null), false);
  assert.equal(needsTranscode(b("????"), "audio/ogg; codecs=opus"), true);
});

test("?format=m4a: an Ogg/Opus voice note is transcoded to AAC (audio/mp4), cached, ranged; the original is untouched", { skip: !ffmpegPath() && "ffmpeg not installed" }, async () => {
  const ogg = oggOpusFixture();
  assert.ok(ogg, "fixture");
  await _clearAudioCacheForTests();
  respond = () => new Response(new Uint8Array(ogg!), { status: 200, headers: { "content-type": "audio/ogg", "content-length": String(ogg!.length) } });
  const token = mintMediaToken("mxc://example.test/voice1", { email: config.ownerEmail });
  const plain = await get(token);
  assert.equal(plain.headers.get("content-type"), "audio/ogg", "without ?format the original streams as before");
  await plain.arrayBuffer();
  const runs = transcodeStats.runs;
  const r = await createApp().request(`/api/comms/media/${token}?format=m4a`, { headers: sessionHeaders() });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "audio/mp4");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.equal(r.headers.get("accept-ranges"), "bytes");
  const m4a = Buffer.from(await r.arrayBuffer());
  assert.equal(m4a.subarray(4, 8).toString("latin1"), "ftyp");
  // The rendition really is AAC of about the same length.
  const probe = joinPath(mkdtempSync(joinPath(osTmp(), "m4a-")), "x.m4a");
  (await import("node:fs")).writeFileSync(probe, m4a);
  const err = (() => { try { execFileSync(ffmpegPath()!, ["-nostdin", "-hide_banner", "-i", probe]); return ""; } catch (e) { return String((e as { stderr?: Buffer }).stderr ?? ""); } })();
  assert.match(err, /Audio: aac/);
  assert.match(err, /Duration: 00:00:01/);
  assert.equal(transcodeStats.runs, runs + 1);
  // Cached: no second ffmpeg run and no upstream call.
  const before = calls.length;
  const again = await createApp().request(`/api/comms/media/${token}?format=m4a`, { headers: { ...sessionHeaders(), range: "bytes=0-9" } });
  assert.equal(again.status, 206);
  assert.equal(again.headers.get("content-range"), `bytes 0-9/${m4a.length}`);
  assert.equal(Buffer.from(await again.arrayBuffer()).length, 10);
  assert.equal(transcodeStats.runs, runs + 1);
  assert.equal(calls.length, before);
  await _clearAudioCacheForTests();
});

test("?format=m4a: playable audio passes unchanged; no ffmpeg → 503 transcode_unavailable; junk → 422; too large → 413", async () => {
  await _clearAudioCacheForTests();
  const mp3 = Buffer.concat([Buffer.from("ID3\x04\0\0\0\0\0\0", "latin1"), Buffer.alloc(100)]);
  respond = () => new Response(new Uint8Array(mp3), { status: 200, headers: { "content-type": "audio/mpeg" } });
  const t1 = mintMediaToken("mxc://example.test/song", { email: config.ownerEmail });
  const r1 = await createApp().request(`/api/comms/media/${t1}?format=m4a`, { headers: sessionHeaders() });
  assert.equal(r1.status, 200);
  assert.equal(r1.headers.get("content-type"), "audio/mpeg");
  assert.equal(Buffer.from(await r1.arrayBuffer()).length, mp3.length);

  const ogg = Buffer.from("OggS\0\x02" + "x".repeat(200), "latin1");
  respond = () => new Response(new Uint8Array(ogg), { status: 200, headers: { "content-type": "audio/ogg" } });
  setFfmpegPathForTests(null);
  try {
    const r2 = await createApp().request(`/api/comms/media/${mintMediaToken("mxc://example.test/v2", { email: config.ownerEmail })}?format=m4a`, { headers: sessionHeaders() });
    assert.equal(r2.status, 503);
    assert.equal(((await r2.json()) as { error: string }).error, "transcode_unavailable");
  } finally {
    setFfmpegPathForTests(undefined);
  }
  if (ffmpegPath()) {
    const r3 = await createApp().request(`/api/comms/media/${mintMediaToken("mxc://example.test/v3", { email: config.ownerEmail })}?format=m4a`, { headers: sessionHeaders() });
    assert.equal(r3.status, 422, "a broken Ogg is refused, never served as audio");
  }
  respond = () => new Response("x", { status: 200, headers: { "content-type": "audio/ogg", "content-length": String(26 * 1024 * 1024) } });
  const r4 = await createApp().request(`/api/comms/media/${mintMediaToken("mxc://example.test/v4", { email: config.ownerEmail })}?format=m4a`, { headers: sessionHeaders() });
  assert.equal(r4.status, 413);
  // Nothing half-written is left in the cache directory.
  const dir = (await import("../src/comms/audio-transcode")).cachedPathFor("x").replace(/\/[^/]+$/, "");
  let left: string[] = [];
  try { left = readdirSync(dir).filter((f) => !f.endsWith(".m4a")); } catch { /* no dir */ }
  assert.deepEqual(left, []);
  await _clearAudioCacheForTests();
});
