import React from "react";
import {convertToExcalidrawElements} from "@excalidraw/excalidraw";
import * as Y from "yjs";
import { CollabCanvas } from "../../../packages/core/src/components/renderers/LazyCollabEditors";
import { useUIStore } from "../../../packages/core/src/app/stores/ui";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { VaultClientProvider, PlatformProvider, type VaultClient, type Note } from "@prism/core";
import CanvasRenderer from "../../../packages/core/src/components/renderers/CanvasRenderer";
import { buildNoteCardElements } from "../../../packages/core/src/components/renderers/canvas-cards";
import { authoredCanvasElements } from "../../../packages/core/src/components/renderers/canvas-scene";
const makeNote = (id:string):Note => ({ id,path:`Test/${id}`,content:'Synthetic canvas card',tags:[],metadata:{type:'document'},createdAt:'2026-10-01',updatedAt:'2026-10-01' });
const a=makeNote('Card A'),b=makeNote('Card B'),c=makeNote('Card C'),d=makeNote('Card D');
const elements=[...buildNoteCardElements({note:a,includeBody:false,isDark:false,existingCount:0}),...buildNoteCardElements({note:b,includeBody:false,isDark:false,existingCount:1})];
if(location.search.includes("relations")){
 const arrow=convertToExcalidrawElements([{type:"arrow",x:340,y:135,width:20,height:0,points:[[0,0],[20,0]]}])[0] as any;
 Object.assign(arrow,{id:"authored-arrow",startBinding:{elementId:elements[0].id,focus:0,gap:1},endBinding:{elementId:elements[2].id,focus:0,gap:1}});
 elements.push(arrow);
}
const canvas={...makeNote('Canvas'),metadata:{type:'canvas'},content:JSON.stringify({elements})};
const controls={syncAttempts:[] as string[], rejectRelations:location.search.includes("relations"), retained:false, writes:[] as unknown[], linkWrites:[] as unknown[],reads:0, noteReads:[] as string[], deny:false, hold:false, release:null as null|(()=>void), scope:"fixture-owner", authoredCanvasElements, ui:useUIStore};
Object.assign(window,{prismCanvasFixture:controls});
const client={
 scope:()=>controls.scope,
 reconcileCanvasRelations:async(_id:string,fingerprint:string)=>{controls.syncAttempts.push(fingerprint);if(controls.rejectRelations)throw Error("Fixture relation failure");return {synced:JSON.parse(fingerprint).length,retained:controls.retained};},
 getNote:async(id:string)=>{controls.noteReads.push(id);if(controls.hold)await new Promise<void>(r=>controls.release=r);if(controls.deny)throw Error('Access denied');return [a,b,c,d,canvas].find(n=>n.id===id)!;},
 listTree:async()=>[a,b,c,d,canvas].map(({id,path,tags,metadata})=>({id,path,tags,metadata})),
 listNotes:async()=>[a,b,canvas],getTags:async()=>[],
 updateNote:async(_id:string,patch:Record<string,unknown>)=>{controls.writes.push(patch);Object.assign(canvas,patch);return canvas;},
 getLinks:async()=>{controls.reads++;return [{sourceId:a.id,targetId:b.id,relationship:'supports',createdAt:'2026-10-01'}];},
 createLink:async(...args:unknown[])=>{controls.linkWrites.push(['create',...args]);},
 deleteLink:async(...args:unknown[])=>{controls.linkWrites.push(['delete',...args]);},
} as unknown as VaultClient;
const doc=new Y.Doc();for(const el of elements)doc.getMap("elements").set(el.id,el);
Object.assign(controls,{doc});
createRoot(document.getElementById('root')!).render(<React.StrictMode><QueryClientProvider client={new QueryClient()}><PlatformProvider value="web"><VaultClientProvider client={client}><main style={{height:'100dvh'}}><div style={{position:"relative",height:"100%"}}>{location.search.includes("collab")?<CollabCanvas noteId={canvas.id} editable={!location.search.includes("readonly")} ydoc={doc} provider={{awareness:null}} user={{name:"Fixture owner",color:"#4466aa"}}/>:<CanvasRenderer note={canvas} readOnly={location.search.includes("readonly")}/>}</div></main></VaultClientProvider></PlatformProvider></QueryClientProvider></React.StrictMode>);
