import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
process.env.OMNI_ENABLED = "true";
import { config } from "../src/config";
import { resetDb } from "./helpers";
import { cardView, parseCardInput, resetCardsForTests, transitionCard, upsertCard } from "../src/omni/cards";
import { transitionalCardView } from "../src/omni/card-flow";
import { resetNudgesForTests, upsertNudge } from "../src/omni/nudges";
import { cardInput } from "./omni-card-samples";

/** The JSON PrismKit's `OmniCard` decodes (swift/PrismKit/Tests/PrismModelsTests/Fixtures/omni-cards.json).
 *  If this fails, the wire shape changed: update the fixture AND `OmniCards.swift` together. */
const fixture = JSON.parse(readFileSync(new URL("../../../swift/PrismKit/Tests/PrismModelsTests/Fixtures/omni-cards.json", import.meta.url), "utf8")) as Record<string, Record<string, unknown>>;
const T0 = Date.UTC(2026, 9, 15, 16, 0);
const named = (v: Record<string, unknown>, ids: Record<string, string>) => JSON.parse(JSON.stringify(v, (k, x) => (typeof x === "string" && ids[x] ? ids[x] : x))) as Record<string, unknown>;
beforeEach(() => { resetDb(); resetCardsForTests(); resetNudgesForTests(); });

test("cardView of a proposed and a draft-ready card is exactly the Swift fixture", () => {
  const { card } = upsertCard(config.ownerEmail, parseCardInput(cardInput()), "omni-proactive-fixture", T0);
  assert.deepEqual(named(cardView(card, T0), { [card.id]: "card_fixture" }), fixture.proposed);
  const ready = transitionCard(config.ownerEmail, card.id, ["proposed"], "draft-ready", { action: "choose", optionId: "a" }, { chosenOptionId: "a", approvalId: "apr_fixture" }, T0 + 60_000)!;
  assert.deepEqual(named(cardView(ready, T0 + 60_000), { [card.id]: "card_fixture" }), fixture.draftReady);
});

test("a transitional nudge card is exactly the Swift fixture", () => {
  const n = upsertNudge(config.ownerEmail, { sourceId: "mail9", sourcePath: "mail/ana", kind: "reply-owed", title: "Ana is waiting on the venue answer", summary: "She asked whether the barn is free on the 24th.", reasons: ["Waiting"], senderId: null, baseScore: .7, priority: .5, deadline: null, urgentAt: null, commitment: false }, T0);
  assert.deepEqual(named(transitionalCardView(n, T0), { [n.id]: "nud_fixture" }), fixture.transitional);
});
