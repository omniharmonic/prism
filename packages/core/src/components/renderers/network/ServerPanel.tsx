// ServerPanel — the server-owner operator surface (Network → Server). A config
// snapshot (no secret values), integration status, a narrow editable-.env
// allowlist (restart-required), and Cloudflare tunnel status + controls. The
// tunnel is a pm2 process; STOP takes the public site offline — heavily warned.
// Server/tunnel/config cards are server-owner-gated server-side; the sync-
// integrations card is admin+ and vault-scoped, so it must work even when
// /acl/server 403s (non-owner admin) — its state comes from the per-kind
// GET /api/integrations/<kind>, never the owner-only ServerInfo snapshot.
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  Server,
  Globe,
  Radio,
  RefreshCw,
  Square,
  Play,
  AlertTriangle,
  Save,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Trash2,
  Search,
  KeyRound,
  Mail,
  CalendarDays,
  MessageSquare,
  ListTodo,
  FileText,
  GitBranch,
  Plug,
} from "lucide-react";
import { Button } from "../../ui/Button";
import { Badge } from "../../ui/Badge";
import { Input } from "../../ui/Input";
import {
  useCollabSharing,
  useVaultChangeSignal,
  type CollabSharing,
  type IntegrationStatus,
  type ServerInfo,
  type TunnelIngress,
  type WorkerSourceHealth,
  type LegacyMcpToken,
} from "../../../data/CollabSharing";

import { useAgentChatStore } from "../../../lib/agent/chatStore";
import { RecoveredText } from "../../recovered/RecoveredText";
import "./server-connections.css";

const EDITABLE: { key: string; label: string; help: string }[] = [
  {
    key: "MAGIC_FROM",
    label: "Email 'from' address",
    help: "Sender for magic-link / invite emails: you@example.com or Name <you@example.com> (must be a Resend-verified domain).",
  },
  // APP_ORIGIN and RESEND_API_KEY are deliberately NOT here: they decide where and
  // through whom owner sign-in links travel, so they are host-only (server .env)
  // — see docs/credentials.md.
];

// ── Server-side sync integrations: which credential fields each kind takes.
// The row list is this registry merged with ServerInfo.integrations, so a kind
// the running server doesn't report yet (e.g. pre-restart) is still configurable.
interface IntegrationField {
  key: string;
  label: string;
  help?: string;
  secret?: boolean;
  required?: boolean;
  type?: "checkbox" | "select" | "number";
  default?: boolean;
  options?: string[];
  placeholder?: string;
  /** Rendered under a collapsed "Advanced" disclosure. */
  advanced?: boolean;
  /** Offer the Proton Bridge "Detect" button (reads the loopback cert). */
  detectCert?: boolean;
}
// Every credential here is WRITE-ONLY: the server's GET echoes configured-state
// and non-secret scope fields only, never a secret, and secret inputs are always
// blank (placeholder "configured — enter to replace"). docs/credentials.md.
const INTEGRATION_FIELDS: Record<string, IntegrationField[]> = {
  "proton-bridge": [
    {
      key: "username",
      label: "Bridge account address",
      required: true,
      help: "The address Bridge shows for the account (Bridge → account → Mailbox details). Stored on every note as the account — keep it identical to what the old script used.",
    },
    {
      key: "password",
      label: "Bridge password",
      secret: true,
      required: true,
      help: "The per-account password Bridge generates (not your Proton login). Required on every save.",
    },
    {
      key: "certSha256",
      label: "Bridge certificate SHA-256",
      required: true,
      detectCert: true,
      placeholder: "64 hex characters",
      help: "Pins Bridge's self-signed certificate — the password is only ever sent to a listener presenting exactly this certificate.",
    },
    {
      key: "host",
      label: "Host",
      advanced: true,
      placeholder: "127.0.0.1",
      help: "Loopback only (127.0.0.1, ::1 or localhost).",
    },
    {
      key: "port",
      label: "Port",
      advanced: true,
      type: "number",
      placeholder: "1143",
    },
    {
      key: "security",
      label: "Security",
      advanced: true,
      type: "select",
      options: ["starttls", "tls"],
      placeholder: "starttls",
    },
  ],
  clickup: [
    { key: "apiKey", label: "API key", secret: true, required: true },
    { key: "teamId", label: "Workspace ID", help: "blank = all workspaces" },
    { key: "spaceIds", label: "Space IDs (comma-sep)" },
    {
      key: "assignedOnly",
      label: "Only tasks assigned to me",
      type: "checkbox",
      default: true,
    },
  ],
  fireflies: [
    { key: "apiKey", label: "API key", secret: true, required: true },
  ],
  fathom: [{ key: "apiKey", label: "API key", secret: true, required: true }],
  notion: [{ key: "apiKey", label: "API key", secret: true, required: true }],
  github: [{ key: "token", label: "Token", secret: true, required: true }],
  google: [{ key: "account", label: "Account", required: true }],
  matrix: [
    { key: "homeserver", label: "Homeserver", required: true },
    { key: "accessToken", label: "Access token", secret: true, required: true },
  ],
};
const CONNECTIONS: Record<
  string,
  { name: string; description: string; icon: typeof Mail }
> = {
  "proton-bridge": {
    name: "Proton Mail Bridge",
    description: "Email from your local Bridge account",
    icon: Mail,
  },
  matrix: {
    name: "Matrix",
    description: "Messages from your homeserver",
    icon: MessageSquare,
  },
  google: {
    name: "Google",
    description: "Account used by server tools",
    icon: CalendarDays,
  },
  fireflies: {
    name: "Fireflies",
    description: "Meeting transcripts",
    icon: FileText,
  },
  fathom: {
    name: "Fathom",
    description: "Meeting transcripts",
    icon: FileText,
  },
  clickup: {
    name: "ClickUp",
    description: "Tasks from selected workspaces",
    icon: ListTodo,
  },
  notion: {
    name: "Notion",
    description: "Workspace API access",
    icon: FileText,
  },
  github: {
    name: "GitHub",
    description: "Repository API access",
    icon: GitBranch,
  },
};
const connectionName = (kind: string) => CONNECTIONS[kind]?.name ?? kind;

/** Kinds with a POST /api/integrations/<kind>/sync route. */
const SYNCABLE = new Set([
  "matrix",
  "fathom",
  "fireflies",
  "clickup",
  "proton-bridge",
]);

/** Turn a sync/detect failure into something an owner can act on. The seam's
 *  error text carries the server's `{error, detail}` (web) or status line (desktop). */
