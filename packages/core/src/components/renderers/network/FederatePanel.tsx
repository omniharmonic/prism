// FederatePanel — the Federation management surface (Network → Federate).
//
// Where the owner makes their vault a node in a peer-to-peer federation:
//   1. This node — the node's identity (fingerprint = the trust primitive).
//   2. Peers     — pair with peer hubs (invite / join) + verify fingerprints.
//   3. Spaces    — define shared slices of the vault + grant peers a level.
//   4. Inbox     — approve inbound mirror requests (a peer never writes unasked).
//
// CORE component: all IO goes through the `useCollabSharing()` / `useVaultClient()`
// seams; every section is gated on the backing methods being present so the
// surface degrades on the desktop shell / for capability viewers. Fingerprints
// are the only trust concept surfaced — no git, device-ids, or conflict files,
// and CRDT merge is automatic (no conflict UI, ever).
import {
  useCallback,
  useEffect,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  Radio,
  Users,
  Plus,
  Copy,
  Check,
  Trash2,
  Shield,
  ShieldCheck,
  Share2,
  Inbox,
  ArrowRightLeft,
  Circle,
  Link2,
  RefreshCw,
  ChevronRight,
  ChevronDown,
  AlertTriangle,
} from "lucide-react";
import { Button } from "../../ui/Button";
import { Badge } from "../../ui/Badge";
import { Input } from "../../ui/Input";
import {
  useCollabSharing,
  type CollabSharing,
  type ShareLevel,
  type NodeIdentity,
  type PeerInfo,
  type SpaceInfo,
  type MirrorRequestInfo,
} from "../../../data/CollabSharing";
import { useVaultClient } from "../../../data/VaultClientContext";
import type { VaultClient } from "../../../data/VaultClient";
import type { Note, TagCount } from "../../../lib/types";
import { TagPicker } from "./TagPicker";

// Spaces are coarser than per-note sharing: view / suggest / edit only.
const SPACE_LEVELS: ShareLevel[] = ["view", "suggest", "edit"];

// ── shared styling (CSS vars only) ────────────────────────────────────────────
const card: CSSProperties = {
  background: "var(--glass)",
  border: "1px solid var(--glass-border)",
  borderRadius: 14,
  padding: 18,
};
const subCard: CSSProperties = {
  background: "var(--glass-hover)",
  border: "1px solid var(--glass-border)",
  borderRadius: 11,
  padding: 14,
};
const mono: CSSProperties = {
  fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
  wordBreak: "break-all",
};
const selectStyle: CSSProperties = {
  height: 28,
  borderRadius: 8,
  padding: "0 8px",
  fontSize: 12,
  background: "var(--glass)",
  border: "1px solid var(--glass-border)",
  color: "var(--text-primary)",
  outline: "none",
  cursor: "pointer",
};
const labelText: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: 0.4,
  textTransform: "uppercase",
  color: "var(--text-muted)",
};
const helpText: CSSProperties = { fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.5 };

// ── tiny helpers ──────────────────────────────────────────────────────────────
function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
function fmtDate(ts: number | null | undefined): string {
  if (!ts) return "—";
  const ms = ts < 1e12 ? ts * 1000 : ts; // tolerate seconds or millis
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
function timeAgo(ts: number): string {
  const ms = ts < 1e12 ? ts * 1000 : ts; // tolerate seconds or millis
  const sec = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (sec < 45) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}
function noteTitle(n: Note): string {
  return (
    n.path?.split("/").pop() ||
    (n.metadata?.title as string | undefined) ||
    n.content?.split("\n")[0]?.slice(0, 60) ||
    n.id
  );
}
function sliceLabel(s: SpaceInfo): string {
  const parts: string[] = [];
  if (s.includeTags?.length) parts.push(s.includeTags.map((t) => `#${t}`).join(" "));
  if (s.pathPrefix) parts.push(s.pathPrefix);
  if (s.excludeTags?.length) parts.push(`−${s.excludeTags.map((t) => `#${t}`).join(" ")}`);
  return parts.join(" · ") || "Whole vault";
}

/** Small async-action helper: busy flag + captured error, no thrown rejections. */
function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run, setError };
}

// ── reusable bits ─────────────────────────────────────────────────────────────
function SectionHeader({
  icon,
  title,
  hint,
  right,
}: {
  icon: ReactNode;
  title: string;
  hint?: string;
  right?: ReactNode;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
      <span style={{ color: "var(--text-secondary)", display: "flex" }}>{icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text-primary)" }}>{title}</div>
        {hint && <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 1 }}>{hint}</div>}
      </div>
      {right}
    </div>
  );
}

