# Companion header density · B01/A08 · October 2

The document companion now places its existing **New** action in the conversation heading row beside the title and Expand control. Compact header spacing is reduced; long titles wrap to at most two lines. The working-page chip and permissions remain visible below the title. New and Expand retain 44px targets. Full Agent workspace density is unchanged.

The source adds only a presentation slot to Conversation and moves the same AgentPanelChat callback/button into it. The existing Conversation key, provider, effects, session binding, permissions and composer behavior are untouched. Legacy native chat is unaffected.

Reviewed fictional captures:

- [Desktop after return from phone](evidence/companion-density/companion-active-1440-light.png) — sidebar remains collapsed following existing Shell behavior.
- [Short screen, 720×500 CSS pixels](evidence/companion-density/companion-active-720-light.png) — heading about 120px plus 48px companion tabs, approximately 50px less than the audited prior layout. This is a layout-space equivalent for 200% desktop reflow, not physical browser zoom.
- [Phone 390 dark](evidence/companion-density/companion-active-390-dark.png).
- [Long title and full permission selector at 320](evidence/companion-density/companion-long-title-320.png).

Eight dedicated Chromium/WebKit journeys pass. Actual Shell checks new and active conversations through 1440→390→720×500→320→1440, retaining the same editor DOM and unsent text. Companion actions meet 44px bounds. All three permission choices remain visible/usable in the capable compact fixture. New binds to the current document only on explicit activation and the previous session retains its unsent input. Fourteen existing responsive-companion/full-Agent visual journeys also pass. Core and aggregate fixture typechecks pass.

The first new-test run caught test-harness assumptions: the Shell intentionally closes its panel on the desktop→phone breakpoint; the test now awaits that state before opening it. A synthetic selected fixture session had no note until created through the UI; the corrected case uses that real creation flow. No product behavior was changed to accommodate those failures.

Adjacent finding: existing agent textarea height is recalculated on input, not width changes. A draft that gains wrapped lines after resize can be partly clipped inside its scrollable textarea. Draft contents are preserved. This was separately authorized and is now fixed by the follow-up described below; it was not part of the header commit. Physical-phone keyboard and production/native release checks remain root gates.


## Agent draft resize follow-up

AgentChat now uses the existing message composer autosizing hook, with its existing 40px minimum and 160px maximum. The shared hook accepts an optional minimum, leaving message replies at their existing 44px default. Width changes and restored visible fields trigger measurement; no extra React state or per-keystroke component rerenders are introduced. Send/IME handlers, permissions, session controller, persistence and transcript scroll policy are unchanged.

- [Actual Shell after resize, complete wrapped draft](evidence/companion-density/companion-active-390-dark-after-autosize.png).
- [WebKit, selected text preserved while wrapping](evidence/companion-density/agent-wrapped-draft-390-webkit.png). The top controls in this second image belong to the isolated fixture.

The combined agent-composer-growth, message-composer-growth and companion-density run passed all **28 Chromium/WebKit cases**. It covers wide→390→320→wide input identity, selection and focus; complete visible text below the cap; intentional internal scrolling above 160px; end typing and middle edits; shrink after shortening; IME Enter without sending; restored/scoped drafts and failed/confirmed message send behavior. Core and aggregate web fixture typechecks passed. Physical IME/device and production gates remain separate.
