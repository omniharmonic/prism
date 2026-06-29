// Web-shell agent MONITOR data, sourced straight from the vault (no Tauri / no
// host process). Agent skills and dispatch runs are already persisted as vault
// notes by the desktop backend, and the owner reaches them token-free through
// the Prism Server passthrough — so the browser can list/review them with zero
// new server endpoints. (Triggering a run + live status stay desktop-only.)
//
//   agent-skill notes:    vault/agent/skills/<name>      → AgentSkill
//   agent-dispatch notes: vault/agent/dispatches/<date>/ → AgentDispatch
import type { VaultClient } from "../../data/VaultClient";
import type { AgentSkill, AgentDispatch } from "../parachute/client";

type Meta = Record<string, unknown>;

/** Skills as the desktop writes them (metadata + content = the prompt). */
export async function webGetSkills(vault: VaultClient): Promise<AgentSkill[]> {
  const notes = await vault.listNotes({ tag: "agent-skill", limit: 200 });
  return notes
    .map((n): AgentSkill => {
      const m = (n.metadata ?? {}) as Meta;
      return {
        id: n.id,
        path: n.path ?? "",
        prompt: n.content ?? "",
        skillName: String(m.skillName ?? n.path?.split("/").pop() ?? n.id),
        description: String(m.description ?? ""),
        intervalSecs: Number(m.intervalSecs ?? 0),
        enabled: m.enabled === true,
        lastRun: (m.lastRun as string | undefined) ?? null,
        runAtHour: typeof m.runAtHour === "number" ? m.runAtHour : null,
        provider: (m.provider as string | undefined) ?? null,
        model: (m.model as string | undefined) ?? null,
        executionMode: String(m.executionMode ?? "agentic"),
      };
    })
    .sort((a, b) => a.skillName.localeCompare(b.skillName));
}

/** Past + in-flight dispatch runs. `note_id` is the run's report note (its
 *  content is the full output — opened on demand rather than inlined). */
export async function webGetDispatches(vault: VaultClient): Promise<AgentDispatch[]> {
  const notes = await vault.listNotes({ tag: "agent-dispatch", limit: 100 });
  const STATUSES = ["running", "completed", "failed", "cancelled"] as const;
  return notes
    .map((n): AgentDispatch => {
      const m = (n.metadata ?? {}) as Meta;
      const raw = String(m.status ?? "completed");
      const status = (STATUSES as readonly string[]).includes(raw)
        ? (raw as AgentDispatch["status"])
        : "completed";
      return {
        id: n.id,
        skill: String(m.skill ?? n.path?.split("/").pop() ?? ""),
        prompt: "",
        status,
        started_at: String(m.startedAt ?? n.createdAt ?? ""),
        completed_at: (m.completedAt as string | undefined) ?? null,
        duration_secs: m.durationSecs != null ? Number(m.durationSecs) : null,
        output: null, // the report note (note_id) holds it; opened on demand
        error: null,
        note_id: n.id,
      };
    })
    .sort((a, b) => b.started_at.localeCompare(a.started_at));
}