function CopyButton({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      icon={copied ? <Check size={13} /> : <Copy size={13} />}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard blocked — no-op */
        }
      }}
    >
      {label ?? (copied ? "Copied" : "Copy")}
    </Button>
  );
}

/** A loud, monospace fingerprint block — meant to be read aloud to verify a pair. */
function FingerprintBlock({
  value,
  caption,
  big,
}: {
  value: string;
  caption?: string;
  big?: boolean;
}) {
  return (
    <div style={{ ...subCard, display: "flex", alignItems: "center", gap: 12 }}>
      <ShieldCheck size={big ? 22 : 18} style={{ color: "var(--color-success)", flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        {caption && <div style={{ ...labelText, marginBottom: 4 }}>{caption}</div>}
        <div
          style={{
            ...mono,
            fontSize: big ? 20 : 15,
            fontWeight: 600,
            color: "var(--text-primary)",
            lineHeight: 1.35,
          }}
        >
          {value}
        </div>
      </div>
      <CopyButton value={value} />
    </div>
  );
}

function Banner({ tone, children }: { tone: "warn" | "info"; children: ReactNode }) {
  const color = tone === "warn" ? "var(--color-warning)" : "var(--accent)";
  return (
    <div
      style={{
        display: "flex",
        gap: 10,
        alignItems: "flex-start",
        padding: "10px 12px",
        borderRadius: 10,
        background: `color-mix(in srgb, ${color} 12%, transparent)`,
        border: `1px solid color-mix(in srgb, ${color} 35%, transparent)`,
        fontSize: 12.5,
        lineHeight: 1.5,
        color: "var(--text-secondary)",
      }}
    >
      <AlertTriangle size={15} style={{ color, flexShrink: 0, marginTop: 1 }} />
      <div>{children}</div>
    </div>
  );
}

function FieldError({ error }: { error: string | null }) {
  if (!error) return null;
  return <div style={{ fontSize: 12, color: "var(--color-danger)", marginTop: 6 }}>{error}</div>;
}

function LevelSelect({ value, onChange }: { value: ShareLevel; onChange: (l: ShareLevel) => void }) {
  return (
    <select style={selectStyle} value={value} onChange={(e) => onChange(e.target.value as ShareLevel)}>
      {SPACE_LEVELS.map((l) => (
        <option key={l} value={l}>
          {l}
        </option>
      ))}
    </select>
  );
}

// ── 1. This node (identity) ───────────────────────────────────────────────────
function IdentityCard({
  identity,
  enabled,
  sharing,
  onToggled,
}: {
  identity: NodeIdentity;
  enabled: boolean;
  sharing: CollabSharing;
  onToggled: () => void;
}) {
  const toggle = useAction();
  const canToggle = !!sharing.setFederationEnabled;

  const flip = () =>
    toggle.run(async () => {
      await sharing.setFederationEnabled!(!enabled);
      onToggled();
    });

  return (
    <section style={card}>
      <SectionHeader
        icon={<Radio size={17} />}
        title="This node"
        hint="Your vault's identity in the federation."
        right={
          canToggle ? (
            <FederationToggle enabled={enabled} busy={toggle.busy} onClick={flip} />
          ) : enabled ? (
            <Badge variant="success">
              <ShieldCheck size={11} /> Federation on
            </Badge>
          ) : (
            <Badge variant="warning">
              <Shield size={11} /> Federation off
            </Badge>
          )
        }
      />

      <FingerprintBlock value={identity.fingerprint} caption="Your fingerprint — read this aloud to a peer to verify the pair" big />

      <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ ...labelText }}>Public key</span>
        <code style={{ ...mono, fontSize: 11, color: "var(--text-muted)", flex: 1, minWidth: 0 }}>
          {identity.publicKey.length > 44 ? identity.publicKey.slice(0, 44) + "…" : identity.publicKey}
        </code>
        <CopyButton value={identity.publicKey} label="Copy key" />
      </div>

      {toggle.error && (
        <div style={{ marginTop: 12 }}>
          <FieldError error={toggle.error} />
        </div>
      )}

      {!enabled && (
        <div style={{ marginTop: 14 }}>
          <Banner tone="warn">
            Federation transport is off, so pairing and spaces configure but don't sync yet.{" "}
            {canToggle ? "Flip the switch above to turn it on — no restart needed." : (
              <>Live sync needs <code style={mono}>FEDERATION_ENABLED=true</code> plus a server restart.</>
            )}
          </Banner>
        </div>
      )}
    </section>
  );
}

