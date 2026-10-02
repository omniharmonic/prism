import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {VaultClientProvider, PlatformProvider, type VaultClient, type Note} from '@prism/core';
import {VaultRequestError} from '../../../packages/core/src/data/VaultClient';
import {LinksPanel} from '../../../packages/core/src/components/layout/LinksPanel';
import {useAgentChatStore} from '../../../packages/core/src/lib/agent/chatStore';
import {useUIStore} from '../../../packages/core/src/app/stores/ui';
import {applyTheme, useSettingsStore} from '../../../packages/core/src/app/stores/settings';
const dark = location.search.includes('dark');applyTheme(dark?'dark':'light');useSettingsStore.setState({theme:dark?'dark':'light'});
const controls={scope:'fixture-a',noteId:'source-a',failLinks:false,denySource:false,deny:new Set<string>(),fail:new Set<string>(),hold:false,holdTargets:location.search.includes('parallel'),pending:[] as Array<()=>void>,reads:[] as Array<{id:string;fresh:boolean;scope:string}>,linkReads:0,writes:0,rename:false,ui:useUIStore,query:new QueryClient({defaultOptions:{queries:{retry:false}}})};
useAgentChatStore.setState({scope:controls.scope});
const titles=['Field notes','Weekly review','Workspace principles'];
const note=(id:string,scope=controls.scope):Note=>({id,path:'Research/'+(titles[Number(id.split('-').at(-1))]??'Research note '+id.split('-').at(-1)),content:'Fictional source body',metadata:{title:controls.rename?'Updated title':scope==='fixture-b'?'New workspace note':titles[Number(id.split('-').at(-1))]??'Research note '+id.split('-').at(-1)},tags:[],createdAt:'2026-10-01',updatedAt:'2026-10-02'});
const client={scope:()=>controls.scope,getNote:async(id:string,opts?:{fresh?:boolean})=>{const scope=controls.scope;controls.reads.push({id,fresh:!!opts?.fresh,scope});if(controls.hold||(controls.holdTargets&&!id.startsWith('source')))await new Promise<void>(resolve=>controls.pending.push(resolve));if(controls.deny.has(id)||(controls.denySource&&id.startsWith('source')))throw new VaultRequestError(403,'private diagnostics');if(controls.fail.has(id))throw Error('private diagnostics');return note(id,scope);},getLinks:async(id:string)=>{controls.linkReads++;if(controls.failLinks)throw Error('private diagnostics');if(location.search.includes('empty'))return[];return Array.from({length:location.search.includes('small')?3:25},(_,i)=>({sourceId:i%2?id:'linked-id-'+i,targetId:i%2?'linked-id-'+i:id,relationship:i%2?'references':'supports',createdAt:'2026-10-01'}));},updateNote:async()=>{controls.writes++;throw Error('unexpected mutation');}} as unknown as VaultClient;
if(location.search.includes('unsupported'))delete (client as Partial<VaultClient>).getLinks;
Object.assign(window,{contextLinks:controls});
function Fixture(){const[noteId,setNoteId]=useState('source-a');return <><nav style={{padding:12,display:'flex',gap:12}}><button onClick={()=>{controls.scope=controls.scope==='fixture-a'?'fixture-b':'fixture-a';useAgentChatStore.setState({scope:controls.scope});}}>Switch workspace</button><button onClick={()=>{controls.noteId='source-b';setNoteId('source-b');}}>Switch document</button></nav><main style={{width:'min(100%, 420px)',margin:'0 auto',padding:20,boxSizing:'border-box'}}><LinksPanel noteId={noteId}/></main></>}
createRoot(document.getElementById('root')!).render(<React.StrictMode><QueryClientProvider client={controls.query}><PlatformProvider value="web"><VaultClientProvider client={client}><Fixture/></VaultClientProvider></PlatformProvider></QueryClientProvider></React.StrictMode>);
