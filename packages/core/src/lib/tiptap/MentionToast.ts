/**
 * One small live-region toast for mention actions that finish after the menu or
 * popover closed (reminder set / failed). DOM-only, no React root needed.
 */
let timer: ReturnType<typeof setTimeout> | undefined;
export function mentionToast(message: string, error = false): void {
  if (typeof document === "undefined") return;
  let el = document.getElementById("prism-mention-toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "prism-mention-toast";
    el.className = "prism-mention-toast";
    document.body.appendChild(el);
  }
  el.setAttribute("role", error ? "alert" : "status");
  el.dataset.error = error ? "true" : "false";
  el.textContent = message;
  el.hidden = false;
  clearTimeout(timer);
  timer = setTimeout(() => { if (el) el.hidden = true; }, 4000);
}