/** A labeled on/off switch for the federation transport (owner-only). */
function FederationToggle({ enabled, busy, onClick }: { enabled: boolean; busy: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label="Federation transport"
      disabled={busy}
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        background: "transparent",
        border: "none",
        cursor: busy ? "default" : "pointer",
        opacity: busy ? 0.6 : 1,
        padding: 0,
        font: "inherit",
      }}
    >
      <span
        style={{
          fontSize: 12,
          fontWeight: 600,
          color: enabled ? "var(--color-success)" : "var(--text-muted)",
        }}
      >
        Federation {enabled ? "on" : "off"}
      </span>
      <span
        style={{
          position: "relative",
          width: 38,
          height: 22,
          borderRadius: 999,
          flexShrink: 0,
          transition: "background 120ms ease",
          background: enabled ? "var(--color-success)" : "var(--glass-border)",
        }}
      >
        <span
          style={{
            position: "absolute",
            top: 2,
            left: enabled ? 18 : 2,
            width: 18,
            height: 18,
            borderRadius: "50%",
            background: "white",
            boxShadow: "0 1px 2px rgba(0,0,0,0.25)",
            transition: "left 120ms ease",
          }}
        />
      </span>
    </button>
  );
}

// ── 2. Peers (pairing) ────────────────────────────────────────────────────────
function PeersCard({
  sharing,
  identity,
  peers,
  onChanged,
}: {
  sharing: CollabSharing;
  identity: NodeIdentity;
  peers: PeerInfo[];
  onChanged: () => void;
}) {
  const [mode, setMode] = useState<"invite" | "join">("invite");

  // Invite-a-peer (mint a one-time code they redeem against THIS node).
  const [inviteLabel, setInviteLabel] = useState("");
  const [code, setCode] = useState<{ code: string; expiresInDays: number } | null>(null);
  const invite = useAction();

  // Join-a-peer (redeem THEIR code against their server).
  const [jCode, setJCode] = useState("");
  const [jUrl, setJUrl] = useState("");
  const [jLabel, setJLabel] = useState("");
  const [joined, setJoined] = useState<string | null>(null);
  const join = useAction();

  return (
    <section style={card}>
      <SectionHeader
        icon={<Users size={17} />}
        title="Peers"
        hint="Pair node-to-node — no shared credentials, no central server."
        right={peers.length > 0 ? <Badge variant="info">{peers.length} paired</Badge> : undefined}
      />

      {/* pair flow */}
      <div style={subCard}>
        <div style={{ display: "flex", gap: 4, marginBottom: 14 }}>
          <Button
            size="sm"
            variant={mode === "invite" ? "primary" : "ghost"}
            icon={<Plus size={13} />}
            onClick={() => setMode("invite")}
          >
            Invite a peer
          </Button>
          <Button
            size="sm"
            variant={mode === "join" ? "primary" : "ghost"}
            icon={<ArrowRightLeft size={13} />}
            onClick={() => setMode("join")}
          >
            Join a peer
          </Button>
        </div>

        {mode === "invite" ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <p style={helpText}>
              Mint a one-time code, then give it — plus your server URL — to the peer who will mirror you.
            </p>
            {!code ? (
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <Input
                  placeholder="Label (optional, e.g. Maria's hub)"
                  value={inviteLabel}
                  onChange={(e) => setInviteLabel(e.target.value)}
                  className="max-w-[260px]"
                />
                <Button
                  variant="primary"
                  size="sm"
                  loading={invite.busy}
                  icon={<Plus size={13} />}
                  onClick={() =>
                    invite.run(async () => {
                      if (!sharing.createPairingCode) throw new Error("Pairing not supported on this node.");
                      const pc = await sharing.createPairingCode(inviteLabel.trim() || undefined);
                      setCode({ code: pc.code, expiresInDays: pc.expiresInDays });
                      setInviteLabel("");
                    })
                  }
                >
                  Create invite code
                </Button>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div>
                  <div style={{ ...labelText, marginBottom: 4 }}>One-time pairing code</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <code
                      style={{
                        ...mono,
                        fontSize: 18,
                        fontWeight: 600,
                        color: "var(--text-primary)",
                        padding: "6px 12px",
                        borderRadius: 8,
                        background: "var(--glass)",
                        border: "1px solid var(--glass-border)",
                      }}
                    >
                      {code.code}
                    </code>
                    <CopyButton value={code.code} />
                  </div>
                </div>
                <p style={helpText}>
                  Give this code and your server URL to your peer. It expires in {code.expiresInDays}{" "}
                  {code.expiresInDays === 1 ? "day" : "days"}. Have them verify the fingerprint below
                  matches what you see here.
                </p>
                <FingerprintBlock value={identity.fingerprint} caption="Your fingerprint (so they can verify it's you)" />
                <div>
                  <Button size="sm" variant="ghost" onClick={() => setCode(null)}>
                    Done
                  </Button>
                </div>
              </div>
            )}
            <FieldError error={invite.error} />
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <p style={helpText}>Enter the code and server URL your peer gave you.</p>
            {joined ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <FingerprintBlock value={joined} caption="Your peer's fingerprint" big />
                <p style={helpText}>
                  Verify this matches what your peer sees on their node, then you're paired.
                </p>
                <div>
                  <Button size="sm" variant="ghost" onClick={() => setJoined(null)}>
                    Pair another
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <Input placeholder="Peer's pairing code" value={jCode} onChange={(e) => setJCode(e.target.value)} />
                <Input
                  placeholder="Peer's server URL (e.g. https://maria.example)"
                  value={jUrl}
                  onChange={(e) => setJUrl(e.target.value)}
                />
                <Input placeholder="Label (optional)" value={jLabel} onChange={(e) => setJLabel(e.target.value)} />
                <div>
                  <Button
                    variant="primary"
                    size="sm"
                    loading={join.busy}
                    disabled={!jCode.trim() || !jUrl.trim()}
                    icon={<ArrowRightLeft size={13} />}
                    onClick={() =>
                      join.run(async () => {
                        if (!sharing.redeemPairingCode) throw new Error("Pairing not supported on this node.");
                        const r = await sharing.redeemPairingCode({
                          code: jCode.trim(),
                          peerServerUrl: jUrl.trim(),
                          label: jLabel.trim() || undefined,
                        });
                        setJoined(r.fingerprint);
                        setJCode("");
                        setJUrl("");
                        setJLabel("");
                        onChanged();
                      })
                    }
                  >
                    Join peer
                  </Button>
                </div>
              </>
            )}
            <FieldError error={join.error} />
          </div>
        )}
      </div>

      {/* paired peers */}
      <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 8 }}>
        {peers.length === 0 ? (
          <p style={{ ...helpText, textAlign: "center", padding: "8px 0" }}>No peers paired yet.</p>
        ) : (
          peers.map((p) => <PeerRow key={p.pubkey} sharing={sharing} peer={p} onChanged={onChanged} />)
        )}
      </div>
    </section>
  );
}

