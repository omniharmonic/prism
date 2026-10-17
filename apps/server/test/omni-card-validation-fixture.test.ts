import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseCardInput } from "../src/omni/cards";

/** One contract, a copy in each repo, like vault-shapes.json: this file and the agent's
 *  tests/fixtures/server_cards.json (read by tests/test_proactive_cards.py) are byte-identical.
 *  Change them together. Each case is a card as the agent hands it over; the publisher adds
 *  sourceKey and itemRefs = [event.id]. `valid` is the server's verdict. */
const fixture = JSON.parse(readFileSync(new URL("./fixtures/omni-card-validation.json", import.meta.url), "utf8")) as {
  event: { id: string; revision: string };
  cases: Array<{ name: string; valid: boolean; card: Record<string, unknown> }>;
};

test("parseCardInput gives the verdict the shared fixture records for every case", () => {
  assert.ok(fixture.cases.length > 50);
  for (const c of fixture.cases) {
    let accepted = true;
    try {
      parseCardInput({ ...c.card, sourceKey: fixture.event.id, sourceRevision: fixture.event.revision, itemRefs: [fixture.event.id] });
    } catch {
      accepted = false;
    }
    assert.equal(accepted, c.valid, c.name);
  }
});