function friendlyIntegrationError(
  kind: string,
  action: "sync" | "detect" | "save",
  e: unknown,
): string {
  const msg = e instanceof Error ? e.message : String(e ?? "");
  if (
    kind === "proton-bridge" &&
    action === "sync" &&
    /\b409\b/.test(msg) &&
    /disabled|PROTON_SYNC_ENABLED/.test(msg)
  ) {
    return "Proton ingest is off on the server. The credential is stored; set PROTON_SHADOW=true (or PROTON_SYNC_ENABLED=true) in the server .env and restart it to run a pass.";
  }
  if (action === "sync" && /\b409\b/.test(msg) && /busy/.test(msg))
    return `A ${kind} pass is already running — try again when it finishes.`;
  if (action === "detect") {
    if (/\b429\b|rate_limited/.test(msg))
      return "Too many certificate checks — wait a minute and try again.";
    if (/unreachable|ECONNREFUSED/.test(msg))
      return "Nothing is listening there — is Proton Mail Bridge running on this server's machine?";
    if (/no_starttls/.test(msg))
      return "That listener didn't offer STARTTLS. If Bridge is set to SSL for IMAP, choose security “tls” under Advanced.";
    if (/timeout/.test(msg))
      return "No certificate within 10 s — check the host/port under Advanced.";
  }
  return msg || `${kind} ${action} failed.`;
}

