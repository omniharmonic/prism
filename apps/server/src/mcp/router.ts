/**
 * The Prism MCP endpoint (Architecture v2 WP6.1): stateless Streamable HTTP on
 * the Prism Server, per the 2026-07-28 MCP revision (no initialize handshake, no
 * Mcp-Session-Id), with the SDK's stateless fallback serving 2025-era clients
 * (initialize + tools/* as independent POSTs) from the SAME per-request factory.
 *
 *   POST <mount>                                       JSON-RPC (tools/list, tools/call, server/discover, …)
 *   GET  /.well-known/oauth-protected-resource<mount>  RFC 9728 protected-resource metadata
 *
 * Request pipeline:
 *   1. Origin check — a browser Origin that is not the app's own (or a native
 *      shell's) is refused: DNS-rebinding defense, per the transport spec.
 *   2. Per-IP failed-auth budget — an IP that keeps presenting bad tokens is
 *      refused before any lookup (token-guessing defense).
 *   3. Authentication (mcp/auth.ts) → McpPrincipal, or 401/403 with an RFC 6750
 *      `WWW-Authenticate: Bearer resource_metadata="…"` challenge (RFC 9728 §5.1).
 *   4. Per-credential request budget.
 *   5. The SDK handler, with a server built for THIS principal (per-actor
 *      tools/list; see tools.ts).
 *
 * Mountable anywhere: `mountPrismMcp(app, "/mcp")` today; the same function can
 * mount it at `/surface/prism/api/mcp` if Prism later runs as a Parachute backed
 * surface. The protected-resource metadata path follows the mount (RFC 9728 §3.1
 * path insertion).
 *
 * No CORS: MCP clients are not browsers, and the endpoint is bearer-only, so no
 * cross-origin page can drive it with ambient credentials.
 */
import type { Context, Hono } from "hono";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { config } from "../config";
import { consumeRateLimit, rateLimited, rateLimitClientKey } from "../middleware/ratelimit";
import { authenticateMcp, type McpAuthFailure, type McpPrincipal } from "./auth";
import { buildMcpServer, type PrismResource, type PrismTool } from "./tools";
import { whoamiTool } from "./tool-whoami";
import { NOTE_TOOLS, NOTE_RESOURCES } from "./tool-notes";

/** The v1 tool catalog. WP6.3+ append here. */
export const PRISM_TOOLS: PrismTool[] = [whoamiTool as unknown as PrismTool, ...NOTE_TOOLS];
/** Resource templates (WP6.2: prism://note/{id}). */
export const PRISM_RESOURCES: PrismResource[] = [...NOTE_RESOURCES];

export const MCP_DOCS_URL = "https://github.com/omniharmonic/prism/blob/main/docs/mcp-access.md";
const PRM_BASE = "/.well-known/oauth-protected-resource";
const AUTH_FAIL_WINDOW_MS = 10 * 60_000;

export interface MountOptions {
  /** Tool catalog override (tests). Defaults to PRISM_TOOLS. */
  tools?: readonly PrismTool[];
  /** Resource override (tests). Defaults to PRISM_RESOURCES. */
  resources?: readonly PrismResource[];
  /** Also serve the metadata at the bare `/.well-known/oauth-protected-resource`. Default: mountPath === "/mcp". */
  rootMetadata?: boolean;
}

export const resourceUrl = (mountPath: string): string => `${config.appOrigin}${mountPath}`;
export const metadataUrl = (mountPath: string): string => `${config.appOrigin}${PRM_BASE}${mountPath}`;

/**
 * RFC 9728 protected-resource metadata. `authorization_servers` is deliberately
 * OMITTED (it is optional): Prism MCP authenticates with Prism-issued personal
 * access tokens (and the owner's hub JWT), and no OAuth authorization server
 * mints tokens with a Prism audience yet — advertising the hub here would send
 * OAuth-capable clients through a flow whose tokens this endpoint refuses. When
 * the hub gains per-surface audiences (WORKPLAN WP6.x follow-up), list it here.
 */
