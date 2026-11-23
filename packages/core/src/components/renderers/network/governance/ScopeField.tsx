// The "where does this apply" control, shared by the role editor and the policy
// builder. Governance scopes are the same three everywhere — the whole commons, a
// tag, or one note — so they get one control rather than three ad-hoc inputs.
//
// The tag case pairs a free-text field with the shared TagPicker: the picker is
// how you choose an EXISTING tag (with its note count, so you can see how big the
// slice is), and the text field is how you name one that does not exist yet —
// which a commons routinely does, since a policy often precedes its first note.
import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Input } from "../../../ui/Input";
import { TagPicker } from "../TagPicker";
import type { TagCount } from "../../../../lib/types";
import { row, selectStyle } from "./ui";

export type ScopeKind = "global" | "tag" | "note";

export function ScopeField({
  scopeType,
  scope,
  onChange,
  tags,
  allowNote = false,
  testId,
}: {
  scopeType: ScopeKind;
  scope: string;
  onChange: (next: { scopeType: ScopeKind; scope: string }) => void;
  tags: TagCount[];
  allowNote?: boolean;
  testId?: string;
}) {
  const [browsing, setBrowsing] = useState(false);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }} data-testid={testId}>
      <div style={row}>
        <select
          value={scopeType}
          data-testid={testId ? `${testId}-kind` : undefined}
          onChange={(e) => onChange({ scopeType: e.target.value as ScopeKind, scope: "" })}
          style={selectStyle}
        >
          <option value="global">the whole commons</option>
          <option value="tag">notes tagged…</option>
          {allowNote && <option value="note">one note</option>}
        </select>

        {scopeType !== "global" && (
          <Input
            placeholder={scopeType === "tag" ? "tag (e.g. medicine)" : "note id"}
            value={scope}
            data-testid={testId ? `${testId}-value` : undefined}
            onChange={(e) => onChange({ scopeType, scope: e.target.value })}
            style={{ width: 200 }}
          />
        )}

        {scopeType === "tag" && (
          <button
            type="button"
            onClick={() => setBrowsing((b) => !b)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              background: "none",
              border: "none",
              cursor: "pointer",
              fontSize: 12,
              color: "var(--text-secondary)",
            }}
          >
            {browsing ? <ChevronDown size={13} /> : <ChevronRight size={13} />} browse tags
          </button>
        )}
      </div>

      {scopeType === "tag" && browsing && (
        <TagPicker
          tags={tags}
          selected={scope ? [scope] : []}
          multiple={false}
          maxHeight={160}
          onChange={(next) => onChange({ scopeType: "tag", scope: next[0] ?? "" })}
        />
      )}
    </div>
  );
}