/** One configurable integration row: badge header → expandable credential form. */
function IntegrationRow({
  kind,
  configured,
  status,
  sharing,
  onNotice,
  onError,
  onChanged,
}: {
  kind: string;
  configured: boolean | undefined;
  status?: IntegrationStatus;
  sharing: CollabSharing;
  onNotice: (msg: string) => void;
  onError: (msg: string) => void;
  onChanged: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const fieldPrefix = useId();
  const presentation = CONNECTIONS[kind];
  const Icon = presentation?.icon ?? Plug;
  const name = connectionName(kind);
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  // A fingerprint read from the live listener (Detect) is trust-on-first-use, so
  // Save stays disabled until the owner explicitly confirms it's their Bridge.
  const [detected, setDetected] = useState<{
    certSha256: string;
    subject?: string;
    issuer?: string;
    validTo?: string;
  } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const fields = INTEGRATION_FIELDS[kind] ?? [];
  const configurable = fields.length > 0 && !!sharing.setIntegrationCredential;
  const available = configured !== undefined;

  // Prefill non-secret fields from the server's status echo so a key re-save
  // doesn't silently drop teamId/spaceIds or reset a checkbox to its default.
  const openForm = () => {
    setOpen((o) => {
      if (!o) {
        const seed: Record<string, string | boolean> = {};
        for (const f of fields) {
          const v = status?.[f.key];
          // Secrets are never echoed by the server — and never prefilled even if they were.
          if (f.secret || v === undefined) continue;
          if (f.type === "checkbox") {
            if (typeof v === "boolean") seed[f.key] = v;
          } else if (typeof v === "string" || typeof v === "number")
            seed[f.key] = String(v);
        }
        setValues(seed);
        setDetected(null);
        setConfirmed(false);
      }
      return !o;
    });
  };

  const str = (key: string) => String(values[key] ?? "").trim();
  const needsConfirm =
    !!detected && str("certSha256") === detected.certSha256 && !confirmed;
  const canSave =
    available &&
    fields.filter((f) => f.required).every((f) => str(f.key)) &&
    !needsConfirm;

  const save = async () => {
    if (!sharing.setIntegrationCredential || !canSave || busy) return;
    // PUT replaces the whole credential; optional blank strings are omitted.
    const payload: Record<string, unknown> = {};
    for (const f of fields) {
      if (f.type === "checkbox")
        payload[f.key] =
          (values[f.key] as boolean | undefined) ?? f.default ?? false;
      else if (f.type === "number" && str(f.key))
        payload[f.key] = Number(str(f.key));
      else if (str(f.key)) payload[f.key] = str(f.key);
    }
    setBusy("save");
    try {
      await sharing.setIntegrationCredential(kind, payload);
      setValues({});
      setDetected(null);
      setConfirmed(false);
      setOpen(false);
      onNotice(`${name} credentials saved.`);
      await onChanged();
    } catch (e) {
      onError(
        e instanceof Error
          ? friendlyIntegrationError(kind, "save", e)
          : `Couldn't save the ${kind} credential.`,
      );
    } finally {
      setBusy(null);
    }
  };

  // Proton Bridge: read the certificate the loopback listener presents. The
  // server sends no credential while doing this (docs/credentials.md).
  const detectCert = async (key: string) => {
    if (!sharing.integrationAction || !available || busy) return;
    setBusy("detect");
    try {
      const body: Record<string, unknown> = {};
      if (str("host")) body.host = str("host");
      if (str("port")) body.port = Number(str("port"));
      if (str("security")) body.security = str("security");
      const res = (await sharing.integrationAction(
        kind,
        "detect-cert",
        body,
      )) as {
        certSha256?: unknown;
        subject?: unknown;
        issuer?: unknown;
        validTo?: unknown;
      };
      if (
        typeof res.certSha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(res.certSha256)
      )
        throw new Error("the server returned no fingerprint");
      const d = {
        certSha256: res.certSha256,
        subject: typeof res.subject === "string" ? res.subject : undefined,
        issuer: typeof res.issuer === "string" ? res.issuer : undefined,
        validTo: typeof res.validTo === "string" ? res.validTo : undefined,
      };
      setValues((s) => ({ ...s, [key]: d.certSha256 }));
      setDetected(d);
      setConfirmed(false);
    } catch (e) {
      onError(friendlyIntegrationError(kind, "detect", e));
    } finally {
      setBusy(null);
    }
  };

  const renderField = (f: IntegrationField) =>
    f.type === "checkbox" ? (
      <label
        key={f.key}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 12.5,
        }}
      >
        <input
          type="checkbox"
          disabled={busy !== null || !available}
          checked={(values[f.key] as boolean | undefined) ?? f.default ?? false}
          onChange={(e) =>
            setValues((s) => ({ ...s, [f.key]: e.target.checked }))
          }
        />
        {f.label}
      </label>
    ) : (
      <div key={f.key}>
        <label
          htmlFor={`${fieldPrefix}-${f.key}`}
          className="connection-field-label"
        >
          {f.label}
          {f.required && (
            <span style={{ color: "var(--text-secondary)", fontWeight: 400 }}>
              {" "}
              (required)
            </span>
          )}
        </label>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {f.type === "select" ? (
            <select
              id={`${fieldPrefix}-${f.key}`}
              disabled={busy !== null || !available}
              value={String(values[f.key] ?? "")}
              onChange={(e) =>
                setValues((s) => ({ ...s, [f.key]: e.target.value }))
              }
              style={{
                flex: 1,
                minWidth: 0,
                height: 32,
                borderRadius: 6,
                padding: "0 8px",
                fontSize: 13,
                background: "var(--glass)",
                border: "1px solid var(--glass-border)",
                color: "var(--text-primary)",
              }}
            >
              <option value="">
                {f.placeholder ? `default (${f.placeholder})` : "default"}
              </option>
              {(f.options ?? []).map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          ) : (
            <Input
              id={`${fieldPrefix}-${f.key}`}
              className="connection-input"
              disabled={busy !== null || !available}
              type={
                f.secret ? "password" : f.type === "number" ? "number" : "text"
              }
              autoComplete={f.secret ? "new-password" : "off"}
              spellCheck={false}
              placeholder={
                f.secret && configured
                  ? "configured — enter to replace"
                  : (f.placeholder ?? "")
              }
              value={String(values[f.key] ?? "")}
              onChange={(e) => {
                const v = e.target.value;
                setValues((s) => ({ ...s, [f.key]: v }));
                if (f.detectCert) setConfirmed(false);
              }}
              style={{ flex: 1, minWidth: 0 }}
            />
          )}
          {f.detectCert && !!sharing.integrationAction && (
            <Button
              variant="ghost"
              onClick={() => void detectCert(f.key)}
              disabled={busy !== null || !available}
              title="Read the certificate the local Bridge presents (no password is sent)"
            >
              <Search size={13} /> {busy === "detect" ? "Detecting…" : "Detect"}
            </Button>
          )}
        </div>
        {f.help && (
          <p
            style={{
              color: "var(--text-secondary)",
              fontSize: 11.5,
              margin: "3px 0 0",
            }}
          >
            {f.help}
          </p>
        )}
        {f.detectCert && detected && str(f.key) === detected.certSha256 && (
          <div
            style={{
              marginTop: 6,
              padding: "8px 10px",
              borderRadius: 6,
              border: "1px solid var(--color-warning)",
              fontSize: 11.5,
              color: "var(--text-primary)",
            }}
          >
            <div
              style={{
                display: "flex",
                gap: 6,
                alignItems: "center",
                fontWeight: 600,
                marginBottom: 4,
              }}
            >
              <AlertTriangle size={13} color="var(--color-warning)" /> Confirm
              this is your Bridge
            </div>
            <div
              style={{ color: "var(--text-secondary)", wordBreak: "break-all" }}
            >
              {detected.subject && (
                <>
                  Subject: {detected.subject}
                  <br />
                </>
              )}
              {detected.issuer && detected.issuer !== detected.subject && (
                <>
                  Issuer: {detected.issuer}
                  <br />
                </>
              )}
              {detected.validTo && (
                <>
                  Valid until: {detected.validTo}
                  <br />
                </>
              )}
              SHA-256: <code>{detected.certSha256}</code>
            </div>
            <p style={{ color: "var(--text-secondary)", margin: "6px 0" }}>
              This is whatever is listening on that port right now. Only pin it
              if Proton Mail Bridge is running there (Bridge's certificate is
              self-signed, so nothing else can vouch for it).
            </p>
            <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              I confirm this is my Proton Mail Bridge
            </label>
          </div>
        )}
      </div>
    );

  const basicFields = fields.filter((f) => !f.advanced);
  const advancedFields = fields.filter((f) => f.advanced);
  const mode = typeof status?.mode === "string" ? status.mode : null;

  const remove = async () => {
    if (!sharing.deleteIntegrationCredential || !available || busy) return;
    if (
      !window.confirm(
        `Remove the stored ${kind} credential? Sync for it stops until a new one is saved.`,
      )
    )
      return;
    setBusy("remove");
    try {
      await sharing.deleteIntegrationCredential(kind);
      setValues({});
      onNotice(`${name} credentials removed.`);
      await onChanged();
    } catch (e) {
      onError(
        e instanceof Error
          ? e.message
          : `Couldn't remove the ${kind} credential.`,
      );
    } finally {
      setBusy(null);
    }
  };

  const sync = async () => {
    if (!sharing.syncIntegration || !available || busy) return;
    setBusy("sync");
    try {
      const res = await sharing.syncIntegration(kind);
      const counts = Object.entries(res)
        .filter(([, v]) => typeof v === "number")
        .map(([k, v]) => `${v} ${k}`)
        .join(" · ");
      onNotice(`${name} sync: ${counts || "done"}.`);
    } catch (e) {
      onError(friendlyIntegrationError(kind, "sync", e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="connection-row" data-open={open || undefined}>
      <button
        className="connection-row-trigger"
        onClick={() => configurable && openForm()}
        disabled={!configurable || !available || busy !== null}
        aria-label={`${open ? "Close" : "Manage"} ${name}`}
        aria-expanded={configurable ? open : undefined}
        aria-controls={configurable ? `${fieldPrefix}-settings` : undefined}
      >
        <span className="connection-icon">
          <Icon size={22} aria-hidden="true" />
        </span>
        <span className="connection-description">
          <strong>{name}</strong>
          <span>
            {presentation?.description ?? "Server-reported integration"}
          </span>
        </span>
        <span className="connection-status">
          <span>
            {configured === undefined
              ? "Status unavailable"
              : configured
                ? "Credentials saved"
                : "Not configured"}
          </span>
          {mode && (
            <Badge
              variant={
                mode === "live"
                  ? "success"
                  : mode === "shadow"
                    ? "info"
                    : "default"
              }
            >
              {mode === "off"
                ? "Ingest off"
                : mode === "shadow"
                  ? "Shadow mode"
                  : "Live ingest"}
            </Badge>
          )}
        </span>
        {configurable && (
          <span className="connection-manage">
            {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            <span className="sr-only">Manage</span>
          </span>
        )}
      </button>
      {open && configurable && (
        <div
          id={`${fieldPrefix}-settings`}
          className="connection-configuration"
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 8,
              marginTop: 8,
            }}
          >
            {basicFields.map(renderField)}
            {advancedFields.length > 0 && (
              <>
                <button
                  aria-expanded={showAdvanced}
                  onClick={() => setShowAdvanced((v) => !v)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                    background: "none",
                    border: "none",
                    padding: 0,
                    cursor: "pointer",
                    color: "var(--text-secondary)",
                    fontSize: 12,
                  }}
                >
                  {showAdvanced ? (
                    <ChevronDown size={12} />
                  ) : (
                    <ChevronRight size={12} />
                  )}{" "}
                  Advanced
                </button>
                {showAdvanced && advancedFields.map(renderField)}
              </>
            )}
          </div>
          <div className="connection-actions">
            <Button
              onClick={() => void save()}
              disabled={!canSave || busy !== null}
            >
              <Save size={13} />{" "}
              {busy === "save" ? "Saving…" : "Save credentials"}
            </Button>
            {configured && SYNCABLE.has(kind) && !!sharing.syncIntegration && (
              <Button
                variant="ghost"
                onClick={() => void sync()}
                disabled={busy !== null || !available}
              >
                <RefreshCw size={13} />{" "}
                {busy === "sync" ? "Syncing…" : "Sync now"}
              </Button>
            )}
            {configured && !!sharing.deleteIntegrationCredential && (
              <Button
                variant="ghost"
                onClick={() => void remove()}
                disabled={busy !== null || !available}
              >
                <Trash2 size={13} /> Remove
              </Button>
            )}
          </div>
          <p
            style={{
              color: "var(--text-secondary)",
              fontSize: 11.5,
              margin: "8px 0 0",
            }}
          >
            Saving replaces all settings for this connection. Stored secrets are
            never shown; re-enter them when saving. Saving credentials does not
            confirm that content has synced.
          </p>
        </div>
      )}
    </div>
  );
}

function ago(iso: string | null): string {
  if (!iso) return "Not reported";
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return "Unknown";
  const m = Math.max(0, Math.round((Date.now() - timestamp) / 60_000));
  if (m < 1) return "just now";
  if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

const sharingIdentities = new WeakMap<CollabSharing, number>();
let nextSharingIdentity = 1;
function sharingIdentity(sharing: CollabSharing | null) {
  if (!sharing) return 0;
  let identity = sharingIdentities.get(sharing);
  if (identity === undefined) {
    identity = nextSharingIdentity++;
    sharingIdentities.set(sharing, identity);
  }
  return identity;
}

export function ServerPanel() {
  const sharing = useCollabSharing();
  const vaultSignal = useVaultChangeSignal();
  const audience = useAgentChatStore((s) => s.scope);
  const identity = sharingIdentity(sharing);
  return (
    <ScopedServerPanel
      key={JSON.stringify([
        identity,
        audience,
        vaultSignal,
        sharing?.getActiveVault?.(),
      ])}
      sharing={sharing}
    />
  );
}

function ScopedServerPanel({ sharing }: { sharing: CollabSharing | null }) {
  const initialVault = useRef(sharing?.getActiveVault?.());
  const alive = useRef(true);
  const refreshVersion = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const current = useCallback(
    () => alive.current && sharing?.getActiveVault?.() === initialVault.current,
    [sharing],
  );
  const [section, setSection] = useState("accounts");
  const [loading, setLoading] = useState(true);
  const panelId = useId();
  const [info, setInfo] = useState<ServerInfo | null>(null);
  // Per-kind, vault-scoped configured-state (GET /api/integrations/<kind>) —
  // the same scope setIntegrationCredential's PUT writes to, and readable by a
  // non-owner admin. null = not loaded / seam absent.
  const [integrationStatus, setIntegrationStatus] = useState<Record<
    string,
    IntegrationStatus
  > | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  // Write-only vault-token rotation (owner-added vaults only).
  const [rotating, setRotating] = useState<string | null>(null);
  const [newToken, setNewToken] = useState("");
  const [ingress, setIngress] = useState<TunnelIngress | null>(null);
  const [workers, setWorkers] = useState<WorkerSourceHealth[] | null>(null);
  // Legacy whole-vault member MCP tokens (WP6.5): null = seam absent / not the owner.
  const [legacy, setLegacy] = useState<LegacyMcpToken[] | null>(null);
  const refresh = useCallback(async () => {
    if (!sharing?.getServerInfo && !sharing?.getIntegrationStatus) return;
    const version = ++refreshVersion.current;
    const valid = () => current() && version === refreshVersion.current;
    if (!valid()) return;
    setLoading(true);
    setError(null);
    let infoError: string | null = null;
    let nextInfo: ServerInfo | null = null;
    let nextIngress: TunnelIngress | null = null;
    let nextLegacy: LegacyMcpToken[] | null = null;
    let nextWorkers: WorkerSourceHealth[] | null = null;
    if (sharing.getServerInfo) {
      try {
        nextInfo = await sharing.getServerInfo();
        if (!valid()) return;
        [nextIngress, nextLegacy, nextWorkers] = await Promise.all([
          sharing.getTunnelIngress?.().catch(() => null) ?? null,
          sharing
            .getLegacyMcpTokens?.()
            .then((r) => r.tokens)
            .catch(() => null) ?? null,
          sharing
            .getWorkerHealth?.()
            .then((r) => r.sources)
            .catch(() => null) ?? null,
        ]);
      } catch (e) {
        infoError =
          e instanceof Error ? e.message : "Couldn't load server settings.";
      }
    }
    let statuses: Record<string, IntegrationStatus> | null = null;
    if (sharing.getIntegrationStatus) {
      const rows = await Promise.all(
        Object.keys(INTEGRATION_FIELDS).map(async (kind) => {
          try {
            return [kind, await sharing.getIntegrationStatus!(kind)] as const;
          } catch {
            return null;
          }
        }),
      );
      statuses = Object.fromEntries(
        rows.filter(
          (row): row is readonly [string, IntegrationStatus] => row !== null,
        ),
      );
    }
    if (!valid()) return;
    setInfo(nextInfo);
    setIngress(nextIngress);
    setLegacy(nextLegacy);
    setWorkers(nextWorkers);
    setIntegrationStatus(statuses);
    setLoading(false);
    if (infoError && !Object.keys(statuses ?? {}).length) setError(infoError);
  }, [sharing, current]);

  const revokeLegacy = useCallback(
    async (opts: { jtis?: string[]; notify: boolean }) => {
      if (!sharing?.revokeLegacyMcpTokens || !current()) return;
      setBusy("legacy");
      setError(null);
      try {
        const dry = await sharing.revokeLegacyMcpTokens({
          ...opts,
          dryRun: true,
        });
        if (!current()) return;
        const who =
          (dry.affected ?? [])
            .map((a) => `${a.email} (${a.tokens.length})`)
            .join(", ") || "nobody";
        if (!dry.wouldRevoke) {
          setNotice("No active legacy tokens.");
          return;
        }
        const msg =
          `Revoke ${dry.wouldRevoke} token(s) for: ${who}?` +
          (opts.notify ? "\n\nEach affected member will be emailed." : "") +
          "\n\nThe hub enforces revocation within about a minute. This cannot be undone.";
        if (!window.confirm(msg)) return;
        const res = await sharing.revokeLegacyMcpTokens({
          ...opts,
          dryRun: false,
        });
        setNotice(
          `Revoked ${res.revoked?.length ?? 0}${res.failed?.length ? `, ${res.failed.length} failed` : ""}${opts.notify ? `; notified ${res.notified?.length ?? 0} member(s)` : ""}.`,
        );
        setLegacy(
          (await sharing.getLegacyMcpTokens?.().catch(() => null))?.tokens ??
            null,
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn't revoke tokens.");
      } finally {
        setBusy(null);
      }
    },
    [sharing],
  );

  const applyIngress = useCallback(async () => {
    if (!sharing?.applyTunnelIngress || !current()) return;
    if (
      !window.confirm(
        "Add ingress rules for your workspace subdomains and restart the tunnel? (It rolls back automatically if the tunnel doesn't come back online.)",
      )
    )
      return;
    setBusy("ingress");
    setError(null);
    try {
      const res = await sharing.applyTunnelIngress();
      setNotice(
        res.added.length
          ? `Routed: ${res.added.join(", ")}.`
          : "All subdomains already routed.",
      );
      await refresh();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Couldn't update tunnel ingress.",
      );
    } finally {
      setBusy(null);
    }
  }, [sharing, refresh, current]);

  const rotateToken = useCallback(
    async (vaultId: string, vaultName: string) => {
      if (!sharing?.setVaultToken || !current()) return;
      setBusy(`token:${vaultId}`);
      setError(null);
      try {
        await sharing.setVaultToken(vaultId, newToken.trim());
        setNewToken("");
        setRotating(null);
        setNotice(
          `Token for ${vaultName} replaced (checked against the vault first).`,
        );
        await refresh();
      } catch (e) {
        setError(
          e instanceof Error ? e.message : "Couldn't replace the token.",
        );
      } finally {
        setBusy(null);
      }
    },
    [sharing, newToken, refresh, current],
  );

  // Re-read on vault switch too: the integration scope follows the active vault.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const saveConfig = useCallback(
    async (key: string) => {
      if (!sharing?.setServerConfig || !current()) return;
      const value = edits[key];
      if (value === undefined) return;
      setBusy(key);
      setError(null);
      try {
        const res = await sharing.setServerConfig(key, value);
        setNotice(
          res.restartRequired
            ? `${key} saved — restart the server for it to take effect.`
            : `${key} saved.`,
        );
        setEdits((e) => {
          const { [key]: _drop, ...rest } = e;
          return rest;
        });
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : `Couldn't save ${key}.`);
      } finally {
        setBusy(null);
      }
    },
    [sharing, edits, refresh, current],
  );

  const tunnel = useCallback(
    async (action: "start" | "stop" | "restart") => {
      if (!sharing?.controlTunnel || !current()) return;
      if (
        action === "stop" &&
        !window.confirm(
          "Stopping the tunnel takes the PUBLIC site offline. If you're viewing this over the tunnel, you'll lose your connection. Continue?",
        )
      )
        return;
      setBusy(`tunnel:${action}`);
      setError(null);
      try {
        const res = await sharing.controlTunnel(action);
        setInfo((prev) => (prev ? { ...prev, tunnel: res.tunnel } : prev));
        setNotice(`Tunnel ${action} requested.`);
      } catch (e) {
        setError(
          e instanceof Error ? e.message : `Couldn't ${action} the tunnel.`,
        );
      } finally {
        setBusy(null);
      }
    },
    [sharing, current],
  );

  if (!sharing?.getServerInfo && !sharing?.getIntegrationStatus) {
    return (
      <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>
        Server settings aren't available here (server owner only).
      </p>
    );
  }

  const labelStyle = {
    fontSize: 12,
    fontWeight: 600,
    color: "var(--text-secondary)",
    marginBottom: 6,
  } as const;
  const cardStyle = {
    border: "1px solid var(--glass-border)",
    borderRadius: 12,
    padding: 20,
    marginBottom: 20,
    background: "var(--bg-surface)",
  } as const;
  const rowStyle = {
    display: "flex",
    justifyContent: "space-between",
    gap: 12,
    padding: "5px 0",
    fontSize: 13,
    borderBottom: "1px solid var(--glass-border)",
  } as const;

  const t = info?.tunnel;
  const tunnelOnline = t?.status === "online";

  return (
    <div className="prism-connections">
      {error && (
        <div role="alert" className="connections-error">
          {error}
        </div>
      )}
      {notice && (
        <div
          role="status"
          style={{
            ...cardStyle,
            display: "flex",
            gap: 8,
            alignItems: "center",
            color: "var(--text-primary)",
            fontSize: 13,
          }}
        >
          <CheckCircle2 size={14} /> {notice}
        </div>
      )}

      <header className="connections-header">
        <div>
          <h2>Connections</h2>
          <p>Bring your accounts and their context into this vault.</p>
        </div>
        <Button
          onClick={() => void refresh()}
          disabled={loading}
          aria-label="Refresh connections"
        >
          <RefreshCw size={16} /> {loading ? "Refreshing…" : "Refresh"}
        </Button>
      </header>
      <div
        className="connections-tabs"
        role="tablist"
        aria-label="Connection settings"
      >
        {[
          { id: "accounts", label: "Accounts" },
          ...(info
            ? [
                { id: "processing", label: "Processing" },
                { id: "server", label: "Server operations" },
              ]
            : []),
        ].map((tab) => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={(info ? section : "accounts") === tab.id}
            tabIndex={(info ? section : "accounts") === tab.id ? 0 : -1}
            onKeyDown={(event) => {
              if (
                !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
              )
                return;
              const buttons = Array.from(
                event.currentTarget.parentElement!.querySelectorAll<HTMLButtonElement>(
                  '[role="tab"]',
                ),
              );
              const index = buttons.indexOf(event.currentTarget);
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? buttons.length - 1
                    : (index +
                        (event.key === "ArrowRight" ? 1 : -1) +
                        buttons.length) %
                      buttons.length;
              event.preventDefault();
              buttons[next].focus();
              buttons[next].click();
            }}
            aria-controls={`${panelId}-${tab.id}`}
            id={`${panelId}-tab-${tab.id}`}
            onClick={() => setSection(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {loading && (
        <p role="status" className="connections-help">
          Checking connection settings…
        </p>
      )}
      <section
        role="tabpanel"
        aria-labelledby={`${panelId}-tab-accounts`}
        id={`${panelId}-accounts`}
        hidden={!!info && section !== "accounts"}
      >
        {/* Integrations — known kinds merged with what the server reports, so a
          kind the running server predates (e.g. clickup) is still configurable.
          Configured-state prefers the per-kind vault-scoped status (matches
          where Save writes, and works for non-owner admins); the owner-only
          ServerInfo snapshot (primary vault) is only a fallback. */}
        {(integrationStatus || info || loading) && (
          <div className="connections-card" style={cardStyle}>
            <h3 className="connections-section-title">Accounts</h3>
            <p className="connections-help">
              Credentials and source settings for{" "}
              <strong>{sharing.getActiveVault?.() ?? "primary"}</strong>. Saved
              credentials do not confirm a successful sync.
            </p>
            {[
              ...new Set([
                ...Object.keys(INTEGRATION_FIELDS),
                ...Object.keys(info?.integrations ?? {}),
              ]),
            ].map((k) => (
              <IntegrationRow
                key={k}
                kind={k}
                configured={
                  loading
                    ? undefined
                    : integrationStatus
                      ? integrationStatus[k]?.configured
                      : !!info?.integrations[k]
                }
                status={integrationStatus?.[k]}
                sharing={sharing}
                onNotice={(m) => {
                  setError(null);
                  setNotice(m);
                }}
                onError={(m) => {
                  setNotice(null);
                  setError(m);
                }}
                onChanged={refresh}
              />
            ))}
            {(integrationStatus
              ? Object.values(integrationStatus).some(
                  (s) => !s.secretsAvailable,
                )
              : info && !info.secretsAvailable) && (
              <p
                style={{
                  color: "var(--text-primary)",
                  fontSize: 12,
                  marginTop: 8,
                }}
              >
                SECRETS_KEY is not set — server-side sync is disabled.
              </p>
            )}
          </div>
        )}
      </section>
      {info && (
        <section
          role="tabpanel"
          aria-labelledby={`${panelId}-tab-processing`}
          id={`${panelId}-processing`}
          hidden={section !== "processing"}
        >
          {/* Ingest health — server workers + desktop-owned sources (email, calendar,
          skills), the latter inferred from the newest vault note of each kind. */}
          {workers && (
            <div className="connections-card" style={cardStyle}>
              <h3 className="connections-section-title">Processing</h3>
              <p className="connections-help">
                Reported background activity. Desktop source activity is
                inferred from the newest vault note, not a live connection test.
              </p>
              {workers
                .filter((w) => w.status !== "disabled")
                .map((w, i, arr) => (
                  <div
                    key={`${w.vaultId}:${w.name}`}
                    style={{
                      ...rowStyle,
                      flexDirection: "column",
                      gap: 2,
                      borderBottom:
                        i === arr.length - 1 ? "none" : rowStyle.borderBottom,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        gap: 12,
                      }}
                    >
                      <span>
                        {w.name}{" "}
                        <span
                          style={{ color: "var(--text-muted)", fontSize: 11 }}
                        >
                          ({w.kind})
                        </span>
                      </span>
                      <span
                        style={{
                          display: "flex",
                          gap: 8,
                          alignItems: "center",
                        }}
                      >
                        <span
                          style={{ color: "var(--text-muted)", fontSize: 12 }}
                        >
                          {ago(w.lastSuccessAt)}
                        </span>
                        <Badge
                          variant={
                            w.status === "ok"
                              ? "success"
                              : w.status === "stale"
                                ? "warning"
                                : "error"
                          }
                        >
                          {w.status}
                        </Badge>
                      </span>
                    </div>
                    {w.lastError && w.failureStreak > 0 && (
                      <span
                        style={{ color: "var(--text-primary)", fontSize: 12 }}
                      >
                        {w.failureStreak} failure(s) in a row: {w.lastError}
                      </span>
                    )}
                  </div>
                ))}
              {workers.every((w) => w.status === "disabled") && (
                <p
                  style={{
                    color: "var(--text-secondary)",
                    fontSize: 12,
                    margin: 0,
                  }}
                >
                  {workers.length
                    ? "All reported sources are disabled."
                    : "No processing sources were reported."}
                </p>
              )}
            </div>
          )}

          {!workers && (
            <p className="connections-help">
              Processing status is unavailable. Refresh to check again.
            </p>
          )}
        </section>
      )}
      {info && (
        <section
          role="tabpanel"
          aria-labelledby={`${panelId}-tab-server`}
          id={`${panelId}-server`}
          hidden={section !== "server"}
        >
          <p className="connections-help">
            Server-owner controls. These affect the host and may affect everyone
            using Prism.
          </p>
          {/* Overview */}
          <div className="connections-card" style={cardStyle}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginBottom: 12,
              }}
            >
              <Server size={16} />
              <h2 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>
                Server
              </h2>
              <button
                onClick={() => void refresh()}
                title="Refresh"
                style={{
                  marginLeft: "auto",
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  color: "var(--text-secondary)",
                }}
              >
                <RefreshCw size={14} />
              </button>
            </div>
            {info && (
              <div>
                <div style={rowStyle}>
                  <span style={{ color: "var(--text-secondary)" }}>Owner</span>
                  <span>{info.ownerEmail}</span>
                </div>
                <div style={rowStyle}>
                  <span style={{ color: "var(--text-secondary)" }}>
                    App origin
                  </span>
                  <span>{info.appOrigin}</span>
                </div>
                <div style={rowStyle}>
                  <span style={{ color: "var(--text-secondary)" }}>
                    Parachute
                  </span>
                  <span>
                    {info.parachuteUrl} · {info.parachuteVault}
                  </span>
                </div>
                <div style={rowStyle}>
                  <span style={{ color: "var(--text-secondary)" }}>Vaults</span>
                  <span>{info.vaultCount}</span>
                </div>
                <div style={rowStyle}>
                  <span style={{ color: "var(--text-secondary)" }}>
                    Federation
                  </span>
                  <span>
                    {info.federationEnabled ? (
                      <Badge variant="success">on</Badge>
                    ) : (
                      <Badge>off</Badge>
                    )}
                  </span>
                </div>
                <div style={rowStyle}>
                  <span style={{ color: "var(--text-secondary)" }}>
                    Local-owner trust
                  </span>
                  <span>
                    {info.trustLocal ? (
                      <Badge variant="info">on</Badge>
                    ) : (
                      <Badge>off</Badge>
                    )}
                  </span>
                </div>
                <div style={{ ...rowStyle, borderBottom: "none" }}>
                  <span style={{ color: "var(--text-secondary)" }}>
                    Email delivery
                  </span>
                  <span>
                    {info.emailConfigured ? (
                      <Badge variant="success">Resend</Badge>
                    ) : (
                      <Badge variant="warning">console only</Badge>
                    )}
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* What a page held when a newer copy replaced typing that was not saved, and pages
          that cannot be saved. Renders nothing unless the viewer is the server owner. */}
          <RecoveredText />

          {/* Legacy whole-vault member MCP tokens (WP6.5) — superseded by Prism access
          tokens ("Connect your agent"). Owner reviews, then revokes (optionally
          emailing each member). Never lists token material. */}
          {legacy && legacy.length > 0 && (
            <div className="connections-card" style={cardStyle}>
              <div style={labelStyle}>Legacy agent tokens (whole-vault)</div>
              <p
                style={{
                  color: "var(--text-secondary)",
                  fontSize: 12,
                  margin: "0 0 8px",
                }}
              >
                These bypass Prism permissions. Members should switch to
                Settings → Account → Connect your agent.
              </p>
              {legacy.map((t, i) => (
                <div
                  key={t.jti}
                  style={{
                    ...rowStyle,
                    flexWrap: "wrap",
                    borderBottom:
                      i === legacy.length - 1 ? "none" : rowStyle.borderBottom,
                  }}
                >
                  <span>
                    {t.email}{" "}
                    <span style={{ color: "var(--text-muted)", fontSize: 11 }}>
                      · {t.vaultLabel} · {t.scope}
                    </span>
                  </span>
                  <span
                    style={{ display: "flex", gap: 8, alignItems: "center" }}
                  >
                    <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
                      created {new Date(t.createdAt).toLocaleDateString()} ·
                      expires {new Date(t.expiresAt).toLocaleDateString()}
                    </span>
                    <Button
                      variant="ghost"
                      disabled={busy === "legacy"}
                      onClick={() =>
                        void revokeLegacy({ jtis: [t.jti], notify: false })
                      }
                    >
                      Revoke
                    </Button>
                  </span>
                </div>
              ))}
              <div style={{ marginTop: 10 }}>
                <Button
                  disabled={busy === "legacy"}
                  onClick={() => void revokeLegacy({ notify: true })}
                >
                  Revoke all + notify
                </Button>
              </div>
            </div>
          )}

          {/* Vault tokens — hub JWTs with no auto-renewal: an expired one silently
          breaks every sync into that vault, so surface it before it lapses. */}
          {info?.tokens && info.tokens.length > 0 && (
            <div className="connections-card" style={cardStyle}>
              <div style={labelStyle}>Vault access tokens</div>
              {info.tokens.map((tk, i) => (
                <div
                  key={tk.id}
                  style={{
                    ...rowStyle,
                    flexWrap: "wrap",
                    borderBottom:
                      i === info.tokens!.length - 1
                        ? "none"
                        : rowStyle.borderBottom,
                  }}
                >
                  <span style={{ color: "var(--text-secondary)" }}>
                    {tk.vault}
                  </span>
                  <span
                    style={{ display: "flex", gap: 8, alignItems: "center" }}
                  >
                    {tk.rotatable && !!sharing.setVaultToken && (
                      <button
                        onClick={() =>
                          setRotating((r) => (r === tk.id ? null : tk.id))
                        }
                        title="Replace this vault's token (write-only)"
                        style={{
                          background: "none",
                          border: "none",
                          cursor: "pointer",
                          color: "var(--text-secondary)",
                          display: "inline-flex",
                        }}
                      >
                        <KeyRound size={13} />
                      </button>
                    )}
                    {tk.expiresAt && (
                      <span
                        style={{ color: "var(--text-muted)", fontSize: 12 }}
                      >
                        {new Date(tk.expiresAt).toLocaleDateString()}
                      </span>
                    )}
                    {tk.status === "expired" ? (
                      <Badge variant="error">expired</Badge>
                    ) : tk.status === "expiring" ? (
                      <Badge variant="warning">{tk.daysLeft} days left</Badge>
                    ) : tk.status === "ok" ? (
                      <Badge variant="success">valid</Badge>
                    ) : (
                      <Badge>unknown</Badge>
                    )}
                  </span>
                  {rotating === tk.id && (
                    <div
                      style={{
                        display: "flex",
                        gap: 8,
                        width: "100%",
                        marginTop: 6,
                      }}
                    >
                      <Input
                        className="connection-input"
                        aria-label={`New access token for ${tk.vault}`}
                        type="password"
                        autoComplete="new-password"
                        spellCheck={false}
                        placeholder="new token — never shown again"
                        value={newToken}
                        onChange={(e) => setNewToken(e.target.value)}
                        style={{ flex: 1, minWidth: 0 }}
                      />
                      <Button
                        onClick={() => void rotateToken(tk.id, tk.vault)}
                        disabled={!newToken.trim() || busy === `token:${tk.id}`}
                      >
                        <Save size={13} />{" "}
                        {busy === `token:${tk.id}` ? "Checking…" : "Replace"}
                      </Button>
                    </div>
                  )}
                </div>
              ))}
              {info.tokens.some(
                (tk) => tk.status === "expired" || tk.status === "expiring",
              ) && (
                <p
                  style={{
                    color: "var(--text-secondary)",
                    fontSize: 12,
                    marginTop: 8,
                  }}
                >
                  Re-mint with{" "}
                  <code>
                    parachute auth mint-token --scope vault:&lt;name&gt;:write
                  </code>
                  , then replace it here (key icon — vaults added in the app) or
                  in the server <code>.env</code> (env-configured vaults) and
                  restart.
                </p>
              )}
            </div>
          )}

          {/* Cloudflare tunnel */}
          <div className="connections-card" style={cardStyle}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginBottom: 10,
              }}
            >
              <Radio size={15} />
              <h2 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>
                Cloudflare tunnel
              </h2>
              {t &&
                (tunnelOnline ? (
                  <Badge variant="success">online</Badge>
                ) : (
                  <Badge variant={t.managed ? "warning" : "default"}>
                    {t.status ?? (t.managed ? "stopped" : "unmanaged")}
                  </Badge>
                ))}
            </div>
            {t?.hostname && (
              <div style={{ fontSize: 13, marginBottom: 4 }}>
                <Globe
                  size={12}
                  style={{ marginRight: 6, verticalAlign: "middle" }}
                />
                <a
                  href={`https://${t.hostname}`}
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: "var(--accent)" }}
                >
                  {t.hostname}
                </a>
              </div>
            )}
            {t && !t.managed && (
              <p
                style={{
                  color: "var(--text-secondary)",
                  fontSize: 12,
                  margin: "4px 0",
                }}
              >
                {t.detail ?? "Tunnel not managed by pm2 on this host."}
              </p>
            )}
            {t?.managed && (
              <>
                <p
                  style={{
                    color: "var(--text-secondary)",
                    fontSize: 12,
                    margin: "4px 0 10px",
                  }}
                >
                  Process <code>{t.name}</code> · restarts: {t.restarts ?? 0}
                </p>
                <div style={{ display: "flex", gap: 8 }}>
                  <Button
                    onClick={() => void tunnel("restart")}
                    disabled={busy === "tunnel:restart"}
                  >
                    <RefreshCw size={13} /> Restart
                  </Button>
                  {tunnelOnline ? (
                    <Button
                      variant="ghost"
                      onClick={() => void tunnel("stop")}
                      disabled={busy === "tunnel:stop"}
                    >
                      <Square size={13} /> Stop
                    </Button>
                  ) : (
                    <Button
                      onClick={() => void tunnel("start")}
                      disabled={busy === "tunnel:start"}
                    >
                      <Play size={13} /> Start
                    </Button>
                  )}
                </div>
                <p
                  style={{
                    display: "flex",
                    gap: 6,
                    alignItems: "center",
                    color: "var(--text-primary)",
                    fontSize: 11.5,
                    margin: "10px 0 0",
                  }}
                >
                  <AlertTriangle size={13} /> Stopping the tunnel takes the
                  public site offline for everyone.
                </p>
              </>
            )}
          </div>

          {/* Workspace subdomain routing (ingress) */}
          {ingress && (
            <div className="connections-card" style={cardStyle}>
              <div style={labelStyle}>Workspace subdomains</div>
              {ingress.missing.length === 0 ? (
                <p
                  style={{
                    color: "var(--text-secondary)",
                    fontSize: 12,
                    margin: 0,
                  }}
                >
                  Every workspace subdomain is routed through the tunnel. Set a
                  subdomain on a workspace (Network → Workspaces) to serve it
                  here.
                </p>
              ) : (
                <>
                  <p
                    style={{
                      color: "var(--text-secondary)",
                      fontSize: 12,
                      margin: "0 0 10px",
                    }}
                  >
                    These workspace subdomains need routing:{" "}
                    <strong>{ingress.missing.join(", ")}</strong>. Two steps —
                    (1) create the DNS route (run per hostname), then (2) add
                    the ingress rule + restart the tunnel.
                  </p>
                  {ingress.routeDnsCommands.length > 0 && (
                    <div style={{ marginBottom: 10 }}>
                      <div
                        style={{
                          fontSize: 11.5,
                          color: "var(--text-muted)",
                          marginBottom: 4,
                        }}
                      >
                        1. DNS route (run in your terminal):
                      </div>
                      <pre
                        style={{
                          fontSize: 11.5,
                          background: "var(--glass-active)",
                          borderRadius: 6,
                          padding: "8px 10px",
                          overflowX: "auto",
                          margin: 0,
                        }}
                      >
                        {ingress.routeDnsCommands.join("\n")}
                      </pre>
                    </div>
                  )}
                  <Button
                    onClick={() => void applyIngress()}
                    disabled={busy === "ingress"}
                  >
                    <Radio size={13} /> 2. Add ingress rules &amp; restart
                    tunnel
                  </Button>
                  <p
                    style={{
                      display: "flex",
                      gap: 6,
                      alignItems: "center",
                      color: "var(--text-primary)",
                      fontSize: 11.5,
                      margin: "10px 0 0",
                    }}
                  >
                    <AlertTriangle size={13} /> Restarts the tunnel (brief
                    blip). Auto-rolls-back if it doesn't come back online.
                  </p>
                </>
              )}
            </div>
          )}

          {/* Editable config (restart-required) */}
          <div className="connections-card" style={cardStyle}>
            <div style={labelStyle}>App settings</div>
            <p
              style={{
                color: "var(--text-secondary)",
                fontSize: 12,
                margin: "0 0 12px",
              }}
            >
              These write to the server's <code>.env</code> (backed up first)
              and take effect after a restart. Host secrets
              (session/capability/secrets keys, vault and collab tokens, the
              Resend key), the public origin and the owner email aren't editable
              from a browser: changing them here would let a stolen session take
              over the server's root of trust or redirect owner sign-in links.
              Set them in the server <code>.env</code>. Public origin:{" "}
              {info?.appOrigin ?? "—"}. Email delivery:{" "}
              {info?.emailConfigured
                ? "Resend configured"
                : "console only (RESEND_API_KEY unset)"}
              .
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {EDITABLE.map((f) => {
                const current = f.key === "MAGIC_FROM" ? info?.magicFrom : "";
                const dirty = edits[f.key] !== undefined;
                return (
                  <div key={f.key}>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        marginBottom: 4,
                      }}
                    >
                      <span style={{ fontSize: 12.5, fontWeight: 600 }}>
                        {f.label}
                      </span>
                    </div>
                    <div
                      style={{ display: "flex", gap: 8, alignItems: "center" }}
                    >
                      <Input
                        className="connection-input"
                        aria-label={f.label}
                        type="text"
                        placeholder={current ?? ""}
                        value={edits[f.key] ?? current ?? ""}
                        onChange={(e) =>
                          setEdits((s) => ({ ...s, [f.key]: e.target.value }))
                        }
                        style={{ flex: 1 }}
                      />
                      <Button
                        onClick={() => void saveConfig(f.key)}
                        disabled={!dirty || busy === f.key}
                      >
                        <Save size={13} /> Save
                      </Button>
                    </div>
                    <p
                      style={{
                        color: "var(--text-secondary)",
                        fontSize: 11.5,
                        margin: "4px 0 0",
                      }}
                    >
                      {f.help}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
