# Companion header density · B01/A08 · October 2

The document companion now places its existing **New** action in the conversation heading row beside the title and Expand control. Compact header spacing is reduced; long titles wrap to at most two lines. The working-page chip and permissions remain visible below the title. New and Expand retain44px targets. Full Agent workspace density is unchanged.

The source adds only a presentation slot to Conversation and moves the same AgentPanelChat callback/button into it. The existing Conversation key, provider, effects, session binding, permissions and composer behavior are untouched. Legacy native chat is unaffected.

Reviewed fictional captures:

- [Desktop after return from phone](evidence/companion-density/companion-active-1440-light.png) — sidebar remains collapsed following existing Shell behavior.
- [Short screen,720×500 CSS pixels](evidence/companion-density/companion-active-720-light.png) — heading about120px plus48px companion tabs, approximately50px less than the audited prior layout. This is a layout-space equivalent for200% desktop reflow, not physical browser zoom.
- [Phone390 dark](evidence/companion-density/companion-active-390-dark.png).
- [Long title and full permission selector at320](evidence/companion-density/companion-long-title-320.png).

Eight dedicated Chromium/WebKit journeys pass. Actual Shell checks new and active conversations through1440→390→720×500→320→1440, retaining the same editor DOM and unsent text. Companion actions meet44px bounds. All three permission choices remain visible/usable in the capable compact fixture. New binds to the current document only on explicit activation and the previous session retains its unsent input. Fourteen existing responsive-companion/full-Agent visual journeys also pass. Core and aggregate fixture typechecks pass.

The first new-test run caught test-harness assumptions: the Shell intentionally closes its panel on the desktop→phone breakpoint; the test now awaits that state before opening it. A synthetic selected fixture session had no note until created through the UI; the corrected case uses that real creation flow. No product behavior was changed to accommodate those failures.

Adjacent finding: existing agent textarea height is recalculated on input, not width changes. A draft that gains wrapped lines after resize can be partly clipped inside its scrollable textarea. Draft contents are preserved. This is recorded for a separately authorized follow-up; it is not fixed by the header commit. Physical-phone keyboard and production/native release checks remain root gates.
