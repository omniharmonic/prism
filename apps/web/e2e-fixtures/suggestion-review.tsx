import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEditor } from '@tiptap/react';
import Collaboration from '@tiptap/extension-collaboration';
import { collabExtensions } from '../../../packages/core/src/editor/collabSchema';
import { SuggestionMode } from '../../../packages/core/src/editor/suggestions';
import { createRoot } from 'react-dom/client';
import { CollabEditor, PageHeader, type Editor } from '@prism/core';
import * as Y from 'yjs';
import { applyTheme } from '../../../packages/core/src/app/stores/settings';
const params = new URLSearchParams(location.search);
applyTheme(params.has('dark') ? 'dark' : 'light');
const doc = new Y.Doc();
const mark = (kind: string, id: string, author: string, text: string, agent = false) => `<span data-suggestion="${kind}" data-suggestion-id="${id}" data-actor-id="actor-${id}" data-user="${author}" ${agent ? 'data-turn-id="turn-fictional"' : ''}>${text}</span>`;
const body = `<h2>Purpose</h2><p>Our workspace connects ideas. ${mark('delete','first','Prism agent','Prism brings many tools into one interface.',true)}${mark('insert','first','Prism agent','Prism is a shared workspace for you and your agent.',true)}</p><p>We work ${mark('insert','second','Morgan','with a shared understanding')} every day.</p><p>${mark('delete','third','Alex','An outdated sentence.')}</p>`;
let editor: Editor | null = null;
let peer: Editor | null = null;
const controls = {
  body: () => editor?.getHTML(),
  selection: () => editor?.state.selection.from,
  prefix: () => peer?.commands.insertContentAt(1, 'A peer added context. '),
  acceptFirst: () => {
    if (!peer) return;
    let from: number | undefined;
    peer.state.doc.descendants((node, pos) => { if (from === undefined && node.isText && node.marks.some(mark => mark.type.name === 'insertion' || mark.type.name === 'deletion')) from = pos; });
    if (from !== undefined) { peer.commands.setTextSelection(from); peer.commands.acceptSuggestion(); }
  },
};
Object.assign(window, { reviewFixture: controls });
function Peer() {
  peer = useEditor({ extensions: [...collabExtensions(), Collaboration.configure({ document: doc }), SuggestionMode.configure({ user: { name: 'Other reviewer', color: '#7c3aed' } })] });
  return null;
}
function Fixture() {
  const [canReview, setCanReview] = useState(!params.has('readonly'));
  return <><nav style={{ padding: 12 }}><button onClick={() => setCanReview(false)}>Switch to view-only</button></nav><main style={{ maxWidth: 760, margin: '0 auto', padding: '24px', color: 'var(--text-primary)' }}>
    <PageHeader fallbackName="A living workspace" path="Projects/Prism/A living workspace" />
    <CollabEditor ydoc={doc} provider={null} user={{ name: 'You', color: '#2563eb' }} seedReady seedContent={async () => body} canReview={canReview} editable={canReview} onEditor={value => { editor = value; }} />
  </main><Peer /></>;
}
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={new QueryClient()}><Fixture /></QueryClientProvider>);
