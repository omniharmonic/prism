import { leafTitle } from "../../lib/pages/containerTitle";
import { useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { QueryClientContext } from "@tanstack/react-query";
import { ChevronRight, ExternalLink, FileText, Globe } from "lucide-react";
import { useOptionalVaultClient } from "../../data/VaultClientContext";
import { useVaultTree } from "../../app/hooks/useParachute";
import { useUIStore } from "../../app/stores/ui";
import { PageIcon } from "../../lib/pages/icons";
import type { ContentType } from "../../lib/types";
import "./PublishHandoff.css";

const leaf = (path: string | null) => leafTitle(path) || "Untitled";
const SHOWN = 8;

/** Pages carrying `tag`, from the sidebar tree (already limited to what this account can see; Trash excluded). */
function TagPreview({ tag, noteId, onCount }: { tag: string; noteId: string; onCount?: (n: number | null) => void }) {
  const { data: tree, isLoading } = useVaultTree();
  const [all, setAll] = useState(false);
  const pages = (tree ?? []).filter((n) => (n.tags ?? []).includes(tag)).sort((a, b) => leaf(a.path).localeCompare(leaf(b.path)));
  const count = isLoading ? null : pages.length;
  useEffect(() => { onCount?.(count); }, [count, onCount]);
  if (isLoading) return <p role="status">Loading the collection…</p>;
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

/** What the Share dialog knows about the tag's site (`undefined` = still loading). */
export interface PublishFlowSite { url: string; passwordRequired?: boolean }

/**
 * NP-CO-08 — the Share dialog's Publish tab as ONE flow, top to bottom:
 * what publishing is (per tag) → what would go out (the pages YOU can see with the
 * tag, counted) → the site's state and public address → publish / unpublish, each
 * behind a confirm step that says what happens → the optional password → the
 * Publishing studio for navigation and presentation. Publishing here and in the
 * studio is the same operation on the same publication (`CollabSharing.publishTag` /
 * `unpublishTag`), so a site made here opens in the studio and the other way round.
 * Every state has a next step: nothing published → Publish; published → the address,
 * Unpublish, password, studio; a failed call leaves the form as it was (the dialog
 * shows the error) and can be tried again.
 */
export function PublishFlow({ tag, noteId, site, busy, publishedCount, copyButton, canPublish, canUnpublish, canSetPassword, onPublish, onUnpublish, onSetPassword, onClose }: {
  tag: string;
  noteId: string;
  site: PublishFlowSite | null | undefined;
  busy: boolean;
  /** Pages the server counted in the published set at the last publish from here. */
  publishedCount: number | null;
  copyButton: (url: string, label: string) => ReactNode;
  canPublish: boolean;
  canUnpublish: boolean;
  canSetPassword: boolean;
  onPublish: (password: string | undefined) => Promise<boolean>;
  onUnpublish: () => Promise<boolean>;
  onSetPassword: (password: string | null) => Promise<boolean>;
  onClose: () => void;
}) {
  const query = useContext(QueryClientContext);
  const vault = useOptionalVaultClient();
  const [password, setPassword] = useState("");
  const [confirming, setConfirming] = useState<null | "publish" | "unpublish">(null);
  const [seen, setSeen] = useState<number | null>(null);
  const confirmRef = useRef<HTMLDivElement>(null);
  // Another tag is another site: start that flow from the top.
  useEffect(() => { setConfirming(null); setPassword(""); }, [tag]);
  useEffect(() => { if (confirming) confirmRef.current?.querySelector<HTMLButtonElement>("button")?.focus(); }, [confirming]);
  const pages = (n: number) => `${n} page${n === 1 ? "" : "s"}`;
  const what = seen === null ? `every page tagged #${tag} that readers may see` : `the ${pages(seen)} you can see with #${tag} (private pages are left out)`;
  return (
    <div className="share-stack publish-handoff">
      <p className="publish-explainer">
        Prism publishes <strong>by tag</strong>, not page by page: every page tagged <strong>#{tag}</strong> becomes a page of one read-only site,
        and pages you tag later join it automatically. To publish only this page, give it a tag of its own.
      </p>
      {query && vault && <TagPreview tag={tag} noteId={noteId} onCount={setSeen} />}
      {site === undefined ? (
        <p role="status">Loading published sites…</p>
      ) : (
        <div className="share-card share-stack publish-state" role="group" aria-label={`Site for ${tag}`} data-published={site ? "true" : "false"}>
          {site ? (
            <>
              <h3>Published{site.passwordRequired ? " · password required" : ""}</h3>
              <p className="publish-url">
                <a href={site.url} target="_blank" rel="noopener noreferrer">{site.url}</a>
                {copyButton(site.url, "published site")}
              </p>
              <p>
                {publishedCount !== null ? `${pages(publishedCount)} ${publishedCount === 1 ? "is" : "are"} live. ` : ""}
                {site.passwordRequired ? "Readers need the site password." : "Anyone with the address can read it."}
              </p>
            </>
          ) : (
            <>
              <h3>Not published</h3>
              <p>Nobody outside the workspace can read #{tag} pages. Publishing creates a public, read-only site at its own address, shown here once it is live.</p>
            </>
          )}
          {confirming === null && (
            <>
              <label>
                {site ? "Update site password" : "Site password (optional)"}
                <input type="password" autoComplete="new-password" value={password} disabled={busy} onChange={(e) => setPassword(e.target.value)}
                  placeholder={site?.passwordRequired ? "Enter a new password" : "Leave empty for public access"} />
              </label>
              <div className="share-row">
                {site ? (
                  <>
                    <button type="button" disabled={busy || !canSetPassword || (!password && !site.passwordRequired)}
                      onClick={() => void onSetPassword(password || null).then((ok) => { if (ok) setPassword(""); })}>
                      {password ? "Set password" : "Remove password"}
                    </button>
                    <button type="button" disabled={busy || !canUnpublish} onClick={() => setConfirming("unpublish")}>Unpublish</button>
                  </>
                ) : (
                  <button type="button" className="share-primary" disabled={busy || !canPublish} onClick={() => setConfirming("publish")}>
                    <Globe size={16} aria-hidden="true" />
                    Publish collection
                  </button>
                )}
              </div>
            </>
          )}
          {confirming === "publish" && (
            <div ref={confirmRef} className="publish-confirm" role="group" aria-label="Confirm publishing">
              <p>
                <strong>Publish #{tag} to the web?</strong> This makes {what} readable {password ? "by anyone who has the address and the password you set" : "by anyone who has the address"},
                and pages tagged #{tag} later join automatically. Nobody can edit through the site, and you can unpublish at any time.
              </p>
              <div className="share-row">
                <button type="button" disabled={busy} onClick={() => setConfirming(null)}>Cancel</button>
                <button type="button" className="share-primary" disabled={busy}
                  onClick={() => void onPublish(password || undefined).then((ok) => { if (ok) { setPassword(""); setConfirming(null); } })}>
                  <Globe size={16} aria-hidden="true" />
                  {busy ? "Publishing…" : "Publish site"}
                </button>
              </div>
            </div>
          )}
          {confirming === "unpublish" && site && (
            <div ref={confirmRef} className="publish-confirm" role="group" aria-label="Confirm unpublishing">
              <p>
                <strong>Unpublish #{tag}?</strong> The address above stops working for everyone at once. The pages themselves are not changed, and you can publish again later.
              </p>
              <div className="share-row">
                <button type="button" disabled={busy} onClick={() => setConfirming(null)}>Cancel</button>
                <button type="button" className="share-primary" disabled={busy}
                  onClick={() => void onUnpublish().then((ok) => { if (ok) setConfirming(null); })}>
                  {busy ? "Unpublishing…" : "Unpublish site"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      <button
        type="button"
        className="publish-studio-button"
        onClick={() => {
          onClose();
          useUIStore.getState().openTab("network", "Workspace settings", "network" as ContentType);
        }}
      >
        <ExternalLink size={15} aria-hidden="true" />
        <span>{site ? "Manage this site in the Publishing studio" : "Review and publish in the Publishing studio"}</span>
        <ChevronRight size={15} aria-hidden="true" />
      </button>
      <p className="publish-preview-note">The studio is where the site’s title, navigation, home page and appearance are set; publishing there and here is the same site.</p>
    </div>
  );
}
