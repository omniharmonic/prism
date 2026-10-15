import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
process.env.OMNI_ENABLED = "true";
import { config } from "../src/config";
import { resetDb } from "./helpers";
import { cardAlert } from "../src/omni/push-text";
import { cardNotification, cardPushAllowed } from "../src/omni/card-push";
import { localClock, withinQuietHours } from "../src/omni/nudge-policy";
import { parseCardInput, upsertCard, transitionCard, resetCardsForTests } from "../src/omni/cards";
import { listNudges, resetNudgesForTests, setNudgeSettings, upsertNudge, type Candidate } from "../src/omni/nudges";
import { syncAttentionPreferences } from "../src/omni/attention-preferences";
import { nudgesWithoutCards } from "../src/omni/nudge-delivery";
import { cardInput } from "./omni-card-samples";

const owner = config.ownerEmail;
const NOW = Date.UTC(2026, 9, 15, 18, 0);
const pad = (n: number) => String(n).padStart(2, "0");
beforeEach(() => { resetDb(); resetCardsForTests(); resetNudgesForTests(); });

test("card alert: title is the headline; the body is the context line plus what is ready, per preview", () => {
  const c = upsertCard(owner, parseCardInput(cardInput()), "t1", 1_000).card;
  assert.deepEqual(cardAlert(c, "generic", "An item needs your attention"), { title: "Omni", body: "An item needs your attention" });
  assert.deepEqual(cardAlert(c, "title", "g"), { title: c.headline, body: "2 options ready" });
  assert.deepEqual(cardAlert(c, "title_preview", "g"), { title: c.headline, body: "You have Thu 2–4 free · Grant deadline is Fri 5pm · 2 options ready" });
  const ready = transitionCard(owner, c.id, ["proposed"], "draft-ready", { action: "choose", optionId: "a" }, {}, 2_000)!;
  assert.equal(cardAlert(ready, "title_preview", "g").body, "You have Thu 2–4 free · Grant deadline is Fri 5pm · Draft ready to send");
});

test("card alert clips a 160-character headline to 80; the notification opens the card", () => {
  const headline = ("word ".repeat(31) + "end").trim();
  const c = upsertCard(owner, parseCardInput(cardInput({ headline })), "t1", 1_000).card;
  const alert = cardAlert(c, "title_preview", "g");
  assert.ok(Array.from(alert.title).length <= 80);
  assert.ok(alert.title.endsWith("…"));
  const n = cardNotification(c, "title", "g");
  const payload = n.payload as { url: string; category: string; aps: { category: string } };
  assert.equal(payload.url, `omni://card/${c.id}`);
  assert.equal(payload.category, "OMNI_CARD");
  assert.equal(n.collapseId, `omni-card-${c.id}`.slice(0, 64));
});

test("quiet hours, Off and the kill switch hold card pushes", () => {
  assert.equal(withinQuietHours("11:00-13:00", { hour: 12, minute: 0 }), true);
  assert.equal(withinQuietHours("13:00-14:00", { hour: 12, minute: 0 }), false);
  assert.equal(withinQuietHours("22:00-07:00", { hour: 12, minute: 0 }), false);
  assert.equal(withinQuietHours("22:00-07:00", { hour: 23, minute: 30 }), true);
  assert.equal(cardPushAllowed(owner, NOW), true);
  const clock = localClock(NOW);
  syncAttentionPreferences(owner, 1, { quiet_hours: `${pad(clock.hour)}:00-${pad((clock.hour + 1) % 24)}:00` });
  assert.equal(cardPushAllowed(owner, NOW), false);
  syncAttentionPreferences(owner, 2, {});
  setNudgeSettings(owner, { killed: true });
  assert.equal(cardPushAllowed(owner, NOW), false);
  setNudgeSettings(owner, { killed: false, dial: "off" });
  assert.equal(cardPushAllowed(owner, NOW), false);
});

test("a nudge whose item already has a card is not pushed on its own", () => {
  const cand: Candidate = { sourceId: "mail1", sourcePath: "mail/sam", kind: "reply-owed", title: "Sam is waiting", summary: "Budget review", reasons: ["Waiting"], senderId: null, baseScore: .7, priority: .5, deadline: null, urgentAt: null, commitment: false };
  upsertNudge(owner, cand);
  upsertNudge(owner, { ...cand, sourceId: "other1", sourcePath: "mail/other" });
  upsertCard(owner, parseCardInput(cardInput()), "t1", 1_000);
  assert.deepEqual(nudgesWithoutCards(owner, listNudges(owner)).map((n) => n.candidate.sourceId), ["other1"]);
});
