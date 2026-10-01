/**
 * React glue between an AgentClient and the pure conversation reducer (WP3.2).
 *
 * Reconnect contract:
 *  1. load = `getSession` → `seedConversation` (finished turns from the summary;
 *     the in-flight turn reset to its prompt) → if a turn is in flight, open the
 *     stream from its `firstSeq - 1` so it is rebuilt exactly;
 *  2. every persisted event advances `lastSeq`; a drop reconnects with
 *     `Last-Event-ID` = the last persisted seq (streamSSE) and the reducer drops
 *     any duplicate seq;
 *  3. the stream ends by itself when the turn reaches a terminal status;
 *  4. returning to the tab (visibilitychange) or a 409 "turn already running"
 *     re-runs step 1 — i.e. attaches to whatever is running.
 */
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { agentKeys } from "../../data/AgentClientContext";
import { AgentApiError, isTerminalTurn, type AgentClient, type AgentContextRecord, type AgentSession, type AgentStreamMessage } from "./sessions";
import {
  activeTurn,
  addPendingTurn,
  applyAgentMessage,
  emptyConversation,
  seedConversation,
  type ConversationState,
} from "./sessionReducer";

type Action =
  | { type: "reset"; state: ConversationState }
  | { type: "msg"; msg: AgentStreamMessage }
  | { type: "pending"; id: string; prompt: string; noteId?: string | null; context?: AgentContextRecord[] };

function reducer(s: ConversationState, a: Action): ConversationState {
  switch (a.type) {
    case "reset":
      return a.state;
    case "msg":
      return applyAgentMessage(s, a.msg);
    case "pending":
      return addPendingTurn(s, { id: a.id, prompt: a.prompt, noteId: a.noteId, context: a.context });
  }
}

export type ConnectionState = "idle" | "connecting" | "live" | "reconnecting";

/** Friendly copy for API failures. */
export function agentErrorText(e: unknown): string {
  if (e instanceof AgentApiError) {
    if (e.code === "budget_exceeded") return "This session reached its spending cap. Start a new session to keep going.";
    if (e.code === "daily_budget_exceeded") return "You've reached today's agent budget. It resets at midnight.";
    if (e.code === "profile_unavailable") return "That agent profile is turned off on the server. Start a new session with another profile.";
    if (e.code === "busy") return "The agent queue is full right now. Try again in a minute.";
    if (e.code === "unavailable") return "The agent is temporarily unavailable. Try again shortly.";
    if (e.status === 403) return e.detail ? `Not allowed: ${e.detail}` : "You don't have access to the agent.";
    if (e.status === 404) return "This session no longer exists.";
    if (e.code === "conflict") return e.detail ?? "A turn is already running.";
    return e.detail || e.message;
  }
  if (e instanceof TypeError) return "Can't reach the Prism server. Check your connection.";
  return e instanceof Error ? e.message : String(e);
}

