import { test, after } from "node:test";
import assert from "node:assert/strict";
import { cancelVoice, setVoiceOutcomeSinkForTests, setVoiceProviderForTests, synthesizeVoice, VOICE_LIMITS, type VoiceOutcomeMetadata, type VoiceRequest } from "../src/omni/voice-synthesis";
const events: VoiceOutcomeMetadata[] = [];
setVoiceOutcomeSinkForTests(event => events.push(event));
after(() => { setVoiceOutcomeSinkForTests(null); setVoiceProviderForTests(null); });
let sequence = 0;
const request = (): VoiceRequest => ({ sessionID: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", requestID: `bbbbbbbb-bbbb-4bbb-bbbb-${String(++sequence).padStart(12,"0")}`, providerID: "hermes-edge", voiceID: "en-US-AriaNeural", text: "PRIVATE_FIXTURE_SENTINEL" });
const signal = () => new AbortController().signal;
const audio = new Uint8Array([0x49,0x44,0x33,0x04]);
test("one terminal success event includes only fixed metadata", async () => {
  setVoiceProviderForTests({ id: "hermes-edge", available: async () => true, synthesize: async () => audio });
  events.length = 0; const input = request(); await synthesizeVoice("PRIVATE_SCOPE", input, signal());
  assert.equal(events.length, 1); assert.equal(events[0]!.kind,"success"); assert.equal(events[0]!.stage,"delivery"); assert.equal(events[0]!.bytes,4);
  assert.deepEqual(Object.keys(events[0]!).sort(),["bytes","elapsedMs","kind","provider","stage","status"]);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE|aaaaaaaa|bbbbbbbb|Aria|mp3/);
});
test("rejected input, cancelled admission, unavailable and worker errors are content-free", async () => {
  events.length = 0;
  await assert.rejects(synthesizeVoice("scope",{...request(),providerID:"PRIVATE_PROVIDER_SENTINEL"},signal()));
  assert.equal(events.at(-1)!.provider,"unregistered"); assert.equal(events.at(-1)!.stage,"validation");
  const cancelled = request(); cancelVoice("scope",cancelled.sessionID,cancelled.requestID);
  await assert.rejects(synthesizeVoice("scope",cancelled,signal())); assert.equal(events.at(-1)!.kind,"cancelled");
  setVoiceProviderForTests({ id:"hermes-edge",available:async()=>false,synthesize:async()=>audio });
  await assert.rejects(synthesizeVoice("scope",request(),signal())); assert.equal(events.at(-1)!.stage,"availability"); assert.equal(events.at(-1)!.kind,"unavailable");
  setVoiceProviderForTests({ id:"hermes-edge",available:async()=>true,synthesize:async()=>{throw new Error("PRIVATE_EXCEPTION_SENTINEL");} });
  await assert.rejects(synthesizeVoice("scope",request(),signal())); assert.equal(events.at(-1)!.stage,"synthesis"); assert.equal(events.at(-1)!.kind,"failed");
  assert.equal(events.length,4); assert.doesNotMatch(JSON.stringify(events),/PRIVATE|aaaaaaaa|bbbbbbbb/);
});
test("busy rejection and timeout emit one event each; no cancel duplicates", async context => {
  events.length = 0;
  let begin!:()=>void; const began = new Promise<void>(resolve=>begin=resolve);
  setVoiceProviderForTests({id:"hermes-edge",available:async()=>true,synthesize:async(_input,abort)=>{begin();return new Promise(resolve=>abort.addEventListener("abort",()=>resolve(audio),{once:true}));}});
  context.mock.timers.enable({apis:["setTimeout"]});
  const pending = synthesizeVoice("scope",request(),signal()); await began;
  await assert.rejects(synthesizeVoice("scope",request(),signal()));
  assert.equal(events.length,1); assert.equal(events[0]!.status,429); assert.equal(events[0]!.stage,"admission");
  context.mock.timers.tick(VOICE_LIMITS.timeoutMs); await assert.rejects(pending);
  assert.equal(events.length,2); assert.equal(events[1]!.kind,"timeout"); assert.equal(events[1]!.status,504);
  context.mock.timers.reset();
});
test("a broken metadata sink never breaks synthesis", async () => {
  setVoiceOutcomeSinkForTests(()=>{throw new Error("diagnostic fixture");});
  setVoiceProviderForTests({id:"hermes-edge",available:async()=>true,synthesize:async()=>audio});
  assert.deepEqual(await synthesizeVoice("scope",request(),signal()),audio);
  setVoiceOutcomeSinkForTests(event=>events.push(event));
});
test("route validation rejection emits one safe metadata event", async () => {
  process.env.OMNI_ENABLED = "true";
  const { config } = await import("../src/config");
  const { makeSession, sessionCookie } = await import("./helpers");
  const { omniApi } = await import("../src/routes/omni");
  events.length = 0;
  const response = await omniApi.request("/voice/synthesis", {method:"POST",headers:{"content-type":"application/json",origin:config.appOrigin,cookie:sessionCookie(makeSession(config.ownerEmail))},body:JSON.stringify({...request(),providerID:"PRIVATE_INVALID_PROVIDER"})});
  assert.equal(response.status,400); assert.equal(events.length,1); assert.equal(events[0]!.provider,"unregistered"); assert.equal(events[0]!.kind,"rejected");
  assert.doesNotMatch(JSON.stringify(events),/PRIVATE|owner@|aaaaaaaa|bbbbbbbb/);
});
