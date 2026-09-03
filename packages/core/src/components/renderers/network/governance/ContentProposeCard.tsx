// Propose a content change — the door an ordinary contributor uses. Whether the
// change goes live on approval or waits for a publisher is the RULE's decision,
// not this form's, so the card tells you which rule will govern what you are about
// to submit before you submit it.
import { useMemo, useState } from "react";
import { FilePlus2, Send } from "lucide-react";
import { Button } from "../../../ui/Button";
import { Input } from "../../../ui/Input";
import { renderPolicySentence, resolvePolicyConflict } from "../../../../lib/governance/prose";
import { govApi } from "./api";
import type { GovCtx } from "./ctx";
import { Field, Section, row, sentence } from "./ui";

export function ContentProposeCard({ ctx }: { ctx: GovCtx }) {
  const [mode, setMode] = useState<"edit_note" | "new_entry">("edit_note");
  const [target, setTarget] = useState("");
  const [path, setPath] = useState("");
  const [tags, setTags] = useState("");
  const [content, setContent] = useState("");

  const tagList = useMemo(() => tags.split(",").map((t) => t.trim()).filter(Boolean), [tags]);

  // Which rule will judge this? For a new entry we know the tags up front; for an
  // edit we don't know the target's tags without fetching it, so we show the
  // commons-wide rule and say so.
  const governing = useMemo(() => {
    const ctxScope = mode === "new_entry" ? { tags: tagList } : { noteId: target, tags: [] };
    return resolvePolicyConflict(ctx.state.policies, mode, ctxScope).winner;
  }, [ctx.state.policies, mode, tagList, target]);

  const submit = async () => {
    const r =
      mode === "edit_note"
        ? await ctx.run(() => govApi.proposeContent({ action: "edit_note", target: target.trim(), content }))
        : await ctx.run(() => govApi.proposeContent({ action: "new_entry", path: path.trim(), tags: tagList, content }));
    if (r.ok) {
      setContent("");
      ctx.notify("Proposal opened. It goes live when the rule above is satisfied.");
    }
  };

  return (
    <Section
      icon={<FilePlus2 size={16} />}
      title="Propose a change to the content"
      subtitle="Anyone with standing may propose. Whether it lands is up to the rule that governs it."
      testId="gov-content-propose"
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ ...row, gap: 16 }}>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer", color: "var(--text-primary)" }}>
            <input type="radio" aria-label="edit an existing note" checked={mode === "edit_note"} onChange={() => setMode("edit_note")} />
            Edit an existing note
          </label>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer", color: "var(--text-primary)" }}>
            <input type="radio" aria-label="add a new entry" checked={mode === "new_entry"} onChange={() => setMode("new_entry")} />
            Add a new entry
          </label>
        </div>

        <div style={row}>
          {mode === "edit_note" ? (
            <Field text="Note id" width={280}>
              <Input placeholder="note id" value={target} onChange={(e) => setTarget(e.target.value)} data-testid="gov-propose-target" />
            </Field>
          ) : (
            <>
              <Field text="Path" width={240}>
                <Input placeholder="medicine/yarrow" value={path} onChange={(e) => setPath(e.target.value)} data-testid="gov-propose-path" />
              </Field>
              <Field text="Tags (comma separated)" width={240}>
                <Input placeholder="medicine" value={tags} onChange={(e) => setTags(e.target.value)} data-testid="gov-propose-tags" />
              </Field>
            </>
          )}
        </div>

        <Field text="Proposed text (a stub is fine — someone can fill it in)">
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            data-testid="gov-propose-content"
            style={{
              width: "100%",
              minHeight: 100,
              padding: 10,
              borderRadius: 8,
              fontSize: 13,
              background: "var(--glass)",
              color: "var(--text-primary)",
              border: "1px solid var(--glass-border)",
            }}
          />
        </Field>

        <p style={{ ...sentence, color: "var(--text-secondary)", margin: 0 }} data-testid="gov-propose-rule">
          {governing
            ? renderPolicySentence(governing, { roleName: governing.eligibleRole || ctx.state.config.defaultEligibleRole })
            : `No rule covers this yet, so it falls back to the constitution's default: ${ctx.state.config.defaultThresholdN} approval(s).`}
        </p>

        <div>
          <Button variant="primary" onClick={() => void submit()} icon={<Send size={13} />} data-testid="gov-propose-submit">
            Propose
          </Button>
        </div>
      </div>
    </Section>
  );
}
