/**
 * The Prism MCP tool registry (WP6.1 scaffold; WP6.2+ add the tools).
 *
 * Conventions (mirroring Parachute's backed-surface kit, `defineTool`):
 *  - `access` is REQUIRED. It is evaluated per principal when building
 *    `tools/list` (args undefined) and AGAIN per call with the parsed args. A
 *    tool whose access is false is simply absent from that principal's list, and
 *    calling it by name answers exactly like a tool that does not exist — no
 *    existence oracle. `access` is a nicer, earlier error; the route/permission
 *    code the handler reaches (dispatch.ts → the gateway, or effectiveCaps) stays
 *    the authoritative guard.
 *  - `scope: "read" | "write"` is REQUIRED and must agree with
 *    `annotations.readOnlyHint` (defineTool throws otherwise). A read-only
 *    credential (PAT scope `read`) is held to read tools THREE times over: they
 *    are the only ones in its tools/list, a call to a write-scope tool is refused
 *    at call time, and its dispatches may only be GET/HEAD (dispatch.ts) — so a
 *    mislabelled tool still cannot write for a read credential.
 *  - Handlers return plain JSON data or throw `ToolError`; everything else is
 *    mapped by `mapToolError` to a uniform `{ error, message }` tool error (never
 *    a stack trace or a vault response body).
 *  - Every call writes ONE audit line: credential, account, tool, outcome,
 *    duration — never the arguments or results.
 */
import * as z from "zod/v4";
import type { Hono } from "hono";
import { McpServer, ResourceTemplate, ResourceNotFoundError, type CacheHint } from "@modelcontextprotocol/server";
import type { McpPrincipal } from "./auth";
import { dispatchAsActor, dispatchShareAsActor, type Dispatch } from "./dispatch";
import { ToolError, mapToolError } from "./errors";

export { ToolError, mapToolError, type ToolErrorCode } from "./errors";

export interface ToolContext {
  principal: McpPrincipal;
  /** Call a Prism route in-process AS this principal's actor (see dispatch.ts). */
  dispatch: Dispatch;
  /** The scoped-share `/acl` routes ONLY (exact allowlist; see dispatch.ts). */
  dispatchShare: Dispatch;
}

