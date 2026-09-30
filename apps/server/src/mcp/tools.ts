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
 *  - `annotations.readOnlyHint` is REQUIRED and load-bearing: a read-only
 *    credential (PAT scope `read`, a read-verb hub JWT) only ever sees tools that
 *    declare `readOnlyHint: true`.
 *  - Handlers return plain JSON data or throw `ToolError`; everything else is
 *    mapped by `mapToolError` to a uniform `{ error, message }` tool error (never
 *    a stack trace or a vault response body).
 *  - Every call writes ONE audit line: credential, account, tool, outcome,
 *    duration — never the arguments or results.
 */
import * as z from "zod/v4";
import type { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/server";
import type { McpPrincipal } from "./auth";
import { dispatchAsActor, type Dispatch } from "./dispatch";
import { ToolError, mapToolError } from "./errors";

export { ToolError, mapToolError, type ToolErrorCode } from "./errors";

export interface ToolContext {
  principal: McpPrincipal;
  /** Call a Prism route in-process AS this principal's actor (see dispatch.ts). */
  dispatch: Dispatch;
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

export interface PrismTool<S extends z.ZodObject = z.ZodObject> {
  name: string;
  title?: string;
  description: string;
  inputSchema: S;
  annotations: ToolAnnotations;
  access: ToolAccess<z.infer<S>>;
  handler: (args: z.infer<S>, ctx: ToolContext) => Promise<Record<string, unknown>>;
}

const TOOL_NAME = /^prism_[a-z][a-z0-9_]{0,62}$/;

/** Define a tool. Throws on a missing `access` or `readOnlyHint` — they are not optional. */
export function defineTool<S extends z.ZodObject>(def: PrismTool<S>): PrismTool<S> {
  if (!TOOL_NAME.test(def.name)) throw new Error(`defineTool: bad tool name "${def.name}" (want prism_[a-z0-9_]+)`);
  if (typeof def.access !== "function") throw new Error(`defineTool(${def.name}): access is required`);
  if (typeof def.annotations?.readOnlyHint !== "boolean") throw new Error(`defineTool(${def.name}): annotations.readOnlyHint is required`);
  if (typeof def.handler !== "function") throw new Error(`defineTool(${def.name}): handler is required`);
  return def;
}

/** The tools this principal may see — evaluated fresh per request (no caching across actors). */
export async function visibleTools(principal: McpPrincipal, tools: readonly PrismTool[]): Promise<PrismTool[]> {
  const out: PrismTool[] = [];
  for (const t of tools) {
    if (principal.readOnly && !t.annotations.readOnlyHint) continue;
    try {
      if (await t.access(principal)) out.push(t);
    } catch (e) {
      // A throwing access check hides the tool (fail closed) — and is a bug worth seeing.
      console.error(`[mcp] access(${t.name}) threw:`, (e as Error).message);
    }
  }
  return out;
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
export async function buildMcpServer(principal: McpPrincipal | undefined, tools: readonly PrismTool[], app: Hono): Promise<McpServer> {
  const server = new McpServer({ ...SERVER_INFO }, { instructions: SERVER_INSTRUCTIONS });
  if (!principal) return server; // unreachable behind the router's auth gate — expose nothing
  const ctx: ToolContext = {
    principal,
    dispatch: (path, init) => dispatchAsActor(app, principal.actor, path, init),
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
  return server;
}
