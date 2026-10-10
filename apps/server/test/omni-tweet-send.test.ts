import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { runTweetSend, setTweetSpawnerForTests } from "../src/omni/tweet-send";
import { executorFor } from "../src/omni/approvals";
import type { Spawner } from "../src/omni/proton-send";
let calls: Parameters<Spawner>[];
let reply: Awaited<ReturnType<Spawner>>;
beforeEach(() => {
  calls = []; reply = { code: 0, signal: null, stdout: JSON.stringify({ status: "sent", postId: "123" }), stderr: "", timedOut: false };
  process.env.OMNI_TWEET_SEND = process.execPath;
  process.env.TEST_SECRET_TOKEN = "must-not-leave-parent";
  setTweetSpawnerForTests(async (...args) => { calls.push(args); return reply; });
});
afterEach(() => { setTweetSpawnerForTests(null); for (const k of ["OMNI_TWEET_SEND", "TEST_SECRET_TOKEN", "OMNI_EXECUTORS", "OMNI_EXECUTOR_KINDS"]) delete process.env[k]; });
test("exact approved text goes on stdin with fixed arguments and no server credentials", async () => {
  const text = '  text "quoted"\nnext line  ';
  const out = await runTweetSend({ text });
  assert.equal(out.status, "sent"); assert.equal(out.detail.postId, "123");
  assert.deepEqual(calls[0]![1], [process.execPath, "--approved-json"]);
  assert.equal(calls[0]![2].input, JSON.stringify({ text }));
  assert.equal(calls[0]![2].env.TEST_SECRET_TOKEN, undefined);
});
test("unconfigured executor and kind/global switches stay closed", () => {
  assert.equal(executorFor("tweet").enabled, true);
  process.env.OMNI_EXECUTOR_KINDS = "email"; assert.equal(executorFor("tweet").enabled, false);
  delete process.env.OMNI_EXECUTOR_KINDS; process.env.OMNI_EXECUTORS = "off"; assert.equal(executorFor("tweet").enabled, false);
  delete process.env.OMNI_EXECUTORS; process.env.OMNI_TWEET_SEND = "relative.py"; assert.equal(executorFor("tweet").enabled, false);
});
test("receipt is required; timeout, malformed output and provider ambiguity never become sent", async () => {
  for (const patch of [{ stdout: "garbage" }, { stdout: '{"status":"sent"}' }, { timedOut: true }, { signal: "SIGTERM" }, { code: 1 }]) {
    const prior = reply; reply = { ...prior, ...patch };
    assert.equal((await runTweetSend({ text: "hi" })).status, "unknown"); reply = prior;
  }
  reply = { ...reply, code: 1, stdout: '{"status":"failed","error":"provider_rejected"}', stderr: "private provider response" };
  const out = await runTweetSend({ text: "hi" }); assert.equal(out.status, "failed"); assert.ok(!JSON.stringify(out).includes("private"));
});
