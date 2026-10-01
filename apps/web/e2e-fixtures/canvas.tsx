import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { VaultClientProvider, PlatformProvider, type VaultClient, type Note } from "@prism/core";
import CanvasRenderer from "../../../packages/core/src/components/renderers/CanvasRenderer";
import { buildNoteCardElements } from "../../../packages/core/src/components/renderers/canvas-cards";
import { authoredCanvasElements } from "../../../packages/core/src/components/renderers/canvas-scene";
const makeNote = (id:string):Note => ({ id,path:`Test/${id}`,content:'Synthetic canvas card',tags:[],metadata:{type:'document'},createdAt:'2026-10-01',updatedAt:'2026-10-01' });
const a=makeNote('Card A'),b=makeNote('Card B');
const elements=[...buildNoteCardElements({note:a,includeBody:false,isDark:false,existingCount:0}),...buildNoteCardElements({note:b,includeBody:false,isDark:false,existingCount:1})];
const canvas={...makeNote('Canvas'),metadata:{type:'canvas'},content:JSON.stringify({elements})};
const controls={writes:[] as unknown[], linkWrites:[] as unknown[],reads:0,authoredCanvasElements};
Object.assign(window,{prismCanvasFixture:controls});
const client={
 getNote:async(id:string)=>[a,b,canvas].find(n=>n.id===id)!,
 listNotes:async()=>[a,b,canvas],getTags:async()=>[],
 updateNote:async(_id:string,patch:Record<string,unknown>)=>{controls.writes.push(patch);Object.assign(canvas,patch);return canvas;},
 getLinks:async()=>{controls.reads++;return [{sourceId:a.id,targetId:b.id,relationship:'supports',createdAt:'2026-10-01'}];},
 createLink:async(...args:unknown[])=>{controls.linkWrites.push(['create',...args]);},
 deleteLink:async(...args:unknown[])=>{controls.linkWrites.push(['delete',...args]);},
} as unknown as VaultClient;
createRoot(document.getElementById('root')!).render(<React.StrictMode><QueryClientProvider client={new QueryClient()}><PlatformProvider value="web"><VaultClientProvider client={client}><main style={{height:'100dvh'}}><CanvasRenderer note={canvas}/></main></VaultClientProvider></PlatformProvider></QueryClientProvider></React.StrictMode>);