function PeerRow({
  sharing,
  peer,
  onChanged,
}: {
  sharing: CollabSharing;
  peer: PeerInfo;
  onChanged: () => void;
}) {
  const [editUrl, setEditUrl] = useState(false);
  const [url, setUrl] = useState("");
  const urlAction = useAction();
  const remove = useAction();

  return (
    <div style={subCard}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <ShieldCheck size={18} style={{ color: "var(--color-success)", flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>
              {peer.label || peer.email || "Unnamed peer"}
            </span>
            <Badge variant="success">Paired</Badge>
          </div>
          <div style={{ ...mono, fontSize: 12, color: "var(--text-secondary)", marginTop: 3 }}>
            {peer.fingerprint}
          </div>
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
            Paired {fmtDate(peer.pairedAt ?? peer.createdAt)}
          </div>
        </div>
        <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
          <Button size="sm" variant="ghost" icon={<Link2 size={13} />} onClick={() => setEditUrl((v) => !v)}>
            Collab URL
          </Button>
          <Button
            size="sm"
            variant="ghost"
            loading={remove.busy}
            icon={<Trash2 size={13} />}
            onClick={() =>
              remove.run(async () => {
                if (!sharing.removePeer) throw new Error("Not supported.");
                await sharing.removePeer(peer.pubkey);
                onChanged();
              })
            }
          />
        </div>
      </div>

      {editUrl && (
        <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
          <p style={{ fontSize: 11, color: "var(--text-muted)" }}>
            The address the sync bridge uses to reach this peer (e.g. wss://maria.example/collab).
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <Input placeholder="Collab URL" value={url} onChange={(e) => setUrl(e.target.value)} className="flex-1" />
            <Button
              size="sm"
              variant="primary"
              loading={urlAction.busy}
              disabled={!url.trim()}
              onClick={() =>
                urlAction.run(async () => {
                  if (!sharing.setPeerUrl) throw new Error("Not supported.");
                  await sharing.setPeerUrl(peer.pubkey, url.trim());
                  setEditUrl(false);
                  setUrl("");
                  onChanged();
                })
              }
            >
              Save
            </Button>
          </div>
          <FieldError error={urlAction.error} />
        </div>
      )}
      <FieldError error={remove.error} />
    </div>
  );
}

// ── 3. Spaces (shared slices) ─────────────────────────────────────────────────
type GrantMap = Record<string, Record<string, ShareLevel>>; // spaceId → pubkey → level

function SpacesCard({
  sharing,
  vault,
  peers,
  tags,
  spaces,
  enabled,
  grants,
  setGrants,
  onChanged,
}: {
  sharing: CollabSharing;
  vault: VaultClient;
  peers: PeerInfo[];
  tags: TagCount[];
  spaces: SpaceInfo[];
  enabled: boolean;
  grants: GrantMap;
  setGrants: React.Dispatch<React.SetStateAction<GrantMap>>;
  onChanged: () => void;
}) {
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [includeTags, setIncludeTags] = useState<string[]>([]);
  const [pathPrefix, setPathPrefix] = useState("");
  const create = useAction();

  return (
    <section style={card}>
      <SectionHeader
        icon={<Share2 size={17} />}
        title="Spaces"
        hint="A space is a slice of your vault kept in two-way sync with the peers you grant."
        right={
          <Button size="sm" variant={creating ? "ghost" : "secondary"} icon={<Plus size={13} />} onClick={() => setCreating((v) => !v)}>
            New space
          </Button>
        }
      />

      {creating && (
        <div style={{ ...subCard, marginBottom: 14, display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <div style={{ ...labelText, marginBottom: 6 }}>Title</div>
            <Input placeholder="e.g. Bioregional commons" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div>
            <div style={{ ...labelText, marginBottom: 6 }}>Include tags (the slice)</div>
            <TagPicker tags={tags} selected={includeTags} onChange={setIncludeTags} />
          </div>
          <div>
            <div style={{ ...labelText, marginBottom: 6 }}>Path prefix (optional)</div>
            <Input placeholder="e.g. commons/" value={pathPrefix} onChange={(e) => setPathPrefix(e.target.value)} />
            <div style={{ ...helpText, marginTop: 5 }}>
              Narrow the slice to notes under a folder. Combine with tags, or use either alone.
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Button
              variant="primary"
              size="sm"
              loading={create.busy}
              disabled={!title.trim() && includeTags.length === 0 && !pathPrefix.trim()}
              onClick={() =>
                create.run(async () => {
                  if (!sharing.createSpace) throw new Error("Spaces not supported on this node.");
                  await sharing.createSpace({
                    title: title.trim() || undefined,
                    includeTags: includeTags.length ? includeTags : undefined,
                    pathPrefix: pathPrefix.trim() || undefined,
                  });
                  setTitle("");
                  setIncludeTags([]);
                  setPathPrefix("");
                  setCreating(false);
                  onChanged();
                })
              }
            >
              Create space
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setCreating(false)}>
              Cancel
            </Button>
          </div>
          <FieldError error={create.error} />
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {spaces.length === 0 ? (
          <p style={{ ...helpText, textAlign: "center", padding: "8px 0" }}>
            No spaces yet. Create one from a slice of your vault to share it with a peer.
          </p>
        ) : (
          spaces.map((s) => (
            <SpaceCard
              key={s.id}
              sharing={sharing}
              vault={vault}
              peers={peers}
              space={s}
              enabled={enabled}
              grants={grants[s.id] ?? {}}
              setGrants={setGrants}
              onChanged={onChanged}
            />
          ))
        )}
      </div>
    </section>
  );
}

function SpaceCard({
  sharing,
  vault,
  peers,
  space,
  enabled,
  grants,
  setGrants,
  onChanged,
}: {
  sharing: CollabSharing;
  vault: VaultClient;
  peers: PeerInfo[];
  space: SpaceInfo;
  enabled: boolean;
  grants: Record<string, ShareLevel>;
  setGrants: React.Dispatch<React.SetStateAction<GrantMap>>;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState<number | null>(null);
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());

  // peer grant form
  const [grantPeer, setGrantPeer] = useState<string>("");
  const [grantLevel, setGrantLevel] = useState<ShareLevel>("edit");
  const grantAction = useAction();
  const del = useAction();
  const addAction = useAction();

  const tag = space.includeTags?.[0];

  // Best-effort note count (no per-space membership endpoint yet — derive it).
  const loadNotes = useCallback(async () => {
    if (!tag) {
      setNotes([]);
      setCount(0);
      return;
    }
    const all = await vault.listNotes({ tag });
    const filtered = space.pathPrefix ? all.filter((n) => n.path?.startsWith(space.pathPrefix!)) : all;
    setNotes(filtered);
    setCount(filtered.length);
  }, [vault, tag, space.pathPrefix]);

  useEffect(() => {
    // count for the collapsed header (cheap-ish; cached after first load)
    loadNotes().catch(() => setCount(null));
  }, [loadNotes]);

  const peerCount = Object.keys(grants).length;
  // Status from real federation state: the space carries `lastSyncedAt` (newest
  // peer_synced_at across its notes), so once a peer has actually pulled we can
  // honestly show "Synced <ago>" instead of just a grant count.
  const status: { label: string; variant: "warning" | "info" | "success" | "default" } = !enabled
    ? { label: "Federation off", variant: "warning" }
    : space.lastSyncedAt != null
      ? { label: `Synced ${timeAgo(space.lastSyncedAt)}`, variant: "success" }
      : peerCount > 0
        ? { label: `Shared with ${peerCount} ${peerCount === 1 ? "peer" : "peers"}`, variant: "info" }
        : { label: "No peers yet", variant: "default" };

  const peerLabel = (pubkey: string) => {
    const p = peers.find((x) => x.pubkey === pubkey);
    return p?.label || p?.email || pubkey.slice(0, 8) + "…";
  };
  const ungranted = peers.filter((p) => !(p.pubkey in grants));

  return (
    <div style={subCard}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }} onClick={() => setOpen((v) => !v)}>
        <span style={{ color: "var(--text-muted)", display: "flex" }}>
          {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>
            {space.title || sliceLabel(space)}
          </div>
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
            {sliceLabel(space)}
            {count != null && ` · ${count} ${count === 1 ? "note" : "notes"}`}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          {Object.entries(grants).map(([pk, lvl]) => (
            <Badge key={pk} variant="default">
              {peerLabel(pk)} · {lvl}
            </Badge>
          ))}
          <Badge variant={status.variant}>
            <Circle size={8} fill="currentColor" /> {status.label}
          </Badge>
        </div>
      </div>

      {open && (
        <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 16 }}>
          {/* Share with a peer */}
          <div>
            <div style={{ ...labelText, marginBottom: 8 }}>Share with a peer</div>
            {peers.length === 0 ? (
              <p style={helpText}>Pair a peer first, then grant them access here.</p>
            ) : (
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <select
                  style={{ ...selectStyle, minWidth: 160 }}
                  value={grantPeer}
                  onChange={(e) => setGrantPeer(e.target.value)}
                >
                  <option value="">Choose a peer…</option>
                  {ungranted.map((p) => (
                    <option key={p.pubkey} value={p.pubkey}>
                      {p.label || p.email || p.pubkey.slice(0, 12)}
                    </option>
                  ))}
                </select>
                <LevelSelect value={grantLevel} onChange={setGrantLevel} />
                <Button
                  size="sm"
                  variant="primary"
                  loading={grantAction.busy}
                  disabled={!grantPeer}
                  icon={<Shield size={13} />}
                  onClick={() =>
                    grantAction.run(async () => {
                      if (!sharing.grantSpacePeer) throw new Error("Not supported.");
                      await sharing.grantSpacePeer(space.id, grantPeer, grantLevel);
                      // Permission is baked in at grant time. Track locally so the
                      // UI reflects it this session (no grants-readback endpoint).
                      setGrants((g) => ({ ...g, [space.id]: { ...(g[space.id] ?? {}), [grantPeer]: grantLevel } }));
                      setGrantPeer("");
                    })
                  }
                >
                  Grant
                </Button>
              </div>
            )}
            <FieldError error={grantAction.error} />

            {peerCount > 0 && (
              <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
                {Object.entries(grants).map(([pk, lvl]) => (
                  <div key={pk} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <ShieldCheck size={14} style={{ color: "var(--color-success)" }} />
                    <span style={{ fontSize: 13, color: "var(--text-primary)", flex: 1 }}>{peerLabel(pk)}</span>
                    <Badge variant="info">{lvl}</Badge>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<Trash2 size={12} />}
                      onClick={async () => {
                        try {
                          await sharing.revokeSpacePeer?.(space.id, pk);
                          setGrants((g) => {
                            const next = { ...(g[space.id] ?? {}) };
                            delete next[pk];
                            return { ...g, [space.id]: next };
                          });
                        } catch {
                          /* surfaced nowhere fatal; leave as-is */
                        }
                      }}
                    >
                      Revoke
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Add notes */}
          <div>
            <div style={{ ...labelText, marginBottom: 4 }}>Notes in this space</div>
            <p style={{ ...helpText, marginBottom: 8 }}>
              Add notes explicitly for now. Auto-membership by tag is a follow-up.
            </p>
            {!tag ? (
              <p style={helpText}>This space has no include tag — add notes by tagging the slice.</p>
            ) : notes == null ? (
              <p style={helpText}>Loading notes…</p>
            ) : notes.length === 0 ? (
              <p style={helpText}>No notes match this slice yet.</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 220, overflow: "auto" }}>
                {notes.slice(0, 100).map((n) => {
                  const isAdded = added.has(n.id);
                  return (
                    <div key={n.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span
                        style={{
                          flex: 1,
                          minWidth: 0,
                          fontSize: 13,
                          color: "var(--text-secondary)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {noteTitle(n)}
                      </span>
                      {isAdded ? (
                        <Badge variant="success">
                          <Check size={11} /> Added
                        </Badge>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          icon={<Plus size={12} />}
                          loading={addAction.busy}
                          onClick={() =>
                            addAction.run(async () => {
                              if (!sharing.addNoteToSpace) throw new Error("Not supported.");
                              await sharing.addNoteToSpace(space.id, n.id);
                              setAdded((s) => new Set(s).add(n.id));
                            })
                          }
                        >
                          Add
                        </Button>
                      )}
                    </div>
                  );
                })}
                {notes.length > 100 && (
                  <p style={{ ...helpText, marginTop: 4 }}>Showing first 100 of {notes.length}.</p>
                )}
              </div>
            )}
            <FieldError error={addAction.error} />
          </div>

          {/* Delete */}
          <div style={{ borderTop: "1px solid var(--glass-border)", paddingTop: 12 }}>
            <Button
              size="sm"
              variant="ghost"
              loading={del.busy}
              icon={<Trash2 size={13} />}
              onClick={() =>
                del.run(async () => {
                  if (!sharing.deleteSpace) throw new Error("Not supported.");
                  await sharing.deleteSpace(space.id);
                  setGrants((g) => {
                    const next = { ...g };
                    delete next[space.id];
                    return next;
                  });
                  onChanged();
                })
              }
            >
              Delete space
            </Button>
            <FieldError error={del.error} />
          </div>
        </div>
      )}
    </div>
  );
}

// ── 4. Inbox (inbound mirror requests) ────────────────────────────────────────
function InboxCard({
  sharing,
  requests,
  onChanged,
}: {
  sharing: CollabSharing;
  requests: MirrorRequestInfo[];
  onChanged: () => void;
}) {
  return (
    <section style={card}>
      <SectionHeader
        icon={<Inbox size={17} />}
        title="Inbox"
        hint="A peer never writes to your vault without your approval."
        right={requests.length > 0 ? <Badge variant="info">{requests.length} pending</Badge> : undefined}
      />
      {requests.length === 0 ? (
        <p style={{ ...helpText, textAlign: "center", padding: "8px 0" }}>No pending requests.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {requests.map((r) => (
            <MirrorRequestRow key={r.id} sharing={sharing} request={r} onChanged={onChanged} />
          ))}
        </div>
      )}
    </section>
  );
}

function MirrorRequestRow({
  sharing,
  request,
  onChanged,
}: {
  sharing: CollabSharing;
  request: MirrorRequestInfo;
  onChanged: () => void;
}) {
  const [level, setLevel] = useState<ShareLevel>("edit");
  const accept = useAction();
  const reject = useAction();
  const n = request.notes?.length ?? 0;

  return (
    <div style={subCard}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <Inbox size={18} style={{ color: "var(--accent)", flexShrink: 0, marginTop: 2 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>
            {request.spaceTitle || "Untitled space"}
          </div>
          <div style={{ ...mono, fontSize: 12, color: "var(--text-secondary)", marginTop: 3 }}>
            {request.fingerprint}
          </div>
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 3 }}>
            {n} {n === 1 ? "note" : "notes"} · requested {fmtDate(request.createdAt)}
          </div>
          {n > 0 && (
            <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 6 }}>
              {request.notes
                .slice(0, 4)
                .map((x) => x.title || x.kind)
                .join(", ")}
              {n > 4 && `, +${n - 4} more`}
            </div>
          )}
        </div>
      </div>

      <p style={{ ...helpText, margin: "10px 0" }}>
        Accepting creates a local mirror — this peer's slice appears in your vault and stays in sync.
      </p>

      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Accept at</span>
        <LevelSelect value={level} onChange={setLevel} />
        <Button
          size="sm"
          variant="primary"
          loading={accept.busy}
          icon={<Check size={13} />}
          onClick={() =>
            accept.run(async () => {
              if (!sharing.acceptMirror) throw new Error("Not supported.");
              await sharing.acceptMirror(request.id, level);
              onChanged();
            })
          }
        >
          Accept
        </Button>
        <Button
          size="sm"
          variant="ghost"
          loading={reject.busy}
          icon={<Trash2 size={13} />}
          onClick={() =>
            reject.run(async () => {
              if (!sharing.rejectMirror) throw new Error("Not supported.");
              await sharing.rejectMirror(request.id);
              onChanged();
            })
          }
        >
          Reject
        </Button>
      </div>
      <FieldError error={accept.error || reject.error} />
    </div>
  );
}

// ── orchestrator ──────────────────────────────────────────────────────────────
export function FederatePanel() {
  const sharing = useCollabSharing();
  const vault = useVaultClient();

  const [identity, setIdentity] = useState<NodeIdentity | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [peers, setPeers] = useState<PeerInfo[]>([]);
  const [spaces, setSpaces] = useState<SpaceInfo[]>([]);
  const [mirrors, setMirrors] = useState<MirrorRequestInfo[]>([]);
  const [tags, setTags] = useState<TagCount[]>([]);
  // space→peer→level. Seeded from each space's server-authoritative `peers` on
  // load (so a reload/refresh reflects real grants), with optimistic updates in
  // between for immediate feedback; `onChanged` reloads to reconcile.
  const [grants, setGrants] = useState<GrantMap>({});

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!sharing?.getNodeIdentity) return;
    setLoading(true);
    setError(null);
    try {
      const [en, id, prs, sps, mrs] = await Promise.all([
        sharing.federationEnabled ? sharing.federationEnabled() : Promise.resolve(true),
        sharing.getNodeIdentity(),
        sharing.listPeers ? sharing.listPeers() : Promise.resolve<PeerInfo[]>([]),
        sharing.listSpaces ? sharing.listSpaces() : Promise.resolve<SpaceInfo[]>([]),
        sharing.listMirrorRequests
          ? sharing.listMirrorRequests("pending")
          : Promise.resolve<MirrorRequestInfo[]>([]),
      ]);
      setEnabled(en);
      setIdentity(id);
      setPeers(prs);
      setSpaces(sps);
      setMirrors(mrs);
      // Reconcile the grant map with server truth (each space carries its peers).
      setGrants(
        Object.fromEntries(
          sps.map((s) => [s.id, Object.fromEntries((s.peers ?? []).map((p) => [p.pubkey, p.level]))]),
        ),
      );
    } catch (e) {
      setError(msg(e));
    } finally {
      setLoading(false);
    }
  }, [sharing]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    vault
      .getTags()
      .then(setTags)
      .catch(() => {});
  }, [vault]);

  // Guard AFTER hooks (hooks-above-early-returns).
  if (!sharing?.getNodeIdentity) {
    return (
      <div style={{ ...card, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
        Federation isn't available on this node.
      </div>
    );
  }

  if (loading && !identity) {
    return <div style={{ color: "var(--text-muted)", fontSize: 13, padding: 8 }}>Loading federation…</div>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} loading={loading} onClick={() => load()}>
          Refresh
        </Button>
      </div>

      {error && (
        <div style={{ ...card, borderColor: "var(--color-danger)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--color-danger)", fontSize: 13 }}>
            <AlertTriangle size={15} /> {error}
          </div>
        </div>
      )}

      {identity && <IdentityCard identity={identity} enabled={enabled} sharing={sharing} onToggled={load} />}

      {sharing.createPairingCode && identity && (
        <PeersCard sharing={sharing} identity={identity} peers={peers} onChanged={load} />
      )}

      {sharing.listSpaces && (
        <SpacesCard
          sharing={sharing}
          vault={vault}
          peers={peers}
          tags={tags}
          spaces={spaces}
          enabled={enabled}
          grants={grants}
          setGrants={setGrants}
          onChanged={load}
        />
      )}

      {sharing.listMirrorRequests && <InboxCard sharing={sharing} requests={mirrors} onChanged={load} />}
    </div>
  );
}
