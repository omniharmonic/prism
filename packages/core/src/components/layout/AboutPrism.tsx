import { useQuery } from "@tanstack/react-query";
import { serverFetch } from "../../lib/transport/serverFetch";

/** The public repository; a server running a changed copy names its own in /api/version. */
const DEFAULT_SOURCE = "https://github.com/omniharmonic/prism";

interface VersionInfo {
  version?: string;
  license?: string;
  source?: string;
}

/** Only an https link is ever rendered (the value comes from the server's configuration). */
const safeSource = (s: unknown): string => (typeof s === "string" && /^https:\/\/[^\s"<>]+$/.test(s) ? s : DEFAULT_SOURCE);

/**
 * Settings → Advanced → About: the version, the licence and a link to the source code.
 * Prism is AGPL-3.0: this is where a server offers its source to the people using it (§13).
 * Without a server (the legacy desktop) it still shows the licence and the public repository.
 */
export function AboutPrism() {
  const { data } = useQuery({
    queryKey: ["server-version"],
    queryFn: async (): Promise<VersionInfo> => {
      const r = await serverFetch("/api/version");
      return r.ok ? ((await r.json()) as VersionInfo) : {};
    },
    staleTime: 10 * 60_000,
    retry: false,
  });
  const source = safeSource(data?.source);
  return (
    <section className="prism-settings__section" aria-label="About Prism">
      <h4>About Prism</h4>
      <ul className="text-sm" style={{ display: "grid", gap: 6, color: "var(--text-secondary)" }}>
        {data?.version && <li>Version {data.version}</li>}
        <li>
          Free software under the{" "}
          <a href="https://www.gnu.org/licenses/agpl-3.0.html" target="_blank" rel="noopener noreferrer" style={{ color: "var(--text-primary)", textDecoration: "underline" }}>
            GNU Affero General Public License v3.0
          </a>
        </li>
        <li>
          <a href={source} target="_blank" rel="noopener noreferrer" style={{ color: "var(--text-primary)", textDecoration: "underline" }}>
            Source code
          </a>
        </li>
      </ul>
    </section>
  );
}
