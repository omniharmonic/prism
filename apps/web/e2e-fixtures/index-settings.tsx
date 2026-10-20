import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useAgentChatStore } from "@prism/core";
import { createHttpHostServices, type SearchIndexStatus } from "../../../packages/core/src/lib/host/services";
import { SearchIndexSettings } from "../../../packages/core/src/components/layout/SearchIndexSettings";

const status: SearchIndexStatus = {vaultId:"a",notes:128, chunks:400,semantic:true,automatic:true,job:null};
const control={status,fail:false,deny:false,hold:false,release:null as null|(()=>void),calls:[] as Array<{path:string;vault:string|null}>};
const host=createHttpHostServices({
  scope:()=>useAgentChatStore.getState().scope??"",
  headers:()=>({"X-Prism-Vault":useAgentChatStore.getState().scope??""}),
  fetch:async(path,init)=>{
    const vault=new Headers(init?.headers).get('X-Prism-Vault');
    control.calls.push({path,vault});
    const initial=structuredClone(control.status);
    if(control.hold)await new Promise<void>(r=>{control.release=r;});
    if(control.deny)return Response.json({error:"forbidden"},{status:403});
    if(init?.method==='POST'){
      if(control.fail)return Response.json({error:"index_busy",detail:"Another search update is running."},{status:409});
      if(path.endsWith('/pause'))control.status.job={...control.status.job!,state:"paused"};
      else if(path.endsWith('/resume'))control.status.job={...control.status.job!,state:"running"};
      else control.status.job={id:"job-a",vaultId:"a",state:"running",total:128,processed:10,indexed:10,skipped:0,deleted:0,failed:0,startedAt:1,updatedAt:1,error:null};
      return Response.json(control.status.job);
    }
    return Response.json(vault==='b'?{...initial,vaultId:'b',notes:4,job:null}:initial);
  },
});
const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
useAgentChatStore.setState({scope:"a"});
Object.assign(window,{prismIndexFixture:control,prismIndexStore:useAgentChatStore});
createRoot(document.getElementById('root')!).render(<React.StrictMode><QueryClientProvider client={client}><main style={{padding:16,maxWidth:600}}><SearchIndexSettings host={host}/></main></QueryClientProvider></React.StrictMode>);
