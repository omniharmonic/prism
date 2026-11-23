/** A short, self-dismissing message from editor plumbing that has no React host (role=alert / status). */
export function editorNotice(text: string, kind: "alert" | "status" = "alert"): void {
  if (typeof document === "undefined") return;
  document.querySelectorAll(".block-notice[data-editor-notice]").forEach((el) => el.remove());
  const el = document.createElement("div");
  el.className = "block-notice";
  el.setAttribute("data-editor-notice", "");
  el.setAttribute("role", kind);
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), Math.max(4000, text.length * 70));
}
