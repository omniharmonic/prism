export interface SourceLinkTarget { kind: "source"; id: string; vault: string; server: string; paired: boolean }

/** Strict descriptor passed by the native shell; never a workspace switch. */
export function sourceLinkTarget(path: string): SourceLinkTarget | null {
  if (!path.startsWith("/source/")) return null;
  {
    const m = /^\/source\/([A-Za-z0-9_-]{1,128})\/([A-Za-z0-9_-]{1,128})\?([^#]+)$/.exec(path);
    if (!m) return null;
    const query = new URLSearchParams(m[3]);
    if ([...query.keys()].length !== 2 || !query.has("server") || !["0", "1"].includes(query.get("paired") ?? "")) return null;
    try {
      const server = new URL(query.get("server")!);
      if (!["http:", "https:"].includes(server.protocol) || server.username || server.password || server.search || server.hash || server.pathname !== "/") return null;
      return { kind: "source", vault: m[1], id: m[2], server: server.origin, paired: query.get("paired") === "1" };
    } catch { return null; }
  }
}

export function sourceContextMatches(target: SourceLinkTarget, apiOrigin: string, identity: { authenticated: boolean; vaultId?: string } | null): boolean {
  return target.paired && apiOrigin === target.server && identity?.authenticated === true && identity.vaultId === target.vault;
}

export function sourceBrowserURL(target: SourceLinkTarget): string {
  const url = new URL(`/page/${target.id}`, target.server);
  url.searchParams.set("vault", target.vault);
  return url.href;
}
export function requestedSourceVault(search: string): string | null {
  const values = new URLSearchParams(search).getAll("vault");
  return values.length === 1 && /^[A-Za-z0-9_-]{1,128}$/.test(values[0]) ? values[0] : null;
}
