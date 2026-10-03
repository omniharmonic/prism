import { useContext, useState } from "react";
import { QueryClientContext } from "@tanstack/react-query";
import { ChevronRight, ExternalLink, FileText } from "lucide-react";
import { useOptionalVaultClient } from "../../data/VaultClientContext";
import { useVaultTree } from "../../app/hooks/useParachute";
import { useUIStore } from "../../app/stores/ui";
import { PageIcon } from "../../lib/pages/icons";
import type { ContentType } from "../../lib/types";
import "./PublishHandoff.css";

const leaf = (path: string | null) => (path ?? "").split("/").pop() || "Untitled";
const SHOWN = 8;

/** Pages carrying `tag`, from the sidebar tree (already limited to what this account can see; Trash excluded). */
function TagPreview({ tag, noteId }: { tag: string; noteId: string }) {
  const { data: tree, isLoading } = useVaultTree();
  const [all, setAll] = useState(false);
  if (isLoading) return <p role="status">Loading the collection…</p>;
  const pages = (tree ?? []).filter((n) => (n.tags ?? []).includes(tag)).sort((a, b) => leaf(a.path).localeCompare(leaf(b.path)));
  if (!pages.length) return <p>None of the pages you can see carry #{tag} yet.</p>;
  const shown = all ? pages : pages.slice(0, SHOWN);
  return (
    <div className="share-card publish-preview" role="group" aria-label={`Pages you can see tagged ${tag}`}>
      <h3>{pages.length} page{pages.length === 1 ? "" : "s"} you can see with #{tag}</h3>
      <ul>
        {shown.map((p) => (
          <li key={p.id} aria-current={p.id === noteId ? "true" : undefined}>
            <PageIcon noteId={p.id} fallback={<FileText size={13} aria-hidden="true" />} />
            <span>{leaf(p.path)}</span>
            {p.id === noteId && <em>this page</em>}
          </li>
        ))}
      </ul>
      {pages.length > SHOWN && (
        <button type="button" className="publish-preview-more" onClick={() => setAll((v) => !v)}>
          {all ? "Show fewer" : `Show all ${pages.length}`}
        </button>
      )}
      <p className="publish-preview-note">
        This is your own view of the tag, not the published set: the site shows only pages its readers may see, so private pages are left out and
        pages you cannot see may be included. The Publishing studio shows exactly what goes live.
      </p>
    </div>
  );
}

/**
 * NP-CO-08 — the Share dialog's Publish tab explains that publishing is per tag,
 * previews the collection, and hands off to the Publishing studio (Workspace
 * settings → Publish), where the site's navigation, presentation and address are
 * reviewed before it goes live.
 */
export function PublishHandoff({ tag, noteId, published, onClose }: { tag: string; noteId: string; published: boolean; onClose: () => void }) {
  const query = useContext(QueryClientContext);
  const vault = useOptionalVaultClient();
  return (
    <div className="share-stack publish-handoff">
      <p className="publish-explainer">
        Prism publishes <strong>by tag</strong>, not page by page: every page tagged <strong>#{tag}</strong> becomes a page of one read-only site,
        and pages you tag later join it automatically. To publish only this page, give it a tag of its own.
      </p>
      {query && vault && <TagPreview tag={tag} noteId={noteId} />}
      <button
        type="button"
        className="publish-studio-button"
        onClick={() => {
          onClose();
          useUIStore.getState().openTab("network", "Workspace settings", "network" as ContentType);
        }}
      >
        <ExternalLink size={15} aria-hidden="true" />
        <span>{published ? "Manage this site in the Publishing studio" : "Review and publish in the Publishing studio"}</span>
        <ChevronRight size={15} aria-hidden="true" />
      </button>
    </div>
  );
}
