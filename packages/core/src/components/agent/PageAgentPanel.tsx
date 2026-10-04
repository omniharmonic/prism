import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { Check, Copy, FileText, Loader2, Sparkles, TextSelect, X } from "lucide-react";
import { useHostServices } from "../../data/HostServicesContext";
import { hostServiceErrorText, HostServiceError, type HostServices } from "../../lib/host/services";
import { useNote } from "../../app/hooks/useParachute";
import { isLocked } from "../../lib/pages/model";
import { usePagesUI } from "../../lib/pages/store";
import { useSyncStore } from "../../lib/sync/syncState";
import { registeredEditor, useDocumentSnapshots } from "../../lib/agent/documentSnapshots";
import {
  DRAFT_OPTIONS,
  LANGUAGES,
  PAGE_AGENT_MAX_SELECTION,
  TONES,
  TRANSFORM_OPTIONS,
  applyPageAgentResult,
  buildPageAgentPrompt,
  optionLabel,
  pageAgentSkill,
  resultParagraphs,
  replaceRefusal,
  usePageAgent,
  validOption,
  writeRefusal,
  type PageAgentOption,
  type PageAgentPlacement,
  type PageAgentRequest,
  type PageAgentSource,
} from "../../lib/agent/pageActions";
import "./page-agent.css";

/** Mounted once in the Shell. Renders nothing for a viewer with no agent (no host services). */
export function PageAgentHost() {
  const host = useHostServices();
  const request = usePageAgent((s) => s.request);
  if (!host || !request) return null;
  return <PageAgentPanel key={request.id} host={host} request={request} />;
}

/** Does this viewer have the page actions at all (the server owner's agent)? */
export function usePageAgentAvailable(): boolean {
  return !!useHostServices();
}

type Phase = "choose" | "running" | "done" | "error";
const number = (n: number) => n.toLocaleString();

function sourceText(s: PageAgentSource): string {
  const amount = s.truncated ? `the first ${number(s.characters)} of ${number(s.of)} characters` : `${number(s.characters)} character${s.characters === 1 ? "" : "s"}`;
  return s.part === "selection" ? `Your selection in “${s.title}” (${amount})` : `This page, “${s.title}” (${amount})`;
}

/**
 * NP-AI-03 — the result of an agent action on a page or a selection, as a proposal:
 * what the agent read ("Sources"), the text it returned, and an explicit choice of
 * what to do with it. Nothing is written to the page until the person chooses to.
 */
