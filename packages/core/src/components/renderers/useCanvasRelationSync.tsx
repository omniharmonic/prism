import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useVaultClient } from "../../data/VaultClientContext";
import { useAgentChatStore } from "../../lib/agent/chatStore";
import { canvasRelationFingerprint } from "./canvas-relations";

/** Scene changes are the durable retry input. A failed/unknown projection is
 * never called synced; the server independently reads the authoritative scene. */
export function useCanvasRelationSync(
  noteId: string | undefined,
  editable: boolean,
) {
  const client = useVaultClient();
  const audience = useAgentChatStore((s) => s.scope);
  const scope = client.scope?.() ?? audience;
  const queries = useQueryClient();
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{
    fingerprint: string;
    noteId: string;
    scope: string | null;
    state: "saved" | "error";
    retained?: boolean;
  } | null>(null);
  const observe = useCallback((elements: readonly any[]) => {
    try {
      setFingerprint(canvasRelationFingerprint(elements));
      setInvalid(false);
    } catch {
      setInvalid(true);
    }
  }, []);
  useEffect(() => {
    if (
      !editable ||
      !noteId ||
      fingerprint === null ||
      invalid ||
      !client.reconcileCanvasRelations
    )
      return;
    setResult(null);
    let active = true;
    let retries = 0;
    let timer: ReturnType<typeof setTimeout>;
    const current = () =>
      active &&
      (client.scope?.() ?? useAgentChatStore.getState().scope) === scope;
    async function run() {
      try {
        const receipt = await client.reconcileCanvasRelations!(
          noteId!,
          fingerprint!,
        );
        if (!current()) return;
        setResult({
          fingerprint: fingerprint!,
          noteId: noteId!,
          scope,
          state: "saved",
          retained: receipt.retained,
        });
        void queries.invalidateQueries({ queryKey: ["vault", "links"] });
        void queries.invalidateQueries({ queryKey: ["vault", "neighborhood"] });
      } catch (error) {
        if (!current()) return;
        if (
          error instanceof Error &&
          error.message === "canvas_scene_changed" &&
          retries++ < 2
        ) {
          timer = setTimeout(() => void run(), 1500);
          return;
        }
        setResult({
          fingerprint: fingerprint!,
          noteId: noteId!,
          scope,
          state: "error",
        });
      }
    }
    timer = setTimeout(() => void run(), 1200);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [client, noteId, editable, fingerprint, invalid, scope, attempt, queries]);
  const receipt =
    result?.fingerprint === fingerprint &&
    result.noteId === noteId &&
    result.scope === scope
      ? result
      : null;
  const unavailable = !client.reconcileCanvasRelations || !noteId;
  const status =
    !editable || (fingerprint === null && !invalid) ? null : invalid ? (
      <p role="alert" className="px-3 py-2 text-xs">
        Some arrows cannot be synced. Use short, single-line relationship labels
        and at most 250 connections.
      </p>
    ) : unavailable ? (
      fingerprint === "[]" ? null : (
        <p role="status" className="px-3 py-2 text-xs">
          Connect this canvas to Prism Server to sync its relationships.
        </p>
      )
    ) : receipt?.state === "error" ? (
      <p role="alert" className="px-3 py-2 text-xs">
        Relationships could not be updated. Check your connection and edit
        access to both notes. Your drawing is retained.{" "}
        <button
          className="focus-ring min-h-11 rounded-lg border border-[var(--glass-border)] px-3"
          onClick={() => {
            setResult(null);
            setAttempt((v) => v + 1);
          }}
        >
          Retry relationships
        </button>
      </p>
    ) : receipt?.retained ? (
      <p role="status" className="px-3 py-2 text-xs">
        Some links were kept because they may be used outside this canvas.
      </p>
    ) : fingerprint === "[]" && receipt?.state === "saved" ? null : (
      <p role="status" className="px-3 py-1 text-xs text-[var(--text-muted)]">
        {receipt?.state === "saved"
          ? "Relationships saved"
          : "Updating relationships…"}
      </p>
    );
  return { observe, status };
}
