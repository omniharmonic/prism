/**
 * The shareable in-app address of a page (a client route: `/page/<id>`). Its own import-free
 * module: low-level code (heading links, the ⌘L shortcut) needs it, and importing the
 * `usePageActions` hub from there closes an initialisation cycle that stops the app booting
 * ("Cannot access 'VaultRequestError' before initialization").
 */
export const pageLink = (id: string): string => {
  // Prism Client: the app origin is the Tauri shell; a shareable link names the SERVER.
  const host = typeof window !== "undefined" ? (window as unknown as { __PRISM_HOST__?: { apiOrigin?: string } }).__PRISM_HOST__ : undefined;
  const origin = host?.apiOrigin && /^https?:\/\//.test(host.apiOrigin) ? host.apiOrigin.replace(/\/+$/, "") : typeof location !== "undefined" ? location.origin : "";
  return `${origin}/page/${encodeURIComponent(id)}`;
};
