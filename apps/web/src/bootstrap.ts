/** Small startup boundary: failures importing the app must not leave a blank window. */
function showStartupFailure(): void {
  const root = document.getElementById("root");
  if (!root) return;
  const panel = document.createElement("div");
  panel.style.cssText = "max-width:440px;margin:15vh auto;padding:24px;font:15px system-ui,sans-serif;line-height:1.6";
  panel.setAttribute("role", "alert");
  const title = document.createElement("h1");
  title.textContent = "Prism couldn’t start";
  title.style.fontSize = "24px";
  const detail = document.createElement("p");
  detail.textContent = "Reload to try again. Your saved workspace has not been removed.";
  const retry = document.createElement("button");
  retry.type = "button";
  retry.textContent = "Reload Prism";
  retry.style.cssText = "padding:10px 16px;border-radius:8px;cursor:pointer";
  retry.onclick = () => window.location.reload();
  panel.append(title, detail, retry);
  root.replaceChildren(panel);
}

// The web-font sheet is preloaded by index.html (so it never blocks the first paint);
// apply it now. Text is already readable in the fallback fonts.
const fonts = document.getElementById("prism-web-fonts");
if (fonts instanceof HTMLLinkElement && fonts.rel !== "stylesheet") { fonts.removeAttribute("as"); fonts.rel = "stylesheet"; }

void import("./main").then(({ start }) => start()).catch((error: unknown) => {
  console.error("Prism startup failed", error);
  showStartupFailure();
});
