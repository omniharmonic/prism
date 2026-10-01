// Prism Client host hook — injected by the Tauri shell as an initialization
// script, i.e. BEFORE the app bundle runs (docs/native-auth.md "Host hook").
// Implements the WP2.2 `window.__PRISM_HOST__` contract on top of the shell's
// own IPC commands. Kept dependency-free and tiny on purpose; it is the only
// JavaScript the shell adds to the page.
//
// The ORIGIN placeholder below is replaced (JSON-escaped) by host.rs at startup.
(function () {
  "use strict";
  if (window.top !== window || window.__PRISM_HOST__) return;

  var ORIGIN = __PRISM_ORIGIN__;
  // Capture the IPC entry point as early as possible (Tauri's own init
  // scripts run before this one), so a later page script can't swap it out
  // from under the host hook.
  var invoke = null;
  function captureInvoke() {
    var t = window.__TAURI_INTERNALS__;
    if (!invoke && t && typeof t.invoke === "function") invoke = t.invoke.bind(t);
    return invoke;
  }
  captureInvoke();

  function ipc(cmd, args) {
    var f = captureInvoke();
    if (!f) return Promise.reject(new Error("Prism host IPC is unavailable"));
    return f(cmd, args || {});
  }

  // ---- tiny UI helpers (no framework; styles inline) -----------------------
  function el(tag, style, text) {
    var e = document.createElement(tag);
    if (style) e.setAttribute("style", style);
    if (text != null) e.textContent = text;
    return e;
  }

  var toastTimer = null;
  function toast(message) {
    var id = "prism-host-toast";
    var t = document.getElementById(id);
    if (!t) {
      t = el(
        "div",
        "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;" +
          "max-width:min(520px,90vw);padding:10px 14px;border-radius:10px;background:rgba(20,20,24,.96);" +
          "color:#fff;font:13px -apple-system,system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.4)"
      );
      t.id = id;
      (document.body || document.documentElement).appendChild(t);
    }
    t.textContent = String(message);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      if (t && t.parentNode) t.parentNode.removeChild(t);
    }, 6000);
  }

  function errText(e) {
    return (e && (e.message || e)) + "";
  }

  // ---- the host contract ----------------------------------------------------
  var host = {
    apiOrigin: ORIGIN,
    getToken: function () {
      return ipc("get_token").catch(function () {
        return null;
      });
    },
    onUnauthorized: function () {
      // The server rejected the token: forget it locally (it is dead anyway).
      return ipc("sign_out", { revoke: false }).catch(function () {});
    },
    signIn: function () {
      // A second click restarts the flow (the shell cancels the previous one),
      // e.g. after the user closed the browser tab.
      toast("Continue in your browser to sign in…");
      return ipc("sign_in").then(
        function () {
          // Re-boot so the auth gate re-checks /auth/me with the new token.
          window.location.reload();
        },
        function (e) {
          var msg = errText(e);
          if (!/cancelled/i.test(msg)) toast("Sign-in failed: " + msg);
        }
      );
    },
    onSignedOut: function () {
      // The app already revoked the token server-side (POST /auth/device/revoke).
      return ipc("sign_out", { revoke: false }).catch(function (e) {
        toast(errText(e));
      });
    },
  };
  Object.defineProperty(window, "__PRISM_HOST__", { value: Object.freeze(host), writable: false, configurable: false });

  // ---- external links ------------------------------------------------------
  // The shell cancels every navigation away from the bundle (window.rs), so
  // links and window.open() to http(s)/mailto are routed here instead: the
  // shell shows a NATIVE confirmation with the URL before opening anything.
  function isExternal(href) {
    return /^(https?:|mailto:)/i.test(href) && !/^https?:\/\/tauri\.localhost(\/|$)/i.test(href);
  }
  function openExternal(href) {
    return ipc("open_external", { url: href }).catch(function (e) {
      toast(errText(e));
    });
  }
  document.addEventListener(
    "click",
    function (e) {
      if (e.defaultPrevented || e.button !== 0) return;
      var t = e.target;
      var a = t && t.closest ? t.closest("a[href]") : null;
      if (!a) return;
      var href = a.href; // resolved absolute URL
      if (!isExternal(href)) return;
      e.preventDefault();
      openExternal(href);
    },
    true
  );
  var nativeOpen = window.open;
  window.open = function (url) {
    var href = "";
    try {
      href = url == null ? "" : new URL(String(url), window.location.href).href;
    } catch (err) {
      href = "";
    }
    if (isExternal(href)) {
      openExternal(href);
      return null;
    }
    return nativeOpen.apply(window, arguments);
  };

  // ---- shell-only UI driven from the native menu ----------------------------
  // "Server settings…" opens this. `grant` is a single-use nonce the shell
  // minted for this menu click; set_server_origin refuses without it. It is
  // NOT the security boundary (page script could alter what this form
  // submits): the shell always shows a native confirmation with the exact
  // origin it will save, and saves only on the user's click there.
  function showServerSettings(grant) {
    var existing = document.getElementById("prism-host-settings");
    if (existing) existing.parentNode.removeChild(existing);

    var overlay = el(
      "div",
      "position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,.55);display:flex;" +
        "align-items:center;justify-content:center;font:14px -apple-system,system-ui,sans-serif"
    );
    overlay.id = "prism-host-settings";
    var card = el(
      "form",
      "width:min(440px,92vw);padding:22px;border-radius:14px;background:#16161a;color:#eee;" +
        "box-shadow:0 20px 60px rgba(0,0,0,.5);display:flex;flex-direction:column;gap:12px"
    );
    card.appendChild(el("div", "font-size:17px;font-weight:600", "Prism Server"));
    card.appendChild(
      el(
        "div",
        "font-size:12px;opacity:.7;line-height:1.45",
        "The only server this app talks to. Changing it restarts the app; each server keeps its own sign-in."
      )
    );
    var input = el(
      "input",
      "padding:9px 10px;border-radius:8px;border:1px solid #333;background:#0d0d10;color:#fff;font:inherit"
    );
    input.type = "url";
    input.value = ORIGIN;
    input.spellcheck = false;
    input.setAttribute("autocapitalize", "off");
    card.appendChild(input);
    var err = el("div", "font-size:12px;color:#ff8080;min-height:1em");
    card.appendChild(err);
    var row = el("div", "display:flex;gap:8px;justify-content:flex-end");
    var cancel = el("button", "padding:8px 12px;border-radius:8px;border:1px solid #333;background:transparent;color:#ddd;cursor:pointer", "Cancel");
    cancel.type = "button";
    var save = el("button", "padding:8px 12px;border-radius:8px;border:none;background:#4f8ff7;color:#fff;font-weight:600;cursor:pointer", "Save & restart");
    save.type = "submit";
    row.appendChild(cancel);
    row.appendChild(save);
    card.appendChild(row);
    overlay.appendChild(card);

    function close() {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }
    cancel.onclick = close;
    overlay.addEventListener("keydown", function (e) {
      if (e.key === "Escape") close();
    });
    card.onsubmit = function (e) {
      e.preventDefault();
      err.textContent = "";
      save.disabled = true;
      ipc("set_server_origin", { origin: input.value, grant: grant }).then(
        function (normalized) {
          err.style.color = "#8fd18f";
          err.textContent = "Saved " + normalized + ". Restarting…";
        },
        function (e2) {
          var msg = errText(e2);
          // Past validation the grant is spent (confirmed or not): close.
          if (/^(Server not changed|Open Server Settings)/.test(msg)) {
            close();
            toast(msg);
            return;
          }
          save.disabled = false; // a validation error: fix the address and retry
          err.textContent = msg;
        }
      );
    };
    (document.body || document.documentElement).appendChild(overlay);
    input.focus();
    input.select();
  }

  // Menu "Sign Out": revoke server-side + forget locally (sign_out), drop the
  // offline read cache (apps/web offline/readCache.ts), then reboot into the
  // sign-in screen. Same end state as the in-app logout().
  function signOut() {
    function reload() {
      window.location.reload();
    }
    function dropCache() {
      try {
        var r = indexedDB.deleteDatabase("prism-read-cache");
        // blocked = the app still has it open; the delete completes on unload.
        r.onsuccess = r.onerror = r.onblocked = reload;
      } catch (e) {
        reload();
      }
    }
    return ipc("sign_out", { revoke: true }).then(dropCache, function (e) {
      toast("Sign-out: " + errText(e));
      dropCache();
    });
  }

  // WP4.2: narrow wrappers over the two main-window commands. The shell
  // sanitises/caps everything (notify) and picks the destination itself
  // (exportNote: native save panel; no path ever comes from here).
  function notify(title, body, sessionId) {
    return ipc("notify", { title: String(title), body: String(body), sessionId: sessionId || null }).catch(function () {
      return false;
    });
  }
  function exportNote(content, suggestedName, format) {
    return ipc("export_note", { content: String(content), suggestedName: String(suggestedName), format: String(format) });
  }

  Object.defineProperty(window, "__PRISM_SHELL__", {
    value: Object.freeze({
      showServerSettings: showServerSettings,
      signOut: signOut,
      toast: toast,
      notify: notify,
      exportNote: exportNote,
    }),
    writable: false,
    configurable: false,
  });
})();
