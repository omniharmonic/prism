import React, { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useAgentChatStore, type Note, type VaultClient } from "@prism/core";
import { WikilinkExtension } from "../../../packages/core/src/lib/tiptap/WikilinkMark";
import { WikilinkAutocomplete, type WikilinkAutocompleteState } from "../../../packages/core/src/lib/tiptap/WikilinkAutocomplete";
import { WikilinkDropdown } from "../../../packages/core/src/components/renderers/WikilinkDropdown";
import { WikilinkChooser } from "../../../packages/core/src/components/layout/WikilinkChooser";
import { navigateWikilink } from "../../../packages/core/src/lib/wikilinkNavigation";

const notes:Note[]=[
  {id:'a',path:'Projects/Report',metadata:{aliases:['Weekly']},content:'Project report'},
  {id:'b',path:'Journal/Report',metadata:{},content:'Journal report'},
  {id:'literal',path:'Notes/<b>Literal</b>',metadata:{title:'<b>Literal</b>'},content:'Literal title'},
].map(note=>({...note,tags:[],createdAt:'2026-10-01',updatedAt:'2026-10-01'}));
const control={notes,opened:[] as string[],denied:[] as string[],hold:false,release:null as null|(()=>void),editor:null as Editor|null};
const client={listNotes:async()=>{if(control.hold)await new Promise<void>(r=>{control.release=r;});return notes;},getNote:async(id:string)=>{
  if(control.denied.includes(id))throw new Error('forbidden');const note=notes.find(n=>n.id===id);if(!note)throw new Error('missing');return note;
}} as unknown as VaultClient;
useAgentChatStore.setState({scope:'fixture-a'});
Object.assign(window,{prismLinkFixture:control,prismLinkStore:useAgentChatStore});
function Fixture(){
  const [autocomplete,setAutocomplete]=useState<WikilinkAutocompleteState|null>(null);
  const go=useCallback((target:string)=>{void navigateWikilink(client,target,note=>control.opened.push(note.id));},[]);
  const editor=useEditor({extensions:[StarterKit,WikilinkExtension.configure({onNavigate:go}),WikilinkAutocomplete.configure({onStateChange:setAutocomplete})],content:'<p>See [[Report]] and [[Weekly|This week]].</p>',editorProps:{attributes:{class:'prose-editor',role:'textbox','aria-label':'Document'}}});
  useEffect(()=>{control.editor=editor;},[editor]);
  return <main style={{padding:24,maxWidth:700}}><EditorContent editor={editor}/>{autocomplete?.active&&<WikilinkDropdown editor={editor} notes={notes} autocomplete={autocomplete}/>}<WikilinkChooser/></main>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><Fixture/></React.StrictMode>);