function PageAgentPanel({ host, request }: { host: HostServices; request: PageAgentRequest }) {
  const close = usePageAgent((s) => s.close);
  const online = useSyncStore((s) => s.online);
  const { data: note } = useNote(request.noteId);
  // Re-read which editor holds the page whenever the registry changes (a remount, a closed tab).
  useDocumentSnapshots((s) => s.notes[request.noteId]?.editor);
  const editor = registeredEditor(request.noteId)?.editor ?? null;
  const onSelection = !!request.selection;
  const needsChoice = request.kind !== "summarize" && !validOption(request.kind, request.option);
  const [option, setOption] = useState<PageAgentOption | undefined>(needsChoice ? undefined : request.option);
  const [phase, setPhase] = useState<Phase>(needsChoice ? "choose" : "running");
  const [result, setResult] = useState("");
  const [sources, setSources] = useState<PageAgentSource[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [copied, setCopied] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const runSeq = useRef(0);
  const panel = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null);

  const run = useCallback((chosen: PageAgentOption | undefined) => {
    controller.current?.abort();
    const seq = ++runSeq.current;
    setOption(chosen);
    setNotice("");
    setCopied(false);
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      setError("You’re offline. The agent needs a connection — nothing was changed.");
      setPhase("error");
      return;
    }
    const built = buildPageAgentPrompt({ ...request, option: chosen });
    setSources(built.sources);
    setPhase("running");
    const abort = new AbortController();
    controller.current = abort;
    // A TEXT-ONLY run: the agent gets this prompt and nothing else — no vault tools, no
    // note id (review 10). That is what makes the "Sources" list below complete.
    host.agentText(built.prompt, { skill: pageAgentSkill(request.kind), textOnly: true, timeoutMs: 3 * 60_000, signal: abort.signal }).then(
      (text) => {
        if (seq !== runSeq.current) return;
        if (!resultParagraphs(text).length) {
          setError("The agent returned nothing. Nothing was changed — try again.");
          setPhase("error");
          return;
        }
        setResult(text);
        setPhase("done");
      },
      (e) => {
        if (seq !== runSeq.current) return;
        if (e instanceof HostServiceError && (e.code === "aborted" || e.code === "agent_cancelled")) return; // stopped by the person
        setError(`${hostServiceErrorText(e)} Nothing was changed.`);
        setPhase("error");
      },
    );
  }, [host, request]);

  // Start at once when there is nothing to choose. One run per panel, also under
  // StrictMode's double effect; a real unmount stops the run (and cancels it on the server).
  const started = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    if (!started.current) {
      started.current = true;
      if (!needsChoice) run(request.option);
    }
    return () => {
      mounted.current = false;
      queueMicrotask(() => {
        if (!mounted.current) { runSeq.current++; controller.current?.abort(); }
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { panel.current?.focus({ preventScroll: true }); }, []);

  const dismiss = useCallback((focusEditor = false) => {
    runSeq.current++;
    controller.current?.abort();
    close();
    requestAnimationFrame(() => {
      if (focusEditor) return;
      const back = returnFocus.current;
      if (back?.isConnected) back.focus({ preventScroll: true });
    });
  }, [close]);

  const stop = () => {
    runSeq.current++;
    controller.current?.abort();
    if (needsChoice) { setPhase("choose"); setNotice("Stopped. Nothing was changed."); }
    else dismiss();
  };

  const locked = isLocked(note);
  const refusal = writeRefusal(editor, locked);
  const selectionWhole = !!request.selection && request.selection.text.length <= PAGE_AGENT_MAX_SELECTION;
  // Where the selection is NOW (positions are mapped through every change to the page),
  // and whether replacing it would lose anything. Re-judged on every editor transaction.
  const [, rejudge] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!editor) return;
    editor.on("transaction", rejudge);
    return () => { editor.off("transaction", rejudge); };
  }, [editor]);
  const whyNotReplace = !request.selection ? "" : !selectionWhole ? "" : editor && !refusal ? replaceRefusal(request, editor) : "";
  const canReplace = !refusal && !!editor && !!request.selection && selectionWhole && !whyNotReplace;

  const apply = (placement: PageAgentPlacement) => {
    const now = registeredEditor(request.noteId)?.editor ?? null;
    const why = writeRefusal(now, isLocked(note));
    if (why || !now) { setNotice(why || "The page is no longer open."); return; }
    if (!applyPageAgentResult(now, result, placement, request)) {
      setNotice(placement === "replace" ? `${replaceRefusal(request, now) || "The selection could not be replaced."} Insert the result below, or copy it.` : "The result could not be inserted here. Copy it instead.");
      return;
    }
    usePagesUI.getState().showToast({ message: placement === "replace" ? "Selection replaced. Undo brings the original back." : "Inserted into the page. Undo removes it." });
    dismiss(true);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(resultParagraphs(result).join("\n\n"));
      setCopied(true);
      setNotice("");
    } catch {
      setCopied(false);
      setNotice("Couldn’t copy automatically. Select the text above and copy it.");
    }
  };

  const title = optionLabel(request.kind, option, onSelection);
  const longPage = sources.find((s) => s.part === "page" && s.truncated);
  const longSelection = sources.find((s) => s.part === "selection" && s.truncated);
  const placements: Array<{ id: PageAgentPlacement; label: string }> = onSelection
    ? [...(canReplace ? [{ id: "replace" as const, label: "Replace selection" }] : []), { id: "below", label: "Insert below" }]
    : request.kind === "summarize"
      ? [{ id: "top", label: "Insert at top" }, { id: "cursor", label: "Insert at cursor" }]
      : request.kind === "draft"
        ? [{ id: "end", label: "Insert at end" }, { id: "cursor", label: "Insert at cursor" }]
        : [{ id: "end", label: "Insert at end" }];

  return (
    <div
      ref={panel}
      className="page-agent"
      role="dialog"
      aria-modal="false"
      aria-labelledby="page-agent-title"
      tabIndex={-1}
      data-phase={phase}
      onKeyDown={(e) => {
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); dismiss(); }
      }}
    >
      <div className="page-agent-head">
        <Sparkles size={15} aria-hidden="true" />
        <h2 id="page-agent-title">Agent · {title}</h2>
        <button type="button" className="page-agent-close focus-ring" aria-label={phase === "done" ? "Discard result" : "Close"} onClick={() => dismiss()}>
          <X size={16} />
        </button>
      </div>

      {/* One polite live region: the state in words. */}
      <p className="sr-only" role="status" aria-live="polite">
        {phase === "running" ? "The agent is working." : phase === "done" ? "The result is ready to review. Nothing has been changed yet." : phase === "error" ? "" : "Choose what the agent should do."}
      </p>

      {phase === "choose" && (
        <div className="page-agent-body">
          {!online && <p className="page-agent-note" role="alert">You’re offline. The agent needs a connection.</p>}
          <p className="page-agent-lead">{onSelection ? "What should the agent do with your selection?" : "What should the agent do with this page?"}</p>
          <div className="page-agent-options" role="group" aria-label={request.kind === "draft" ? "Draft" : "Transform"}>
            {(request.kind === "draft" ? DRAFT_OPTIONS : TRANSFORM_OPTIONS).map((o) => (
              <button key={o.id} type="button" className="page-agent-chip focus-ring" disabled={!online} onClick={() => run(o.id)}>
                {o.label}
              </button>
            ))}
            {request.kind === "transform" && (
              <>
                <label className="page-agent-select">
                  <span className="sr-only">Change tone</span>
                  <select aria-label="Change tone" value="" disabled={!online} onChange={(e) => { if (e.target.value) run(`tone:${e.target.value}`); }}>
                    <option value="">Change tone…</option>
                    {TONES.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </label>
                <label className="page-agent-select">
                  <span className="sr-only">Translate</span>
                  <select aria-label="Translate" value="" disabled={!online} onChange={(e) => { if (e.target.value) run(`translate:${e.target.value}`); }}>
                    <option value="">Translate to…</option>
                    {LANGUAGES.map((l) => <option key={l} value={l}>{l}</option>)}
                  </select>
                </label>
              </>
            )}
          </div>
          {notice && <p className="page-agent-note" role="status">{notice}</p>}
        </div>
      )}

      {phase === "running" && (
        <div className="page-agent-body">
          <p className="page-agent-working"><Loader2 size={15} className="animate-spin" aria-hidden="true" /> Working… this page is not changed while the agent works.</p>
          <Sources sources={sources} />
          <div className="page-agent-actions">
            <button type="button" className="page-agent-button focus-ring" onClick={stop}>Cancel</button>
          </div>
        </div>
      )}

      {phase === "error" && (
        <div className="page-agent-body">
          <p className="page-agent-error" role="alert">{error}</p>
          <div className="page-agent-actions">
            <button type="button" className="page-agent-button focus-ring" data-primary="true" onClick={() => (needsChoice && !option ? setPhase("choose") : run(option))}>Try again</button>
            <button type="button" className="page-agent-button focus-ring" onClick={() => dismiss()}>Close</button>
          </div>
        </div>
      )}

      {phase === "done" && (
        <div className="page-agent-body">
          {onSelection && request.selection && (
            <p className="page-agent-original" aria-label="Original selection">
              <span>Original</span>
              {request.selection.text.length > 280 ? `${request.selection.text.slice(0, 280)}…` : request.selection.text}
            </p>
          )}
          <div className="page-agent-result" role="region" aria-label="Agent result" tabIndex={0}>
            {resultParagraphs(result).map((p, i) => <p key={i}>{p}</p>)}
          </div>
          {(longPage || longSelection) && (
            <p className="page-agent-note" role="note">
              {longSelection
                ? `The selection is long: the agent read its first ${number(longSelection.characters)} characters, so it can’t replace the whole selection.`
                : `This page is long: the agent read its first ${number(longPage!.characters)} characters.`}
            </p>
          )}
          <Sources sources={sources} />
          {refusal && <p className="page-agent-note" role="note">{refusal}</p>}
          {!refusal && whyNotReplace && <p className="page-agent-note" role="note">{whyNotReplace} You can insert the result below it, or copy it.</p>}
          {notice && <p className="page-agent-note" role="alert">{notice}</p>}
          <div className="page-agent-actions">
            {!refusal && placements.map((p, i) => (
              <button key={p.id} type="button" className="page-agent-button focus-ring" data-primary={i === 0 ? "true" : undefined} onClick={() => apply(p.id)}>
                {p.label}
              </button>
            ))}
            <button type="button" className="page-agent-button focus-ring" data-primary={refusal ? "true" : undefined} onClick={() => void copy()}>
              {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />} {copied ? "Copied" : "Copy"}
            </button>
            <button type="button" className="page-agent-button focus-ring" onClick={() => dismiss()}>Discard</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** What the agent was given — the sources of the result. */
function Sources({ sources }: { sources: PageAgentSource[] }) {
  if (!sources.length) return null;
  return (
    <div className="page-agent-sources">
      <h3 id="page-agent-sources">Sources</h3>
      <ul aria-labelledby="page-agent-sources">
        {sources.map((s) => (
          <li key={s.part}>
            {s.part === "selection" ? <TextSelect size={13} aria-hidden="true" /> : <FileText size={13} aria-hidden="true" />}
            <span>{sourceText(s)}</span>
          </li>
        ))}
      </ul>
      <p>The agent was given only this text. It did not change the page.</p>
    </div>
  );
}