export interface ToolAnnotations {
  title?: string;
  /** REQUIRED: true for tools that never change state. Gates read-only credentials. */
  readOnlyHint: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export type ToolAccess<A> = (principal: McpPrincipal, args?: A) => boolean | Promise<boolean>;

export type ToolScope = "read" | "write";

export interface PrismTool<S extends z.ZodObject = z.ZodObject> {
  name: string;
  /** REQUIRED: "read" for tools that never change state; must match annotations.readOnlyHint. */
  scope: ToolScope;
  title?: string;
  description: string;
  inputSchema: S;
  annotations: ToolAnnotations;
  access: ToolAccess<z.infer<S>>;
  handler: (args: z.infer<S>, ctx: ToolContext) => Promise<Record<string, unknown>>;
}

const TOOL_NAME = /^prism_[a-z][a-z0-9_]{0,62}$/;

/** Define a tool. Throws on a missing `access`/`scope`/`readOnlyHint`, or a scope that disagrees with readOnlyHint. */
export function defineTool<S extends z.ZodObject>(def: PrismTool<S>): PrismTool<S> {
  if (!TOOL_NAME.test(def.name)) throw new Error(`defineTool: bad tool name "${def.name}" (want prism_[a-z0-9_]+)`);
  if (typeof def.access !== "function") throw new Error(`defineTool(${def.name}): access is required`);
  if (typeof def.annotations?.readOnlyHint !== "boolean") throw new Error(`defineTool(${def.name}): annotations.readOnlyHint is required`);
  if (def.scope !== "read" && def.scope !== "write") throw new Error(`defineTool(${def.name}): scope ("read" | "write") is required`);
  if ((def.scope === "read") !== def.annotations.readOnlyHint) {
    throw new Error(`defineTool(${def.name}): scope "${def.scope}" disagrees with annotations.readOnlyHint=${def.annotations.readOnlyHint}`);
  }
  if (typeof def.handler !== "function") throw new Error(`defineTool(${def.name}): handler is required`);
  return def;
}

/** May this principal use this tool at all, by scope? (Both labels must say "read" for a read principal.) */
export const scopeAllows = (p: McpPrincipal, t: PrismTool): boolean =>
  !p.readOnly || (t.scope === "read" && t.annotations.readOnlyHint === true);

/** The tools this principal may see — evaluated fresh per request (no caching across actors). */
export async function visibleTools(principal: McpPrincipal, tools: readonly PrismTool[]): Promise<PrismTool[]> {
  const out: PrismTool[] = [];
  for (const t of tools) {
    if (!scopeAllows(principal, t)) continue;
    try {
      if (await t.access(principal)) out.push(t);
    } catch (e) {
      // A throwing access check hides the tool (fail closed) — and is a bug worth seeing.
      console.error(`[mcp] access(${t.name}) threw:`, (e as Error).message);
    }
  }
  return out;
}

/** A resource template the endpoint serves (WP6.2: `prism://note/{id}`). Same access/dispatch model as a tool. */
export interface PrismResource {
  name: string;
  uriTemplate: string;
  title?: string;
  description: string;
  mimeType: string;
  cacheHint?: CacheHint;
  /** Registered (and readable) only when true for this principal. */
  access: (principal: McpPrincipal) => boolean | Promise<boolean>;
  /** Return the contents, or throw ToolError (forbidden/not_found both surface as "resource not found"). */
  read: (uri: URL, vars: Record<string, string | string[]>, ctx: ToolContext) => Promise<Array<{ uri: string; mimeType: string; text: string }>>;
}

/** An MCP prompt: a guided flow the client can offer. Text only; may read through ctx.dispatch. */
export interface PrismPrompt<S extends z.ZodObject = z.ZodObject> {
  name: string;
  title?: string;
  description: string;
  argsSchema: S;
  access: (principal: McpPrincipal) => boolean | Promise<boolean>;
  build: (args: z.infer<S>, ctx: ToolContext) => Promise<string>;
}

const text = (data: unknown): string => JSON.stringify(data, null, 2);

function errorResult(err: ToolError) {
  const payload: Record<string, unknown> = { error: err.code, message: err.message };
  if (err.detail !== undefined) payload.detail = err.detail;
  return { isError: true, content: [{ type: "text" as const, text: text(payload) }], structuredContent: payload };
}

function audit(p: McpPrincipal, tool: string, outcome: string, startedAt: number): void {
  console.log(`[mcp] ${p.via}:${p.credentialId} ${p.actor.email} vault=${p.actor.vaultId} ${tool} ${outcome} ${Date.now() - startedAt}ms`);
}

export const SERVER_INFO = { name: "prism", version: "0.1.0" } as const;
export const SERVER_INSTRUCTIONS =
  "Prism: permission-scoped access to a Parachute knowledge vault. Every tool acts as YOUR Prism account, " +
  "limited to what that account may see or change. Call prism_whoami first to learn your account, vault and capabilities.";

/**
 * Build the per-request MCP server for one principal: register exactly the tools
 * it may see, each wrapped with the per-call access re-check, error mapping and
 * audit line. Stateless — a fresh instance per HTTP request.
 */
export async function buildMcpServer(
  principal: McpPrincipal | undefined,
  tools: readonly PrismTool[],
  app: Hono,
  resources: readonly PrismResource[] = [],
  prompts: readonly PrismPrompt[] = [],
): Promise<McpServer> {
  const server = new McpServer({ ...SERVER_INFO }, { instructions: SERVER_INSTRUCTIONS });
  if (!principal) return server; // unreachable behind the router's auth gate — expose nothing
  const ctx: ToolContext = {
    principal,
    // The principal (not just its actor) — dispatch enforces its read-only ceiling.
    dispatch: (path, init) => dispatchAsActor(app, principal, path, init),
    dispatchShare: (path, init) => dispatchShareAsActor(app, principal, path, init),
  };
  for (const tool of await visibleTools(principal, tools)) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      },
      async (args: unknown) => {
        const started = Date.now();
        try {
          // Call-time scope check: never rely on tools/list alone.
          if (!scopeAllows(principal, tool)) throw new ToolError("forbidden", "this credential is read-only");
          if (!(await tool.access(principal, args as never))) throw new ToolError("forbidden", "you do not have access to that");
          const data = await tool.handler(args as never, ctx);
          audit(principal, tool.name, "ok", started);
          return { content: [{ type: "text" as const, text: text(data) }], structuredContent: data };
        } catch (e) {
          const err = mapToolError(e);
          if (err.code === "internal_error") console.error(`[mcp] ${tool.name} failed:`, e);
          audit(principal, tool.name, `error:${err.code}`, started);
          return errorResult(err);
        }
      },
    );
  }
  for (const res of resources) {
    let allowed = false;
    try {
      allowed = await res.access(principal);
    } catch {
      allowed = false; // fail closed
    }
    if (!allowed) continue;
    server.registerResource(
      res.name,
      new ResourceTemplate(res.uriTemplate, { list: undefined }),
      { title: res.title, description: res.description, mimeType: res.mimeType, cacheHint: res.cacheHint },
      async (uri, vars) => {
        const started = Date.now();
        try {
          const contents = await res.read(uri, vars as Record<string, string | string[]>, ctx);
          audit(principal, `resource:${res.name}`, "ok", started);
          return { contents };
        } catch (e) {
          const err = mapToolError(e);
          if (err.code === "internal_error") console.error(`[mcp] resource ${res.name} failed:`, e);
          audit(principal, `resource:${res.name}`, `error:${err.code}`, started);
          // A resource you may not see answers exactly like one that does not exist.
          if (err.code === "forbidden" || err.code === "not_found") throw new ResourceNotFoundError(uri.href);
          throw new Error(err.message);
        }
      },
    );
  }
  for (const pr of prompts) {
    let allowed = false;
    try {
      allowed = await pr.access(principal);
    } catch {
      allowed = false; // fail closed
    }
    if (!allowed) continue;
    server.registerPrompt(
      pr.name,
      { title: pr.title, description: pr.description, argsSchema: pr.argsSchema },
      async (args: unknown) => {
        const started = Date.now();
        try {
          const body = await pr.build(args as never, ctx);
          audit(principal, `prompt:${pr.name}`, "ok", started);
          return { messages: [{ role: "user" as const, content: { type: "text" as const, text: body } }] };
        } catch (e) {
          const err = mapToolError(e);
          if (err.code === "internal_error") console.error(`[mcp] prompt ${pr.name} failed:`, e);
          audit(principal, `prompt:${pr.name}`, `error:${err.code}`, started);
          throw new Error(err.message);
        }
      },
    );
  }
  return server;
}
