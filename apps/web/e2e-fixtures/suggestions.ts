import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { suggestionMarks } from "../../../packages/core/src/editor/suggestionMarks";
import { SuggestionMode } from "../../../packages/core/src/editor/suggestions";

const root = document.getElementById("root")!;
root.innerHTML = '<h1>Suggestion review fixture</h1><div id="editor"></div><button id="accept">Accept selected change</button><button id="reject">Reject selected change</button><button id="reload">Reload saved HTML</button>';
const legacy = new URLSearchParams(location.search).has("legacy");
const span = (type: string, id: string, user: string, text: string) => `<span data-suggestion="${type}" data-suggestion-id="${id}" data-user="${user}" data-actor-id="alex@example.test" data-turn-id="turn-fixture">${text}</span>`;
const content = legacy
  ? '<p><span data-suggestion="insert" data-user="Alex">First</span><span data-suggestion="insert" data-user="Morgan">Second</span></p>'
  : `<p>${span("delete", "change-one", "Alex (agent)", "Old one")}${span("insert", "change-one", "Alex (agent)", "New one")}${span("delete", "change-two", "Alex (agent)", "Old two")}${span("insert", "change-two", "Alex (agent)", "New two")}</p>`;
const editor = new Editor({ element: document.getElementById("editor")!, extensions: [StarterKit, ...suggestionMarks(), SuggestionMode], content });
Object.assign(window, { prismSuggestionsFixture: {
  select(text: string) {
    let position: number | undefined;
    editor.state.doc.descendants((node, pos) => { if (node.isText && node.text?.includes(text)) position ??= pos + node.text.indexOf(text); });
    if (position === undefined) throw new Error("No matching fixture passage");
    editor.commands.setTextSelection(position);
  },
  html: () => editor.getHTML(),
} });
document.getElementById("accept")!.onclick = () => { editor.commands.acceptSuggestion(); };
document.getElementById("reject")!.onclick = () => { editor.commands.rejectSuggestion(); };
document.getElementById("reload")!.onclick = () => { editor.commands.setContent(editor.getHTML()); };