export function useAgentConversation(client: AgentClient, sessionId: string | null) {
  const queryClient = useQueryClient();
  const [state, dispatch] = useReducer(reducer, emptyConversation);
  const stateRef = useRef(state);
  stateRef.current = state;
  const [session, setSession] = useState<AgentSession | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conn, setConn] = useState<ConnectionState>("idle");
  const unsubRef = useRef<(() => void) | null>(null);
  const loadSeq = useRef(0);
  const refetchedTurns = useRef(new Set<string>());

  const stopStream = useCallback(() => {
    unsubRef.current?.();
    unsubRef.current = null;
  }, []);

  const refreshLists = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: agentKeys(client).all });
  }, [queryClient, client]);

  // `load` is referenced from the stream handler (unknown turn → refetch).
  const loadRef = useRef<() => Promise<void>>(async () => {});

  const openStream = useCallback(
    (id: string, after: number) => {
      stopStream();
      setConn("connecting");
      const unsub = client.streamSession(id, after, {
        onOpen: () => setConn("live"),
        onError: (e, { willRetry }) => {
          setConn(willRetry ? "reconnecting" : "idle");
          if (!willRetry && /SSE 40[34]/.test(e.message)) setError("Lost access to this session.");
        },
        onClose: () => {
          if (unsubRef.current === unsub) unsubRef.current = null;
          setConn("idle");
          refreshLists();
        },
        onEvent: (msg) => {
          const known = stateRef.current.turns.some((t) => t.id === msg.turnId);
          dispatch({ type: "msg", msg });
          if (!known && typeof msg.seq === "number" && !refetchedTurns.current.has(msg.turnId)) {
            // A turn started elsewhere (another device): fetch its prompt.
            refetchedTurns.current.add(msg.turnId);
            void loadRef.current();
          }
          if (msg.t === "note_touched") void queryClient.invalidateQueries({ queryKey: ["vault"] });
          if (msg.t === "status" && isTerminalTurn(msg.status)) {
            refreshLists();
            // The server commits cost and session metadata before this event.
            // Refresh the open conversation too, not only its sidebar row.
            void loadRef.current();
          }
        },
      });
      unsubRef.current = unsub;
    },
    [client, stopStream, refreshLists, queryClient],
  );

  const load = useCallback(async () => {
    if (!sessionId) return;
    const my = ++loadSeq.current;
    setLoading(true);
    try {
      const detail = await client.getSession(sessionId);
      if (my !== loadSeq.current) return;
      const { state: seeded, streamAfter } = seedConversation(detail);
      setSession(detail.session);
      dispatch({ type: "reset", state: seeded });
      setError(null);
      if (streamAfter !== null) openStream(sessionId, streamAfter);
      else stopStream();
    } catch (e) {
      if (my === loadSeq.current) setError(agentErrorText(e));
    } finally {
      if (my === loadSeq.current) setLoading(false);
    }
  }, [client, sessionId, openStream, stopStream]);
  loadRef.current = load;

  // (Re)load on session change; tear the stream down on leave.
  useEffect(() => {
    dispatch({ type: "reset", state: emptyConversation });
    setSession(null);
    setError(null);
    refetchedTurns.current.clear();
    if (sessionId) void load();
    return () => {
      loadSeq.current++;
      stopStream();
    };
  }, [sessionId, client]); // eslint-disable-line react-hooks/exhaustive-deps

  // Back from the background (phone lock, tab switch): the socket may have been
  // killed silently — re-attach if anything is (or was) in flight.
  useEffect(() => {
    if (!sessionId) return;
    const onVis = () => {
      if (document.visibilityState !== "visible") return;
      if (activeTurn(stateRef.current) || unsubRef.current) void load();
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("online", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("online", onVis);
    };
  }, [sessionId, load]);

  /** Send a prompt in this session. Returns false on failure (error is set). */
  const send = useCallback(
    async (prompt: string, opts: { noteId?: string; requestId?: string; contextNoteIds?: string[] } = {}): Promise<boolean> => {
      if (!sessionId) return false;
      setError(null);
      try {
        const r = await client.sendTurn(sessionId, prompt, opts);
        if (isTerminalTurn(r.status)) {
          await load();
          refreshLists();
          return true;
        }
        dispatch({ type: "pending", id: r.turnId, prompt, noteId: opts.noteId ?? null, context: r.context });
        openStream(sessionId, stateRef.current.lastSeq);
        refreshLists();
        return true;
      } catch (e) {
        if (e instanceof AgentApiError && e.code === "conflict" && e.turnId) {
          // A turn is already running (another tab/device): attach to it.
          await load();
          setError("A turn is already running in this session — showing it now. Send again when it finishes.");
          return false;
        }
        setError(agentErrorText(e));
        return false;
      }
    },
    [client, sessionId, openStream, load, refreshLists],
  );

  const cancel = useCallback(async () => {
    const t = activeTurn(stateRef.current);
    if (!t) return;
    try {
      await client.cancelTurn(t.id);
    } catch (e) {
      setError(agentErrorText(e));
    }
  }, [client]);

  return { state, session, loading, error, setError, conn, send, cancel, reload: load, active: activeTurn(state) };
}
