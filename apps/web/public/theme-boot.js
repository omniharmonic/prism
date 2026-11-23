/* First-paint theme (NP-AX-01). A CLASSIC script in <head>, so it runs before the body is
   painted; it is a file, not inline, because the CSP is `script-src 'self'`.
   Keep in step with packages/core/src/app/stores/settings.ts (storage key "prism-settings",
   the "system" rule, THEME_COLORS). No stored choice = System. */
(function () {
  var theme = "system";
  try {
    var raw = window.localStorage.getItem("prism-settings");
    var stored = raw ? JSON.parse(raw) : null;
    var value = stored && stored.state && stored.state.theme;
    if (value === "light" || value === "dark") theme = value;
  } catch (e) { /* private mode / corrupt entry: follow the system */ }
  var light = theme === "light";
  if (theme === "system") {
    try { light = !!window.matchMedia && !window.matchMedia("(prefers-color-scheme: dark)").matches && window.matchMedia("(prefers-color-scheme: light)").matches; } catch (e) { light = false; }
  }
  var list = document.documentElement.classList;
  list.toggle("light", light);
  list.toggle("dark", !light);
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", light ? "#f4f4f6" : "#0a0a0b");
})();
