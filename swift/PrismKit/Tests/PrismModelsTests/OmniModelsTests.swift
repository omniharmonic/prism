import Foundation
import PrismModels
import XCTest

final class OmniModelsTests: XCTestCase {
    func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try PrismJSON.decoder().decode(T.self, from: Data(json.utf8))
    }

    func testThreadFromTheDocumentedShape() throws {
        let t = try decode(OmniThread.self, #"""
        {"id":"omni_3f","title":"Call Dana","state":"working","objective":null,"taskNoteId":null,"lastActivityAt":"2026-10-08T15:04:00.000Z",
         "unread":0,"pinned":false,"archived":false,"nextCheckAt":null,"waitingOn":null,"model":"gpt-5-codex","preview":"…","messageCount":6,
         "running":true,"lastSeq":12,"source":"text"}
        """#)
        XCTAssertEqual(t.id, "omni_3f")
        XCTAssertEqual(t.state, .working)
        XCTAssertEqual(t.lastSeq, 12)
        XCTAssertTrue(t.running)
        XCTAssertEqual(t.lastActivityAt, PrismJSON.parseDate("2026-10-08T15:04:00Z"))
    }

    func testThreadToleratesASparseRowAndAnUnknownState() throws {
        // A Hermes-only session listed while the local row is missing: many nulls.
        let t = try decode(OmniThread.self, #"{"id":"sess-1","title":null,"state":"paused-by-future-server","lastActivityAt":null,"messageCount":null,"source":"hermes","somethingNew":1}"#)
        XCTAssertEqual(t.state.rawValue, "paused-by-future-server")
        XCTAssertFalse(ThreadState.allKnown.contains(t.state))
        XCTAssertEqual(t.unread, 0)
        XCTAssertNil(t.lastActivityAt)
    }

    func testThreadDetailWithMessagesCardsAndApprovals() throws {
        let d = try decode(ThreadDetail.self, #"""
        {"thread":{"id":"omni_a","state":"needs-you","unread":0,"pinned":true,"archived":false,"running":false,"lastSeq":4},
         "messages":[{"id":"m1","role":"user","text":"draft it","at":"2026-10-08T15:00:00.000Z"},
                     {"id":17,"role":"assistant","text":"Done.","at":"2026-10-08T15:00:05.000Z"},
                     {"id":null,"role":"tool","toolName":"prism_create_note","at":null}],
         "cards":[{"kind":"record","noteId":"01J","op":"created","type":"task","title":"Call Dana Friday","path":"vault/tasks/call-dana","tags":["task"],
                   "icon":null,"summary":"Created · properties status, due","changedKeys":["status","due"],"bodyDelta":{"chars":120},
                   "writer":{"kind":"agent","label":"Omni"},"updatedAt":"2026-10-08T15:00:04Z","threadId":"omni_a",
                   "links":{"prism":"https://prism.example.com/page/01J","prismApp":"prism://page/01J","omni":"omni://record/01J"},"private":false}],
         "approvals":[],"activeTurnId":null}
        """#)
        XCTAssertEqual(d.messages.map(\.id), ["m1", "17", nil])
        XCTAssertEqual(d.messages.map(\.role), [.user, .assistant, .tool])
        XCTAssertEqual(d.messages[2].toolName, "prism_create_note")
        XCTAssertNil(d.messages[2].text)
        let card = d.cards[0]
        XCTAssertEqual(card.op, .created)
        XCTAssertEqual(card.links?.prismApp, "prism://page/01J")
        XCTAssertEqual(card.bodyDelta?.chars, 120)
        XCTAssertEqual(card.writer?.isAgent, true)
        XCTAssertEqual(card.private, false)
        XCTAssertNil(d.activeTurnId)
    }

    func testACardFromADeleteHasAlmostNothing() throws {
        let c = try decode(RecordCard.self, #"{"kind":"record","noteId":"01J","op":"deleted","type":"page","title":"01J","path":null,"tags":[],"icon":null,"summary":"Deleted","changedKeys":[],"writer":{"kind":"external","label":"Omni (vault)"},"updatedAt":null,"threadId":"omni_a","links":{"prism":"x","prismApp":"y","omni":"z"},"private":false}"#)
        XCTAssertEqual(c.op, .deleted)
        XCTAssertNil(c.bodyDelta)
        XCTAssertEqual(c.writer?.isAgent, false)
    }

    func testRequestBodiesOmitUnsetFields() throws {
        let patch = try PrismJSON.decoder().decode(JSONValue.self, from: PrismJSON.encoder().encode(ThreadPatch(pinned: true, unread: false)))
        XCTAssertEqual(patch, ["pinned": true, "unread": false], "PATCH refuses unknown keys, and null is not 'unset'")
        let new = try PrismJSON.decoder().decode(JSONValue.self, from: PrismJSON.encoder().encode(NewThread(prompt: "hi", noteIds: ["01J"])))
        XCTAssertEqual(new, ["prompt": "hi", "noteIds": ["01J"]])
        let job = try PrismJSON.decoder().decode(JSONValue.self, from: PrismJSON.encoder().encode(NewJob(name: "brief", schedule: "0 7 * * *", prompt: "morning brief")))
        XCTAssertEqual(job, ["name": "brief", "schedule": "0 7 * * *", "prompt": "morning brief"])
    }

    func testJobsKeepHermesShapes() throws {
        let list = try decode(JobList.self, #"{"jobs":[{"id":"0123456789ab","name":"brief","schedule":{"kind":"cron","expr":"0 7 * * *"},"enabled":true,"paused":false,"next_run_at":"2026-10-09T13:00:00Z","last_run_at":1760000000,"last_status":"ok","last_error":null,"deliver":"origin","skills":["brief"],"repeat":{"times":null}},{"id":"ba9876543210","schedule":"every 2h"}]}"#)
        XCTAssertEqual(list.jobs[0].schedule?["expr"]?.stringValue, "0 7 * * *")
        XCTAssertEqual(list.jobs[0].lastStatus, "ok")
        XCTAssertEqual(list.jobs[0].lastRunAt?.intValue, 1_760_000_000)
        XCTAssertEqual(list.jobs[0].nextRunAt?.stringValue, "2026-10-09T13:00:00Z")
        XCTAssertEqual(list.jobs[1].schedule?.stringValue, "every 2h")
        XCTAssertNil(list.jobs[1].enabled)
    }

    func testTodayWithAFailedSection() throws {
        let t = try decode(OmniToday.self, #"""
        {"date":"2026-10-08","agenda":null,
         "tasks":[{"noteId":"t1","title":"Call Dana","status":"todo","due":"2026-10-09","priority":"high","threadId":null,"link":"https://prism.example.com/page/t1"}],
         "taskIdentity":"person","needsYou":{"approvals":[],"nudges":[]},
         "inFlight":[{"id":"omni_a","title":"Call Dana","state":"working","lastActivityAt":"2026-10-08T15:04:00.000Z"}],
         "openLoops":null,"brief":null,"errors":{"agenda":"query_502"}}
        """#)
        XCTAssertNil(t.agenda)
        XCTAssertEqual(t.errors["agenda"], "query_502")
        XCTAssertEqual(t.tasks?.first?.due, "2026-10-09")
        XCTAssertEqual(t.inFlight.first?.state, .working)
        XCTAssertEqual(t.needsYou.nudges, [])
        XCTAssertNil(t.brief)
    }

    func testStreamEnvelopes() throws {
        func e(_ name: String, _ data: String) -> OmniStreamEnvelope? { OmniStreamEnvelope.decode(eventName: name, data: data) }
        XCTAssertEqual(e("init", #"{"seq":1,"turnId":"turn_1","t":"init","runId":"run_9"}"#), OmniStreamEnvelope(seq: 1, turnId: "turn_1", event: .initialized(runId: "run_9")))
        let delta = try XCTUnwrap(e("text_delta", #"{"turnId":"turn_1","t":"text_delta","blockId":"turn_1:b0","text":"Hel"}"#))
        XCTAssertNil(delta.seq)
        XCTAssertFalse(delta.isPersisted)
        XCTAssertEqual(delta.event, .textDelta(blockId: "turn_1:b0", text: "Hel"))
        XCTAssertEqual(e("text", #"{"seq":2,"turnId":"turn_1","t":"text","blockId":"turn_1:b0","text":"Hello"}"#)?.event, .text(blockId: "turn_1:b0", text: "Hello"))
        XCTAssertEqual(e("tool_use", #"{"seq":3,"turnId":"turn_1","t":"tool_use","id":"turn_1:t1","name":"prism_create_note","input":{"path":"a/b","token":"[redacted]"}}"#)?.event,
                       .toolUse(id: "turn_1:t1", name: "prism_create_note", input: ["path": "a/b", "token": "[redacted]"]))
        XCTAssertEqual(e("tool_result", #"{"seq":4,"turnId":"turn_1","t":"tool_result","toolUseId":"turn_1:t1","ok":true,"summary":"ok"}"#)?.event, .toolResult(toolUseId: "turn_1:t1", ok: true, summary: "ok"))
        XCTAssertEqual(e("status", #"{"seq":5,"turnId":null,"t":"status","state":"needs-you","reason":"agent_message"}"#), OmniStreamEnvelope(seq: 5, turnId: nil, event: .status(state: .needsYou, reason: "agent_message")))
        XCTAssertEqual(e("result", #"{"seq":6,"turnId":"turn_1","t":"result","ok":false,"durationMs":1234,"errorCode":"cancelled"}"#)?.event, .result(ok: false, durationMs: 1234, errorCode: "cancelled"))
        // The SSE event name is the fallback when `t` is missing.
        XCTAssertEqual(e("status", #"{"seq":7,"state":"done"}"#)?.event, .status(state: .done, reason: nil))
        // A type from a newer server, and a known type with the wrong shape: kept, not thrown.
        guard case .unknown(let type, let payload)? = e("voice_chunk", #"{"seq":8,"t":"voice_chunk","x":1}"#)?.event else { return XCTFail() }
        XCTAssertEqual(type, "voice_chunk")
        XCTAssertEqual(payload["x"], .int(1))
        guard case .unknown("text", _)? = e("text", #"{"seq":9,"t":"text","blockId":7}"#)?.event else { return XCTFail() }
        XCTAssertEqual(e("card", #"{"seq":10,"t":"card","card":{"nope":true}}"#)?.seq, 10)
        XCTAssertNil(e("text", "not json"))
        XCTAssertNil(e("text", "[1,2]"))
    }
}

final class TurnTranscriptTests: XCTestCase {
    func env(_ seq: Int?, _ event: OmniStreamEvent, turn: String = "turn_1") -> OmniStreamEnvelope { OmniStreamEnvelope(seq: seq, turnId: turn, event: event) }

    func testDeltasThenFinalReplacement() {
        var t = TurnTranscript()
        XCTAssertTrue(t.apply(env(1, .status(state: .working, reason: nil))))
        XCTAssertTrue(t.apply(env(2, .initialized(runId: "run_1"))))
        t.apply(env(nil, .textDelta(blockId: "turn_1:b0", text: "Hel")))
        t.apply(env(nil, .textDelta(blockId: "turn_1:b0", text: "lo wor")))
        XCTAssertEqual(t.items, [.text(blockId: "turn_1:b0", text: "Hello wor", isFinal: false)])
        XCTAssertEqual(t.lastSeq, 2, "live deltas never move the resume cursor")
        // The final text REPLACES what the deltas built (it is the scrubbed, capped truth).
        t.apply(env(3, .text(blockId: "turn_1:b0", text: "Hello world.")))
        XCTAssertEqual(t.items, [.text(blockId: "turn_1:b0", text: "Hello world.", isFinal: true)])
        // A straggling delta for a finished block changes nothing.
        XCTAssertFalse(t.apply(env(nil, .textDelta(blockId: "turn_1:b0", text: "ld."))))
        XCTAssertEqual(t.items, [.text(blockId: "turn_1:b0", text: "Hello world.", isFinal: true)])
        // The next block starts fresh.
        t.apply(env(nil, .textDelta(blockId: "turn_1:b1", text: "Next")))
        XCTAssertEqual(t.items.count, 2)
        XCTAssertEqual(t.items[1], .text(blockId: "turn_1:b1", text: "Next", isFinal: false))
    }

    func testAFinalTextWithoutDeltasAndAReplayAfterReconnect() {
        var t = TurnTranscript()
        let script: [OmniStreamEnvelope] = [
            env(1, .initialized(runId: "r")),
            env(2, .toolUse(id: "turn_1:t1", name: "prism_create_note", input: ["path": "a"])),
            env(3, .toolResult(toolUseId: "turn_1:t1", ok: true, summary: "created")),
            env(4, .text(blockId: "turn_1:b0", text: "Done.")),
            env(5, .result(ok: true, durationMs: 900, errorCode: nil)),
            env(6, .status(state: .done, reason: nil)),
        ]
        for e in script { XCTAssertTrue(t.apply(e)) }
        let before = t
        // Reconnect replays from an older cursor: every event is applied once only.
        for e in script { XCTAssertFalse(t.apply(e)) }
        XCTAssertEqual(t, before)
        XCTAssertEqual(t.items.count, 2)
        guard case .tool(let call) = t.items[0] else { return XCTFail() }
        XCTAssertEqual(call.ok, true)
        XCTAssertEqual(call.summary, "created")
        XCTAssertEqual(t.result?.ok, true)
        XCTAssertEqual(t.result?.durationMs, 900)
        XCTAssertNil(t.result?.errorCode)
        XCTAssertEqual(t.state, .done)
        XCTAssertEqual(t.lastSeq, 6)
    }

    func testSeededCursorSkipsWhatWasAlreadyShown() {
        var t = TurnTranscript(lastSeq: 10)
        XCTAssertFalse(t.apply(env(10, .text(blockId: "b", text: "old"))))
        XCTAssertTrue(t.apply(env(11, .text(blockId: "b", text: "new"))))
        XCTAssertEqual(t.items, [.text(blockId: "b", text: "new", isFinal: true)])
    }
}
