// Quick-capture window script (WP4.2). The ONLY thing this page can do is call
// the `quick_capture` command (capabilities/quick-capture.json): the shell POSTs
// the text with the stored device token. This page never sees the token.
// An empty text means "dismiss": the shell just closes the window.
(function () {
  "use strict";
  var text = document.getElementById("text");
  var save = document.getElementById("save");
  var cancel = document.getElementById("cancel");
  var status = document.getElementById("status");
  var busy = false;

  function invoke(cmd, args) {
    var t = window.__TAURI_INTERNALS__;
    if (!t || typeof t.invoke !== "function") return Promise.reject(new Error("The app shell is unavailable."));
    return t.invoke(cmd, args || {});
  }
  function say(msg, isErr) {
    status.textContent = msg || "";
    status.className = isErr ? "err" : "";
  }
  function dismiss() {
    invoke("quick_capture", { text: "" }).catch(function () {});
  }
  function submit() {
    if (busy) return;
    if (!text.value.trim()) {
      say("Type something to capture.", true);
      return;
    }
    busy = true;
    save.disabled = true;
    say("Saving…");
    invoke("quick_capture", { text: text.value }).then(
      function () {
        // The shell closes this window on success.
        say("Saved.");
      },
      function (e) {
        busy = false;
        save.disabled = false;
        say(String((e && (e.message || e)) || "Couldn't save."), true);
      }
    );
  }

  save.addEventListener("click", submit);
  cancel.addEventListener("click", dismiss);
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      e.preventDefault();
      dismiss();
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  });
  text.focus();
})();
