import { create } from "zustand";
import type { VaultClient } from "../data/VaultClient";
import type { Note } from "./types";
import { useAgentChatStore } from "./agent/chatStore";
import { buildWikilinkIndex, resolveWikilink, noteLinkTitle } from "./wikilinks";

interface NavigationRequest {
  id: string; scope: string|null; target: string;
  state: "loading"|"choose"|"error";
  candidates: Array<{id:string;path:string|null;title:string}>;
  error?: string;
  select(id:string): Promise<void>;
  returnFocus(): void;
}
export const useWikilinkNavigation = create<{request:NavigationRequest|null}>(()=>({request:null}));
export const closeWikilinkNavigation = () => useWikilinkNavigation.setState({request:null});

/** Fresh resolution and a fresh read before opening; late replies cannot change another workspace. */
export async function navigateWikilink(client: VaultClient, target: string, open: (note:Note)=>void): Promise<void> {
  const scope = useAgentChatStore.getState().scope;
  const id = crypto.randomUUID();
  const trigger = document.activeElement as HTMLElement|null;
  const editor = trigger?.closest(".ProseMirror");
  const returnFocus = () => {
    // ProseMirror may replace a decoration while the chooser is open. Restore
    // its equivalent link in the same editor, never a link in another tab.
    const replacement = editor?.isConnected ? [...editor.querySelectorAll<HTMLElement>(".wikilink")].find(e=>e.dataset.wikilinkTarget===target) : null;
    if (replacement) replacement.focus();
    else if (trigger?.isConnected) trigger.focus();
  };
  const current = () => useAgentChatStore.getState().scope===scope && useWikilinkNavigation.getState().request?.id===id;
  const update = (change:Partial<NavigationRequest>) => {
    if (current()) useWikilinkNavigation.setState(s=>({request:{...s.request!,...change}}));
  };
  const select = async (noteId:string) => {
    if (!current()) return;
    update({state:"loading",error:undefined});
    try {
      const note = await client.getNote(noteId);
      if (!current()) return;
      closeWikilinkNavigation();
      open(note);
    } catch { update({state:"error",candidates:[],error:"This document is unavailable or your access has changed."}); }
  };
  useWikilinkNavigation.setState({request:{id,scope,target,state:"loading",candidates:[],select,returnFocus}});
  try {
    let resolved;
    if (client.resolveWikilink) resolved = await client.resolveWikilink(target);
    else {
      const notes = await client.listNotes();
      if (notes.length >= 50_000) throw new Error("Incomplete document inventory");
      const result = resolveWikilink(target,buildWikilinkIndex(notes));
      const matches = result.kind === "match" ? [result.note] : result.kind === "ambiguous" ? result.notes : [];
      resolved = {kind:result.kind,candidates:matches.map(note=>({id:note.id,path:note.path,title:noteLinkTitle(note)}))};
    }
    if (!current()) return;
    if (resolved.kind === "match" && resolved.candidates.length===1) await select(resolved.candidates[0]!.id);
    else if (resolved.kind === "ambiguous") update({state:"choose",candidates:resolved.candidates});
    else update({state:"error",error:"No accessible document matches this link. It may have moved or require access."});
  } catch { update({state:"error",error:"Couldn’t resolve this link. Check your connection and try again."}); }
}
