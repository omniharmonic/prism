import XCTest
import OmniClient
import PrismTransport
@testable import OmniCore

private actor NudgeFake: NudgeService {
    var keys: [IdempotencyKey] = []
    var starts = 0
    var seenCount = 0
    var failFirst = true
    let item: OmniNudge
    init() throws {
        item = try JSONDecoder().decode(OmniNudge.self, from: Data("""
        {"id":"nud1","candidate":{"sourceId":"note1","sourcePath":"notes/source","kind":"reply-owed","title":"Reply owed","summary":"A question","reasons":["Waiting"],"senderId":null,"deadline":null},"updatedAt":1000,"score":0.7,"surfaces":0,"snoozedUntil":null,"dismissed":false,"threadId":null,"sourceLink":"https://prism.test/page/note1"}
        """.utf8))
    }
    func nudges(later: Bool) async throws -> [OmniNudge] { later ? [] : [item] }
    func nudgeSettings() async throws -> NudgeSettings { .init() }
    func saveNudgeSettings(_ settings: NudgeSettings) async throws -> NudgeSettings { settings }
    func actOnNudge(_ id: String, action: NudgeAction, until: Date?) async throws -> OmniNudge { if action == .seen { seenCount += 1 };return item }
    func startNudge(_ id: String, action: NudgeStart, key: IdempotencyKey) async throws -> NudgeStarted {
        keys.append(key); starts += 1
        if failFirst && starts == 1 { throw URLError(.timedOut) }
        return try JSONDecoder().decode(NudgeStarted.self, from: Data("{\"threadId\":\"thread1\",\"turnId\":\"turn1\"}".utf8))
    }
}
@MainActor final class NudgeTests: XCTestCase {
    func testSeenAcknowledgesEachSourceVersionOnce() async throws {
        let fake = try NudgeFake()
        let center = NudgeCenter(service: fake, sink: ErrorSink(onSignedOut: {}))
        await center.markSeen("nud1", updatedAt: 1000)
        await center.markSeen("nud1", updatedAt: 1000)
        await center.markSeen("nud1", updatedAt: 2000)
        let count = await fake.seenCount
        XCTAssertEqual(count, 2)
    }
    func testQueueAndSettingsRemainAvailableWithDialOff() async throws {
        let fake = try NudgeFake()
        let center = NudgeCenter(service: fake, sink: ErrorSink(onSignedOut: {}))
        await center.refresh()
        XCTAssertEqual(center.items.count, 1)
        XCTAssertEqual(center.phase, .loaded)
        await center.save(.init(dial: .off, killed: true))
        XCTAssertEqual(center.settings.dial, .off)
        XCTAssertTrue(center.settings.killed)
        XCTAssertEqual(center.items.count, 1)
    }
    func testAmbiguousStartRetryKeepsKeyAndDoesNotNavigateOnFailure() async throws {
        let fake = try NudgeFake()
        let center = NudgeCenter(service: fake, sink: ErrorSink(onSignedOut: {}))
        let first = await center.start("nud1", .draftReply)
        XCTAssertNil(first)
        XCTAssertNotNil(center.failure)
        let retry = await center.start("nud1", .draftReply)
        XCTAssertEqual(retry, "thread1")
        let keys = await fake.keys
        XCTAssertEqual(keys.count, 2)
        XCTAssertEqual(keys[0], keys[1])
        XCTAssertTrue(center.busy.isEmpty)
    }
}
