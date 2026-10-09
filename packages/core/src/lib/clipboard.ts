/**
 * The one place the app writes text to the clipboard.
 *
 * WHY: a browser lets a page write the clipboard only while the user's click / tap / key press
 * is still "live". WebKit (Safari, and the WKWebView the Prism Client runs in on macOS and iOS)
 * is strict about it: `navigator.clipboard.writeText()` called after an `await` — say, once the
 * server has created the share link — is refused with NotAllowedError, because the gesture is
 * over by then.
 *
 * THE RULE: call `copyText` SYNCHRONOUSLY in the event handler, before any `await`.
 *   - Text you already have:        `const ok = await copyText(link)`
 *   - Text that needs a round trip: `const pending = createLink(); const ok = await copyText(pending.then((l) => l.url))`
 *     (hand over the PROMISE; never `await` it first). The clipboard write is opened inside the
 *     gesture with the `ClipboardItem` promise form, which WebKit and Chromium accept, and is
 *     filled in when the text arrives.
 *
 * It resolves `true` only when a write really went through, `false` otherwise, and never throws
 * (a rejected text promise resolves `false`). Say "Copied" only on `true`; on `false` show the
 * text so it can be selected and copied by hand.
 *
 * Guard: `node apps/web/scripts/check-clipboard.mjs` — no other module may call
 * `navigator.clipboard.writeText` / `.write` or `document.execCommand`.
 */

/** Copy text. MUST be called synchronously inside the click / tap / key handler (see above). */
export function copyText(text: string | Promise<string>): Promise<boolean> {
  return typeof text === "string" ? copyNow(text) : copyPending(text);
}

const clipboard = (): Clipboard | undefined => (typeof navigator !== "undefined" ? navigator.clipboard : undefined);

/** Text in hand: the async API first (its call starts before this function's first `await`), then the legacy command. */
async function copyNow(text: string): Promise<boolean> {
  const clip = clipboard();
  if (typeof clip?.writeText === "function") {
    try {
      await clip.writeText(text);
      return true;
    } catch {
      /* refused (no gesture, no permission, document not focused): try the legacy command */
    }
  }
  return legacyCopy(text);
}

/** Text still on its way: open the write NOW, inside the gesture, and let the browser wait for the text. */
async function copyPending(pending: Promise<string>): Promise<boolean> {
  const clip = clipboard();
  if (typeof clip?.write === "function" && typeof ClipboardItem !== "undefined") {
    const blob = pending.then((text) => new Blob([text], { type: "text/plain" }));
    blob.catch(() => {}); // the failure is reported below, not as an unhandled rejection
    try {
      await clip.write([new ClipboardItem({ "text/plain": blob })]);
      return true;
    } catch {
      /* refused, or this browser's ClipboardItem takes no promise: try with the text itself */
    }
  }
  let text: string;
  try {
    text = await pending;
  } catch {
    return false; // there is nothing to copy
  }
  // The gesture may be over by now, so WebKit can refuse this too — the caller then shows the text.
  return copyNow(text);
}

/**
 * `document.execCommand("copy")` on a temporary selection. Deprecated, but it is the only other
 * way to reach the clipboard, and the only one where the async API is missing (an insecure
 * origin, an old web view). Focus and selection are put back afterwards.
 */
function legacyCopy(text: string): boolean {
  if (typeof document === "undefined" || typeof document.execCommand !== "function") return false;
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  // A text field keeps its own selection (and loses it to a restored document range), so it is
  // saved and restored as offsets; anywhere else (the editor, read-only text) as document ranges.
  const typing = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? active : null;
  let offsets: [number, number, "forward" | "backward" | "none"] | null = null;
  try {
    if (typing && typing.selectionStart !== null && typing.selectionEnd !== null) offsets = [typing.selectionStart, typing.selectionEnd, typing.selectionDirection ?? "none"];
  } catch {
    /* an input type without a text selection (email, number…) */
  }
  const selection = document.getSelection();
  const ranges: Range[] = [];
  for (let i = 0; !typing && selection && i < selection.rangeCount; i++) ranges.push(selection.getRangeAt(i));
  // Inside an open dialog the rest of the page is inert (and focus is trapped): the field must live in it.
  const host = active?.closest("dialog[open], [aria-modal='true'], [role='dialog']") ?? document.body;
  const field = document.createElement("textarea");
  field.value = text;
  field.readOnly = true; // no on-screen keyboard on phones
  field.setAttribute("aria-hidden", "true");
  field.tabIndex = -1;
  // Off-screen but rendered (a hidden field cannot be selected); 16px keeps iOS from zooming in.
  field.style.cssText = "position:fixed;top:0;left:-9999px;width:1px;height:1px;padding:0;border:0;opacity:0;font-size:16px;";
  let ok = false;
  try {
    host.appendChild(field);
    field.focus({ preventScroll: true });
    field.select();
    field.setSelectionRange(0, text.length); // iOS ignores select() on a readonly field
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  } finally {
    field.remove();
    try {
      active?.focus({ preventScroll: true });
      if (typing && offsets) typing.setSelectionRange(...offsets);
      else if (selection && ranges.length) {
        selection.removeAllRanges();
        for (const range of ranges) selection.addRange(range);
      }
    } catch {
      /* the old focus target is gone: nothing to restore */
    }
  }
  return ok;
}
