// Prism Client host hook — injected by the Tauri shell as an initialization
// script, i.e. BEFORE the app bundle runs (docs/native-auth.md "Host hook").
// Implements the WP2.2 `window.__PRISM_HOST__` contract on top of the shell's
// own IPC commands. Kept dependency-free and tiny on purpose; it is the only
// JavaScript the shell adds to the page.
//
// The ORIGIN and PLATFORM placeholders below are replaced (JSON-escaped) by
// host.rs at startup. On iOS ORIGIN is "": the server can be set or cleared
// without a process restart there, so the live origin is read from the page's
// <meta name="prism-server-origin"> that the shell writes into every page it
// serves (window.rs). The CSP is the shell's either way.
(function () {
  "use strict";
  if (window.top !== window || window.__PRISM_HOST__) return;

  var ORIGIN = __PRISM_ORIGIN__;
  var PLATFORM = __PRISM_PLATFORM__;
  var IOS = PLATFORM === "ios";
  function currentOrigin() {
    if (!IOS) return ORIGIN;
    // Only the shell-written meta in <head> counts (never one in the body).
    var m = document.head && document.head.querySelector('meta[name="prism-server-origin"]');
    return (m && m.getAttribute("content")) || "";
  }
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
    get apiOrigin() {
      return currentOrigin();
    },
    getToken: function () {
      // The shell hands the token out only for the origin it is bound to.
      return ipc("get_token", { origin: currentOrigin() }).catch(function () {
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
      // iOS shows the system sign-in sheet over the app; no hint needed.
      if (!IOS) toast("Continue in your browser to sign in…");
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
    input.value = currentOrigin();
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

  // Incoming links (links.rs): the shell hands over ONE validated client path
  // ("/page/<id>", "/inbox[/<id>]", "/agent[/<id>]") — never a URL, and never
  // by navigating. It is held here until the signed-in app takes it (the app
  // may not have mounted yet), and announced with a payload-free DOM event so
  // the path can only come from this frozen object. Kept in memory only: a
  // link that nobody took before a reload is the shell's to deliver again.
  var pendingLink = null;
  function openLink(path) {
    if (typeof path !== "string" || path.length > 256 || path.charAt(0) !== "/") return;
    pendingLink = path;
    window.dispatchEvent(new CustomEvent("prism:open-link"));
  }
  function takePendingLink() {
    var p = pendingLink;
    pendingLink = null;
    return p;
  }

  // Export archives (export_archive.rs): the shell downloads the finished job's
  // ZIP itself and writes it where the user says in a native save panel (iOS:
  // hands it to the system share sheet, then deletes its copy). We pass
  // the job id and a suggested name — never a URL, a path or the token.
  // Resolves with the saved file's name, or null when the user cancelled.
  function saveExport(jobId, suggestedName) {
    return ipc("save_export", { jobId: String(jobId), suggestedName: String(suggestedName), cancel: false });
  }
  function cancelExportSave(jobId) {
    return ipc("save_export", { jobId: String(jobId), suggestedName: "", cancel: true }).catch(function () {
      return null;
    });
  }
  // WP5 (iOS): narrow wrappers over the iOS commands (capabilities/mobile.json).
  // Each is a fixed command with fixed, typed arguments; the shell validates
  // everything again and owns every native prompt (confirmation, Face ID).
  var ios = {
    // First run only (the shell refuses once a server is set).
    setServerOrigin: function (origin) {
      return ipc("set_server_origin", { origin: String(origin) });
    },
    // Native confirmation, revoke, forget; resolves false on Cancel.
    resetServer: function () {
      return ipc("reset_server");
    },
    appSettings: function () {
      return ipc("get_app_settings");
    },
    setAppLock: function (mode, minutes) {
      return ipc("set_app_lock", { mode: String(mode), minutes: minutes == null ? null : Number(minutes) });
    },
    pushRegister: function () {
      return ipc("push_register");
    },
    pushStatus: function () {
      return ipc("push_status");
    },
    // The validated client path ("/agent/<id>" or "/inbox/<id>") of the tapped
    // notification, or null (also while the app is locked).
    takeOpenedNotification: function () {
      return ipc("push_take_opened").catch(function () {
        return null;
      });
    },
  };

  Object.defineProperty(window, "__PRISM_SHELL__", {
    value: Object.freeze({
      platform: PLATFORM,
      showServerSettings: showServerSettings,
      signOut: signOut,
      toast: toast,
      notify: notify,
      exportNote: exportNote,
      openLink: openLink,
      takePendingLink: takePendingLink,
      saveExport: saveExport,
      cancelExportSave: cancelExportSave,
      ios: IOS ? Object.freeze(ios) : null,
    }),
    writable: false,
    configurable: false,
  });
})();
