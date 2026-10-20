/**
 * While an editor popup list (slash, @, [[) is open, focus stays in the editing surface and the
 * active option is named through `aria-activedescendant`. Those attributes only mean something on
 * an element with a widget role, and the bare contenteditable has none — so for exactly that time
 * the surface is a named multi-line textbox that controls the list. Everything set here is removed
 * again by the returned cleanup (a role or label the editor already carried is left alone).
 */
export function describeEditorPopup(dom: HTMLElement, listId: string, activeId?: string): () => void {
  const set: string[] = [];
  const put = (name: string, value: string, keep = false) => {
    if (keep && dom.hasAttribute(name)) return;
    dom.setAttribute(name, value);
    set.push(name);
  };
  put("role", "textbox", true);
  put("aria-multiline", "true", true);
  if (!dom.hasAttribute("aria-labelledby")) put("aria-label", "Page content", true);
  put("aria-haspopup", "listbox");
  put("aria-controls", listId);
  put("aria-autocomplete", "list");
  if (activeId) put("aria-activedescendant", activeId);
  return () => { for (const name of set) dom.removeAttribute(name); };
}
