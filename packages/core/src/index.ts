/**
 * `@prism/core` — the full surface: the app shell (`./shell`, also `@prism/core/shell`)
 * plus the block editor and the components built on it.
 *
 * The web app's boot path must NOT import this module: a static import pulls TipTap,
 * ProseMirror, Yjs and highlight.js into the initial JavaScript (NP-PF-08). Boot-path
 * modules import `@prism/core/shell`; lazily loaded ones (live documents) import this.
 */
export * from "./shell";

// The block editor and what is built on it.
export { CollabEditor } from "./components/renderers/CollabEditor";
export { CommentsSidebar, CommentsRowButton, type CommentCommandActions } from "./components/renderers/CommentsSidebar";
export { useSoftKeyboard, type SoftKeyboard } from "./lib/softKeyboard";
export { HumanSuggestionComposer, humanFailureText, type HumanCommandChannel } from "./components/renderers/HumanSuggestionComposer";
export { PresenceAvatars, presentPeople, jumpToCaret, type PresentPerson, type PresenceAwareness } from "./components/sharing/PresenceAvatars";
export { PageDiscussion } from "./components/renderers/PageDiscussion";
export { MentionNode, mentionExtensions, setMentionNodeView, newMentionUid, mentionFallbackText, MENTION_KINDS, type MentionKind, type MentionAttrs } from "./lib/tiptap/MentionNode";

export { ProjectSections } from "./components/ProjectSections";
