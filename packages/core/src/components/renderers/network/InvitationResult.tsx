import { useState } from "react";
import { Copy, Check } from "lucide-react";
import { Button } from "../../ui/Button";
import type { SetPersonResult, ShareLevel } from "../../../data/CollabSharing";
import { copyText } from "../../../lib/clipboard";

export const ACCESS_LABELS: Record<ShareLevel, string> = {
  view: "Can view",
  comment: "Can comment",
  suggest: "Can suggest",
  edit: "Can edit",
};
export function AccessHelp({ level }: { level: ShareLevel }) {
  if (level === "suggest")
    return (
      <p className="mt-2 text-xs leading-relaxed text-[var(--text-secondary)]">
        Can suggest proposes edits and comments. Their changes wait for an
        editor’s review — they can’t change a page directly.
      </p>
    );
  if (level === "comment")
    return (
      <p className="mt-2 text-xs leading-relaxed text-[var(--text-secondary)]">
        Read-only in the live editor. Anchored comments currently require Can
        suggest.
      </p>
    );
  return null;
}
/** Never claim clipboard or delivery success until the corresponding action confirms it. */
export function InvitationResult({
  who,
  result,
}: {
  who: string;
  result: SetPersonResult;
}) {
  const [copy, setCopy] = useState<"idle" | "pending" | "copied" | "failed">(
    "idle",
  );
  if (!result.invited)
    return (
      <p role="status" className="text-sm">
        Access updated for {who}.
      </p>
    );
  return (
    <section
      aria-label={`Invitation for ${who}`}
      className="rounded-xl border border-[var(--glass-border)] p-4"
    >
      <h3
        className="m-0 break-words text-sm font-semibold"
        style={{ overflowWrap: "anywhere" }}
      >
        Invitation for {who}
      </h3>
      <p className="mt-2 text-sm text-[var(--text-secondary)]">
        {result.inviteUrl
          ? "Share this private invitation link with them to join. You can copy it below."
          : "An invitation was created, but no link was returned. Check the invitation delivery with your administrator."}
      </p>
      {result.inviteUrl && (
        <>
          <label className="sr-only" htmlFor="access-invitation-url">
            Invitation link
          </label>
          <input
            id="access-invitation-url"
            readOnly
            value={result.inviteUrl}
            onFocus={(event) => event.currentTarget.select()}
            className="focus-ring min-h-control w-full min-w-0 rounded-lg border border-[var(--glass-border)] bg-[var(--bg-base)] px-3 text-sm"
          />
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button
              className="min-h-control"
              loading={copy === "pending"}
              onClick={() => {
                setCopy("pending");
                void copyText(result.inviteUrl!).then((ok) =>
                  setCopy(ok ? "copied" : "failed"),
                );
              }}
            >
              {copy === "copied" ? <Check size={16} /> : <Copy size={16} />}{" "}
              {copy === "copied" ? "Copied" : "Copy invitation link"}
            </Button>
            <span
              role="status"
              className="text-xs text-[var(--text-secondary)]"
            >
              {copy === "failed"
                ? "Copy was blocked. Select the link above and copy it manually."
                : copy === "copied"
                  ? "Link copied. Send it directly to this person."
                  : ""}
            </span>
          </div>
        </>
      )}
    </section>
  );
}