export function protectedResourceMetadata(mountPath: string): Record<string, unknown> {
  return {
    resource: resourceUrl(mountPath),
    resource_name: "Prism",
    bearer_methods_supported: ["header"],
    resource_documentation: MCP_DOCS_URL,
  };
}

/** A header-safe (ASCII, no quotes/backslashes) rendering of an error description. */
const quote = (s: string): string => s.replace(/[^\x20-\x7e]/g, "-").replace(/["\\]/g, "");

function challenge(c: Context, mountPath: string, f: McpAuthFailure): Response {
  const parts = [`resource_metadata="${metadataUrl(mountPath)}"`];
  if (f.error) parts.push(`error="${f.error}"`, `error_description="${quote(f.description)}"`);
  c.header("WWW-Authenticate", `Bearer ${parts.join(", ")}`);
  c.header("Cache-Control", "no-store");
  return c.json({ error: f.error ?? "unauthorized", error_description: f.description }, f.status);
}

function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true; // non-browser clients send none
  const o = origin.replace(/\/+$/, "");
  return o === config.appOrigin || config.nativeOrigins.includes(o);
}

export function mountPrismMcp(app: Hono, mountPath = "/mcp", opts: MountOptions = {}): void {
  if (!/^\/[A-Za-z0-9/_.-]*[A-Za-z0-9_-]$/.test(mountPath)) throw new Error(`mountPrismMcp: bad mount path ${mountPath}`);
  const tools = () => opts.tools ?? PRISM_TOOLS;

  const handler = createMcpHandler(
    (ctx) => buildMcpServer(ctx.authInfo?.extra?.principal as McpPrincipal | undefined, tools(), app, opts.resources ?? PRISM_RESOURCES),
    { onerror: (e) => console.warn(`[mcp] ${mountPath}: ${e.message}`) },
  );

  const metadata = (c: Context) => {
    c.header("Cache-Control", "public, max-age=3600");
    c.header("Access-Control-Allow-Origin", "*"); // public, credential-free discovery doc
    return c.json(protectedResourceMetadata(mountPath));
  };
  app.get(`${PRM_BASE}${mountPath}`, metadata);
  if (opts.rootMetadata ?? mountPath === "/mcp") app.get(PRM_BASE, metadata);

  app.on(["GET", "POST", "DELETE"], mountPath, async (c) => {
    if (!originAllowed(c.req.header("origin"))) {
      return c.json({ error: "forbidden_origin" }, 403);
    }

    const failKey = `mcp-authfail:${rateLimitClientKey(c)}`;
    const blocked = rateLimited(failKey, config.mcpAuthFailuresPer10Min);
    if (blocked !== null) {
      c.header("Retry-After", String(blocked));
      return c.json({ error: "rate_limited", retryAfter: blocked }, 429);
    }

    const auth = await authenticateMcp(c);
    if (!auth.ok) {
      consumeRateLimit(failKey, config.mcpAuthFailuresPer10Min, AUTH_FAIL_WINDOW_MS);
      return challenge(c, mountPath, auth);
    }
    const p = auth.principal;

    const retry = consumeRateLimit(`mcp:${p.via}:${p.credentialId}`, config.mcpRatePerMinute, 60_000);
    if (retry !== null) {
      c.header("Retry-After", String(retry));
      return c.json({ error: "rate_limited", retryAfter: retry }, 429);
    }

    const res = await handler.fetch(c.req.raw, {
      // Pass-through to the per-request factory. `token` carries the credential
      // ID, never the secret: the bearer is not handed to the SDK or any tool.
      authInfo: {
        token: p.credentialId,
        clientId: p.via,
        scopes: p.readOnly ? ["prism:read"] : ["prism:read", "prism:write"],
        ...(p.expiresAt ? { expiresAt: Math.floor(p.expiresAt / 1000) } : {}),
        resourceMetadataUrl: metadataUrl(mountPath),
        extra: { principal: p },
      },
    });
    // Per-actor responses: never cacheable by an intermediary.
    const headers = new Headers(res.headers);
    headers.set("Cache-Control", "no-store");
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  });
}
