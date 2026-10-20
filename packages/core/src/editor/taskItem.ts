import TaskItem from "@tiptap/extension-task-item";
import { Plugin, PluginKey } from "@tiptap/pm/state";

/**
 * The to-do item of BOTH editors (same name and schema as TipTap's — no schema change).
 *
 * TipTap's checkbox `change` handler runs `editor.chain().focus().command(setNodeMarkup)`. On
 * Safari (and iOS / Android) the `focus` command focuses the editor's DOM SYNCHRONOUSLY when the
 * editor does not have focus; the core FocusEvents plugin answers that focus event with a
 * transaction of its own, so the chain's transaction — built on the state before it — is refused
 * ("Applying a mismatched transaction") and the box is drawn ticked while the page keeps it
 * unticked (nothing saved). Ticking a to-do right after opening a page, with the caret nowhere,
 * did that in Safari and in the iOS app.
 *
 * The fix: focus the editor in the CAPTURE phase of that `change` (it runs before the checkbox's
 * own listener), so the focus transaction is dispatched first and the chain finds the editor
 * focused (`focus` is then a no-op). Suggesting mode stops the click before any `change`, so it
 * still refuses the box (editor/suggestions.ts).
 */
export const PrismTaskItem = TaskItem.extend({
  addProseMirrorPlugins() {
    const parent = this.parent?.() ?? [];
    return [
      ...parent,
      new Plugin({
        key: new PluginKey("prismTaskItemFocus"),
        view(view) {
          const onChange = (event: Event) => {
            const target = event.target;
            if (!(target instanceof HTMLInputElement) || target.type !== "checkbox") return;
            if (!target.closest('li[data-type="taskItem"], ul[data-type="taskList"] > li')) return;
            if (!view.editable || view.hasFocus()) return;
            view.focus();
          };
          view.dom.addEventListener("change", onChange, true);
          return { destroy: () => view.dom.removeEventListener("change", onChange, true) };
        },
      }),
    ];
  },
});
