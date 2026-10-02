import React, { Suspense } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PlatformProvider, VaultClientProvider, useAgentChatStore, useUIStore, type VaultClient, type Note } from "@prism/core";
import { getRenderer } from "../../../packages/core/src/components/renderers/Registry";
import { useNote, useUpdateNote } from "../../../packages/core/src/app/hooks/useParachute";
import type { ContentType } from "../../../packages/core/src/lib/types";
import type { DashboardWidgetConfig } from "../../../packages/core/src/lib/dashboard/widget-registry";
const params = new URLSearchParams(location.search);
const kind = params.get("kind") || "project";
const readOnly = params.has("readonly");
const make = (id: string, path: string, type: string, content = "", metadata: Record<string, unknown> = {}, tags: string[] = []): Note => ({id,path,content,metadata:{type,...metadata},tags,createdAt:"2026-10-02T12:00:00Z",updatedAt:"2026-10-02T12:00:00Z"});
const widgets: DashboardWidgetConfig[] = [
 {id:"board",type:"board",title:"Launch tasks",source:{tags:["task"]},group:{field:"status"},span:2},
 {id:"stat",type:"stat",title:"Task count",source:{tags:["task"]},aggregateType:"count"},
 {id:"list",type:"list",title:"Related documents",source:{tags:["note"]},columns:[{field:"path",label:"Title"}]},
 {id:"quick",type:"quick-actions",title:"Shortcuts",actions:[{id:"create",label:"Create task",icon:"Plus",action:"create-note",tags:["task"]},{id:"search",label:"Find a note",icon:"Search",action:"open-command-bar"}]},
];
if (params.has("inventory")) {
 for (const type of ["gallery","progress","timeline","chart","embed","task-list","note-list","stat-card","calendar"]) widgets.push({id:type,type:type as DashboardWidgetConfig["type"],title:`Inventory: ${type}`,source:{tags:["task"]},noteId:"brief",segmentField:"status",aggregateCondition:{status:"done"}});
}
const today=new Date();today.setHours(12,0,0,0);
const base = [
 make("meeting","Fictional planning session","event","",{title:"Fictional planning session",start:today.toISOString(),end:new Date(today.getTime()+3600000).toISOString()},["meeting"]),
 make("presentation","Workshop slides","presentation","# Welcome\n\nFirst slide\n\n---\n\n# Next steps\n\n- Review the plan"),
 make("project","Projects/Prism","project","# Prism\nA fictional launch project."),
 make("website","Private example","website","<h1>Safe preview</h1><script>try { parent.document.body.dataset.escaped='yes' } catch {}<\/script>"),
 make("dashboard","Project overview","dashboard","",{layout:{columns:2,widgets},unrelated:"preserve"}),
 make("unknown","Future note","future-format","RAW_START\n<script>never_execute()</script>\n"+"long_value_".repeat(80)+"\nRAW_END"),
 make("spreadsheet","Budget","spreadsheet","Name,Value\nFirst,2\nSecond,=B2+1"),
 make("code","Example.ts","code","// original source\nconst answer = 42;",{language:"typescript"}),
 make("map","Map","map"),
 make("bioregion-entity","Places/Meadow","bioregion-entity","# Meadow\n\nVisit [[Projects/Prism/Brief|the brief]].",{scientificName:"Festuca rubra",status:"observed"},["species"]),
 make("task-a","Projects/Prism/Review","task","Task source preserved",{status:"todo"},["task"]),
 make("task-b","Other/Release","task","Task source preserved",{status:"done",project:"Prism"},["task"]),
 make("brief","Projects/Prism/Brief","note","Linked document",{},["note"]),
 make("excluded","Projects/Prism2/Unrelated","note","Not this project",{},["note"]),
 make("place","Places/Creek","bioregion-entity","Creek",{name:"Fictional Creek",geo:{lat:40,lon:-105}},["place"]),
];
let notes: Note[] = JSON.parse(localStorage.getItem("renderer-preservation") || "null") ?? base;
const controls = {writes:[] as unknown[],fail:params.has("fail"),reads:[] as unknown[],treeReads:0,failTree:false,holdTree:false,releaseTree:null as (()=>void)|null,scope:"renderer-fixture",switchScope:()=>{controls.scope="renderer-guest";useAgentChatStore.setState({scope:controls.scope});},notes:()=>notes,open:()=>useUIStore.getState().openTabs,refresh:()=>query.invalidateQueries({queryKey:["vault"]})};
Object.assign(window,{prismRendererFixture:controls});
const client = {
 scope:()=>controls.scope,listNotes:async(filters?:{tag?:string;path?:string})=>{controls.reads.push(filters);if(controls.fail)throw Error("Synthetic read unavailable");return structuredClone(notes.filter(n=>(!filters?.tag || n.tags?.includes(filters.tag))&&(!filters?.path||n.path?.startsWith(filters.path))));},
 getNote:async(id:string)=>structuredClone(notes.find(n=>n.id===id)!),
 updateNote:async(id:string,patch:Partial<Note>)=>{controls.writes.push({id,...patch});if(controls.fail)throw Error("Synthetic save unavailable");const i=notes.findIndex(n=>n.id===id);notes[i]={...notes[i],...patch};localStorage.setItem("renderer-preservation",JSON.stringify(notes));return structuredClone(notes[i]);},
 listTree:async()=>{controls.treeReads++;if(controls.failTree)throw Error("Synthetic tree unavailable");const entries=controls.scope==="renderer-fixture"?[...structuredClone(notes),{id:"nested",path:"vault/Projects/Prism/Research/Entry",metadata:null,tags:[]}]:[{id:"guest",path:"Guest directory/Entry",metadata:null,tags:[]}];if(controls.holdTree)await new Promise<void>(resolve=>{controls.releaseTree=resolve;});return entries;},
 getTags:async()=>[{tag:"task",count:2},{tag:"note",count:2}],getPaths:async()=>["Projects/Prism"],getStats:async()=>({totalNotes:notes.length,totalTags:3}),
 createNote:async()=>{throw Error("Creation outside this fixture");},
} as unknown as VaultClient;
const query = new QueryClient({defaultOptions:{queries:{retry:false}}});
useAgentChatStore.setState({scope:"renderer-fixture"});
function Fixture() {
 const {data:note}=useNote(kind); const update=useUpdateNote();
 const Renderer=getRenderer(kind as ContentType);
 return <main style={{height:"100dvh",minWidth:0}}><Suspense fallback={<p>Loading renderer…</p>}>{note&&<Renderer note={note} readOnly={readOnly} onMetadataChange={metadata=>update.mutate({id:note.id,metadata})}/>}</Suspense></main>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><QueryClientProvider client={query}><PlatformProvider value="web"><VaultClientProvider client={client}><Fixture/></VaultClientProvider></PlatformProvider></QueryClientProvider></React.StrictMode>);
