import Foundation
import OmniClient
@testable import OmniCore
import PrismTransport
import XCTest

@MainActor
final class ThreadListTests: XCTestCase {
    func testSectionsFollowTheSpecOrderAndWords() {
        let threads = [
            Fixture.thread("a", state: "done"),
            Fixture.thread("b", state: "working"),
            Fixture.thread("c", state: "needs-you"),
            Fixture.thread("d", state: "scheduled"),
            Fixture.thread("e", state: "waiting"),
            Fixture.thread("f", state: "working"),
        ]
        let sections = ThreadGrouping.sections(threads)
        XCTAssertEqual(sections.map(\.title), ["Needs you", "Working", "Waiting", "Scheduled", "Done"])
        // The server's order is kept inside a group.
        XCTAssertEqual(sections[1].threads.map(\.id), ["b", "f"])
    }

    func testAnUnknownStateIsShownUnderItsOwnWordAndArchivedIsLeftOut() {
        let sections = ThreadGrouping.sections([
            Fixture.thread("a", state: "on-hold"),
            Fixture.thread("b", state: "done"),
            Fixture.thread("c", state: "done", archived: true),
        ])
        XCTAssertEqual(sections.map(\.title), ["Done", "On hold"])
        XCTAssertEqual(sections[0].threads.map(\.id), ["b"])
    }

    func testTitlesFallBackToThePreview() {
        let untitled: OmniThread = Fixture.decode(["id": "x", "state": "done", "preview": "  find 45 minutes with Dana  "])
        XCTAssertEqual(ThreadGrouping.displayTitle(untitled), "find 45 minutes with Dana")
        XCTAssertNil(ThreadGrouping.subtitle(untitled))
        let waiting: OmniThread = Fixture.decode(Fixture.threadJSON("y", state: "waiting", waitingOn: "Dana"))
        XCTAssertEqual(ThreadGrouping.subtitle(waiting), "on Dana")
        XCTAssertEqual(ThreadGrouping.displayTitle(Fixture.decode(["id": "z"])), "Untitled thread")
    }

    private func make(_ service: FakeService, _ signedOut: Counter = Counter()) -> ThreadListModel {
        ThreadListModel(service: service, sink: ErrorSink { signedOut.bump() })
    }

    func testRefreshLoadsGroupsAndCountsUnread() async {
        let service = FakeService()
        service.lists(.success(Fixture.list([Fixture.threadJSON("a", state: "needs-you", unread: 2), Fixture.threadJSON("b", state: "done")])))
        let model = make(service)
        await model.refresh()
        XCTAssertEqual(model.phase, .loaded)
        XCTAssertEqual(model.sections.map(\.title), ["Needs you", "Done"])
        XCTAssertEqual(model.unreadCount, 1)
        XCTAssertFalse(model.agentUnavailable)
        XCTAssertFalse(model.isEmpty)
    }

    func testEmptyListAndAgentUnavailable() async {
        let service = FakeService()
        service.lists(.success(Fixture.list([], hermes: "unavailable")))
        let model = make(service)
        await model.refresh()
        XCTAssertTrue(model.isEmpty)
        XCTAssertTrue(model.agentUnavailable)
    }

    func testSearchIsSentTrimmedAndNotSentWhenBlank() async {
        let service = FakeService()
        service.lists(.success(Fixture.list([])))
        let model = make(service)
        model.searchText = "  dana "
        await model.refresh()
        model.searchText = "   "
        await model.refresh()
        XCTAssertEqual(service.searches, ["dana", nil])
    }

    func testFailureIsPlainLanguageAndSignedOutGoesToTheApp() async {
        let service = FakeService()
        let signedOut = Counter()
        service.lists(.failure(PrismError.unreachable("offline")), .failure(PrismError.signedOut))
        let model = make(service, signedOut)
        await model.refresh()
        XCTAssertEqual(model.phase.failure, "Can't reach the server. Check that it's running and that this Mac is on the right network.")
        XCTAssertEqual(signedOut.count, 0)
        await model.refresh()
        XCTAssertEqual(signedOut.count, 1)
    }

    func testCreatePutsTheThreadFirst() async {
        let service = FakeService()
        service.lists(.success(Fixture.list([Fixture.threadJSON("old")])))
        service.created(.success(Fixture.decode(["thread": Fixture.threadJSON("new", state: "working"), "turnId": "turn1"])))
        let model = make(service)
        await model.refresh()
        let created = await model.create(prompt: "  call Dana  ")
        XCTAssertEqual(created?.turnId, "turn1")
        XCTAssertEqual(service.createdPrompts, ["call Dana"])
        XCTAssertEqual(model.threads.map(\.id), ["new", "old"])
    }

    func testCreateWithAnUnclearOutcomeReadsTheListInsteadOfTryingAgain() async {
        let service = FakeService()
        service.lists(.success(Fixture.list([])))
        service.created(.failure(Fixture.unknownOutcome))
        let model = make(service)
        let created = await model.create(prompt: "call Dana")
        XCTAssertNil(created)
        XCTAssertEqual(service.createdPrompts.count, 1, "creating a thread is not idempotent: never retried automatically")
        XCTAssertEqual(service.listReads, 1)
        XCTAssertEqual(model.createError, "It isn't clear whether the thread was created. Check the list before sending it again.")
    }
}

@MainActor
final class ThreadTimelineTests: XCTestCase {
    func testApprovalsAndCardsArePlacedByTime() {
        let detail = Fixture.detail(
            messages: [
                Fixture.message("user", "find time with Dana", at: "2026-10-08T15:00:00.000Z", id: 1),
                Fixture.message("tool", "prism_search_notes", at: "2026-10-08T15:00:01.000Z", id: 2),
                Fixture.message("assistant", "Draft below.", at: "2026-10-08T15:00:05.000Z", id: 3),
                Fixture.message("user", "thanks", at: "2026-10-08T16:00:00.000Z", id: 4),
            ],
            approvals: [Fixture.approvalJSON("apr1", createdAt: "2026-10-08T15:00:06.000Z")],
            cards: [Fixture.card("n2"), Fixture.card("n1", updatedAt: "2026-10-08T15:00:02.000Z")]
        )
        let ids = ThreadTimeline.history(detail).map(\.id)
        XCTAssertEqual(ids, ["m:0-1", "t:h1-2", "c:n1|updated|2026-10-08T15:00:02.000Z", "m:2-3", "a:apr1", "m:3-4", "c:n2|updated|"])
    }

    func testLiveItemsAndToolLabels() {
        var transcript = TurnTranscript()
        transcript.apply(OmniStreamEnvelope(seq: 1, turnId: "t", event: .toolUse(id: "u1", name: "prism_update_note", input: .null)))
        transcript.apply(OmniStreamEnvelope(seq: nil, turnId: "t", event: .textDelta(blockId: "b1", text: "Hel")))
        let live = ThreadTimeline.live(transcript, turnRunning: true)
        XCTAssertEqual(live, [
            .tool(id: "u1", name: "prism_update_note", ok: nil, summary: nil, running: true),
            .streamingText(id: "b1", text: "Hel", isFinal: false),
        ])
        XCTAssertEqual(ThreadTimeline.toolLabel("prism_update_note"), "Update note")
        XCTAssertEqual(ThreadTimeline.toolLabel("omni_propose"), "Propose")
        XCTAssertEqual(ThreadTimeline.toolLabel("create-note"), "Create note")
    }
}

@MainActor
final class ThreadModelTests: XCTestCase {
    private var service = FakeService()
    private var signedOut = Counter()
    private var approvals: ApprovalCenter!

    private func make(_ id: String = "t1") -> ThreadModel {
        let counter = signedOut
        let sink = ErrorSink { counter.bump() }
        approvals = ApprovalCenter(service: service, sink: sink)
        return ThreadModel(threadID: id, service: service, approvals: approvals, sink: sink, sleep: noSleep)
    }

    private let hello = Fixture.message("user", "hello", at: "2026-10-08T15:00:00.000Z", id: 1)
    private let answer = Fixture.message("assistant", "Hi Benjamin.", at: "2026-10-08T15:00:03.000Z", id: 2)

    private func texts(_ model: ThreadModel) -> [String] {
        model.timeline.map { item in
            switch item {
            case .message(_, let role, let text, _): return "\(role.rawValue):\(text)"
            case .streamingText(_, let text, let isFinal): return "\(isFinal ? "final" : "live"):\(text)"
            case .pendingMessage(let text, let failed): return "\(failed ? "failed" : "pending"):\(text)"
            case .tool(_, let name, let ok, _, let running): return "tool:\(name):\(ok.map(String.init) ?? "nil"):\(running)"
            case .card(_, let card): return "card:\(card.noteId)"
            case .approval(let id): return "approval:\(id)"
            case .turnEnded(let text): return "ended:\(text)"
            }
        }
    }

    func testOpeningAnIdleThreadShowsHistoryAndOpensNoStream() async {
        service.details(.success(Fixture.detail(lastSeq: 9, messages: [hello, answer])))
        let model = make()
        await model.open()
        XCTAssertEqual(model.phase, .loaded)
        XCTAssertEqual(texts(model), ["user:hello", "assistant:Hi Benjamin."])
        XCTAssertFalse(model.isRunning)
        XCTAssertTrue(service.streamAfters.isEmpty)
    }

    func testALoadFailureIsShownAndSignedOutGoesToTheApp() async {
        service.details(.failure(PrismError.rejected(Fixture.failure(404, "not_found"))), .failure(PrismError.signedOut))
        let model = make()
        await model.open()
        XCTAssertEqual(model.phase.failure, "The server couldn't find that. It may have been removed.")
        await model.reload()
        XCTAssertEqual(signedOut.count, 1)
    }

    func testSendStreamsDeltasThenTheFinalTextReplacesThem() async {
        service.details(
            .success(Fixture.detail(lastSeq: 4, messages: [hello, answer])),
            .success(Fixture.detail(lastSeq: 9, messages: [hello, answer, Fixture.message("user", "and again", at: "2026-10-08T15:01:00.000Z", id: 3), Fixture.message("assistant", "Hello again.", at: "2026-10-08T15:01:02.000Z", id: 4)]))
        )
        service.starts(.success(.started(turnId: "turn1")))
        let stream = service.manualStream()
        let model = make()
        await model.open()
        model.draft = "  and again "
        XCTAssertTrue(model.canSend)
        await model.send()
        XCTAssertEqual(service.startTexts, ["and again"])
        XCTAssertEqual(model.draft, "")
        XCTAssertTrue(model.isRunning)
        XCTAssertFalse(model.canSend)
        XCTAssertEqual(texts(model).last, "pending:and again")

        stream.yield(.connected)
        stream.yield(Fixture.event(5, .status(state: .working, reason: nil)))
        stream.yield(Fixture.event(6, .toolUse(id: "u1", name: "prism_search_notes", input: .null)))
        stream.yield(Fixture.event(nil, .textDelta(blockId: "b1", text: "Hel")))
        stream.yield(Fixture.event(nil, .textDelta(blockId: "b1", text: "lo")))
        await eventually("deltas") { self.texts(model).contains("live:Hello") }
        XCTAssertEqual(model.connection, .live)
        XCTAssertEqual(texts(model), ["user:hello", "assistant:Hi Benjamin.", "pending:and again", "tool:prism_search_notes:nil:true", "live:Hello"])
        // The stream started after the thread's last stored event.
        XCTAssertEqual(service.streamAfters, [4])

        stream.yield(Fixture.event(7, .toolResult(toolUseId: "u1", ok: true, summary: "3 notes")))
        stream.yield(Fixture.event(8, .text(blockId: "b1", text: "Hello again.")))
        // A replayed event (same seq) changes nothing.
        stream.yield(Fixture.event(8, .text(blockId: "b1", text: "DUPLICATE")))
        await eventually("final text") { self.texts(model).contains("final:Hello again.") }
        XCTAssertTrue(texts(model).contains("tool:prism_search_notes:true:false"))
        XCTAssertFalse(texts(model).contains { $0.contains("DUPLICATE") })

        stream.yield(Fixture.event(9, .result(ok: true, durationMs: 900, errorCode: nil)))
        stream.finish()
        await eventually("turn end") { !model.isRunning }
        // History now holds the turn; nothing is shown twice.
        XCTAssertEqual(texts(model), ["user:hello", "assistant:Hi Benjamin.", "user:and again", "assistant:Hello again."])
        XCTAssertNil(model.turnEnded)
        XCTAssertEqual(model.connection, .idle)
    }

    func testACleanCloseWithoutAResultReadsTheThreadAndAttachesAgain() async {
        service.details(
            .success(Fixture.detail(lastSeq: 4, messages: [hello])),
            // After the first stream ended: the turn is still running.
            .success(Fixture.detail(lastSeq: 6, messages: [hello], activeTurnId: "turn1")),
            // After the second stream (which carried the result).
            .success(Fixture.detail(lastSeq: 8, messages: [hello, answer]))
        )
        service.starts(.success(.started(turnId: "turn1")))
        service.streams(
            [.success(.connected), .success(Fixture.event(5, .initialized(runId: "r"))), .success(Fixture.event(6, .text(blockId: "b1", text: "Working on it.")))],
            [.success(.connected), .success(Fixture.event(7, .text(blockId: "b2", text: "Done."))), .success(Fixture.event(8, .result(ok: true, durationMs: 1, errorCode: nil)))]
        )
        let model = make()
        await model.open()
        model.draft = "go"
        await model.send()
        await eventually("turn end") { !model.isRunning && self.service.streamAfters.count == 2 }
        // Attached again from the last event seen — not from the start, not from a guess.
        XCTAssertEqual(service.streamAfters, [4, 6])
        XCTAssertEqual(texts(model), ["user:hello", "assistant:Hi Benjamin."])
    }

    func testACleanCloseWithoutAResultAndNoActiveTurnEndsQuietly() async {
        service.details(
            .success(Fixture.detail(lastSeq: 4, messages: [hello])),
            .success(Fixture.detail(lastSeq: 6, messages: [hello, answer]))
        )
        service.starts(.success(.started(turnId: "turn1")))
        service.streams([.success(Fixture.event(5, .initialized(runId: "r"))), .success(Fixture.event(6, .text(blockId: "b1", text: "Hi Benjamin.")))])
        let model = make()
        await model.open()
        model.draft = "go"
        await model.send()
        await eventually("turn end") { !model.isRunning }
        XCTAssertEqual(service.streamAfters, [4])
        XCTAssertEqual(texts(model), ["user:hello", "assistant:Hi Benjamin."])
    }

    func testAnEmptyReattachBacksOffAndKeepsTrying() async {
        let running = Fixture.detail(lastSeq: 2, messages: [hello], activeTurnId: "turn1")
        service.details(.success(running), .success(running), .success(running), .success(Fixture.detail(lastSeq: 3, messages: [hello, answer])))
        service.streams([], [], [.success(Fixture.event(3, .result(ok: true, durationMs: 1, errorCode: nil)))])
        let model = make()
        await model.open()
        await eventually("turn end") { !model.isRunning }
        // Opened mid-turn: the turn's stored events are read from the start.
        XCTAssertEqual(service.streamAfters, [0, 0, 0])
    }

    func testOpeningMidTurnShowsOnlyThatTurnsEvents() async {
        service.details(
            .success(Fixture.detail(lastSeq: 12, messages: [hello, answer, Fixture.message("user", "next", at: "2026-10-08T16:00:00.000Z", id: 3)], activeTurnId: "turn2")),
            .success(Fixture.detail(lastSeq: 14, messages: [hello, answer]))
        )
        let stream = service.manualStream()
        let model = make()
        await model.open()
        XCTAssertTrue(model.isRunning)
        stream.yield(Fixture.event(3, turn: "turn1", .text(blockId: "old", text: "An old turn's text")))
        stream.yield(Fixture.event(11, turn: "turn2", .toolUse(id: "u9", name: "prism_create_note", input: .null)))
        stream.yield(Fixture.event(12, turn: "turn2", .text(blockId: "b", text: "Created it.")))
        await eventually("replayed turn") { self.texts(model).contains("final:Created it.") }
        XCTAssertEqual(service.streamAfters, [0])
        XCTAssertFalse(texts(model).contains { $0.contains("old turn") })
        XCTAssertTrue(texts(model).contains("tool:prism_create_note:nil:true"))
        model.close()
        XCTAssertFalse(model.isOpen)
        XCTAssertEqual(model.connection, .idle)
    }

    func testAnUnclearSendKeepsTheMessageAndRetriesWithTheSameKey() async {
        service.details(.success(Fixture.detail(lastSeq: 1, messages: [hello])), .success(Fixture.detail(lastSeq: 2, messages: [hello, answer])))
        service.starts(.failure(Fixture.unknownOutcome), .failure(PrismError.unreachable("offline")), .success(.replayed(turnId: "turn1", status: "running")))
        service.streams([.success(Fixture.event(2, .result(ok: true, durationMs: 1, errorCode: nil)))])
        let model = make()
        await model.open()
        model.draft = "send the spec"
        await model.send()
        XCTAssertEqual(model.sendState, .failed(message: "It isn't clear whether your message arrived. Try again — it can't be sent twice."))
        XCTAssertEqual(texts(model).last, "failed:send the spec")
        XCTAssertFalse(model.canSend)

        await model.retrySend()
        XCTAssertEqual(model.sendState, .failed(message: "Can't reach the server. Check that it's running and that this Mac is on the right network."))
        await model.retrySend()
        await eventually("turn end") { !model.isRunning && model.pendingText == nil }

        XCTAssertEqual(service.startKeys.count, 3)
        XCTAssertEqual(Set(service.startKeys).count, 1, "every retry of one press resends that press's key")
        XCTAssertEqual(service.startTexts, ["send the spec", "send the spec", "send the spec"])
        XCTAssertEqual(model.sendState, .idle)
    }

    func testEachPressOfSendGetsItsOwnKey() async {
        service.details(.success(Fixture.detail(lastSeq: 1, messages: [hello])))
        service.starts(.success(.started(turnId: "turn1")), .success(.started(turnId: "turn2")))
        service.streams(
            [.success(Fixture.event(2, turn: "turn1", .result(ok: true, durationMs: 1, errorCode: nil)))],
            [.success(Fixture.event(3, turn: "turn2", .result(ok: true, durationMs: 1, errorCode: nil)))]
        )
        let model = make()
        await model.open()
        model.draft = "one"
        await model.send()
        await eventually { !model.isRunning }
        model.draft = "two"
        await model.send()
        await eventually { !model.isRunning }
        XCTAssertEqual(service.startKeys.count, 2)
        XCTAssertNotEqual(service.startKeys[0], service.startKeys[1])
    }

    func testDiscardGivesTheKeptMessageBack() async {
        service.details(.success(Fixture.detail(messages: [hello])))
        service.starts(.failure(Fixture.unknownOutcome))
        let model = make()
        await model.open()
        model.draft = "send the spec"
        await model.send()
        model.discardPending()
        XCTAssertEqual(model.draft, "send the spec")
        XCTAssertNil(model.pendingText)
        XCTAssertEqual(model.sendState, .idle)
    }

    func testATurnAlreadyRunningHandsTheTextBackAndAttaches() async {
        service.details(.success(Fixture.detail(lastSeq: 3, messages: [hello])), .success(Fixture.detail(lastSeq: 4, messages: [hello, answer])))
        service.starts(.success(.alreadyRunning(turnId: "turn0")))
        let stream = service.manualStream()
        let model = make()
        await model.open()
        model.draft = "too soon"
        await model.send()
        XCTAssertEqual(model.draft, "too soon")
        XCTAssertNil(model.pendingText)
        XCTAssertEqual(model.activeTurnID, "turn0")
        stream.yield(Fixture.event(4, turn: "turn0", .result(ok: true, durationMs: 1, errorCode: nil)))
        stream.finish()
        await eventually { !model.isRunning }
    }

    func testADefiniteRefusalHandsTheTextBack() async {
        service.details(.success(Fixture.detail(messages: [hello])))
        service.starts(.failure(PrismError.rejected(Fixture.failure(400, "hermes_rejected"))))
        let model = make()
        await model.open()
        model.draft = "nope"
        await model.send()
        XCTAssertEqual(model.draft, "nope")
        XCTAssertEqual(model.sendState, .idle)
        XCTAssertEqual(model.streamProblem, "The agent refused that message.")
    }

    func testStopCancelsTheRunningTurnAndSaysSo() async {
        service.details(.success(Fixture.detail(lastSeq: 1, messages: [hello])), .success(Fixture.detail(state: "waiting", lastSeq: 3, messages: [hello])))
        service.starts(.success(.started(turnId: "turn1")))
        service.cancels(.success(Fixture.decode(["turnId": "turn1", "status": "cancelling"])))
        let stream = service.manualStream()
        let model = make()
        await model.open()
        model.draft = "stub:slow"
        await model.send()
        stream.yield(Fixture.event(nil, .textDelta(blockId: "b", text: "chunk")))
        await eventually { self.texts(model).contains("live:chunk") }
        await model.stop()
        XCTAssertEqual(service.cancelled, ["turn1"])
        stream.yield(Fixture.event(2, .result(ok: false, durationMs: 5, errorCode: "cancelled")))
        stream.yield(Fixture.event(3, .status(state: .waiting, reason: "cancelled")))
        stream.finish()
        await eventually { !model.isRunning }
        XCTAssertEqual(model.turnEnded, "Stopped.")
        XCTAssertEqual(texts(model).last, "ended:Stopped.")
        // Nothing to stop any more.
        await model.stop()
        XCTAssertEqual(service.cancelled.count, 1)
    }

    func testAFailedTurnIsExplainedInPlainLanguage() async {
        service.details(.success(Fixture.detail(lastSeq: 1, messages: [hello])), .success(Fixture.detail(state: "needs-you", lastSeq: 2, messages: [hello])))
        service.starts(.success(.started(turnId: "turn1")))
        service.streams([.success(Fixture.event(2, .result(ok: false, durationMs: 5, errorCode: "usage_limit")))])
        let model = make()
        await model.open()
        model.draft = "go"
        await model.send()
        await eventually { !model.isRunning }
        XCTAssertEqual(model.turnEnded, "The model's usage limit was reached. Try again later.")
        // The next send clears it.
        service.starts(.success(.started(turnId: "turn2")))
        _ = service.manualStream()
        model.draft = "again"
        await model.send()
        XCTAssertNil(model.turnEnded)
        model.close()
    }

    func testAReconnectIsShownAndAFatalStreamErrorStopsFollowing() async {
        service.details(.success(Fixture.detail(lastSeq: 1, messages: [hello])))
        service.starts(.success(.started(turnId: "turn1")))
        let stream = service.manualStream()
        let model = make()
        await model.open()
        model.draft = "go"
        await model.send()
        stream.yield(.connected)
        stream.yield(.reconnecting(delay: .seconds(1)))
        await eventually { model.connection == .reconnecting }
        stream.finish(throwing: PrismError.forbidden(Fixture.failure(403, "forbidden")))
        await eventually { model.streamProblem != nil }
        XCTAssertEqual(model.streamProblem, "This account isn't allowed to use Omni on this server. Omni is for the server's owner.")
        XCTAssertEqual(model.connection, .idle)
    }

    func testSignedOutOnTheStreamGoesToTheApp() async {
        service.details(.success(Fixture.detail(lastSeq: 1, messages: [hello], activeTurnId: "turn1")))
        service.streams([.failure(PrismError.signedOut)])
        let model = make()
        await model.open()
        await eventually { self.signedOut.count == 1 }
        XCTAssertNil(model.streamProblem)
    }

    func testAnAgentInitiatedMessageAppearsOnAnOpenThread() async {
        service.details(
            .success(Fixture.detail(lastSeq: 4, messages: [hello, answer])),
            .success(Fixture.detail(lastSeq: 5, messages: [hello, answer, Fixture.message("assistant", "Dana replied: Tuesday works.", at: "2026-10-08T18:00:00.000Z", id: 9)]))
        )
        let model = make()
        await model.open()
        await model.changedOnServer()
        XCTAssertEqual(texts(model).last, "assistant:Dana replied: Tuesday works.")
        XCTAssertEqual(service.detailReads, 2)
        // A closed thread is not re-read.
        model.close()
        await model.changedOnServer()
        XCTAssertEqual(service.detailReads, 2)
    }

    func testAnApprovalOnTheStreamReachesTheApprovalCenterOnce() async {
        let pendingJSON = Fixture.approvalJSON("apr1")
        service.details(
            .success(Fixture.detail(lastSeq: 1, messages: [hello])),
            .success(Fixture.detail(state: "needs-you", lastSeq: 3, messages: [hello, answer], approvals: [pendingJSON]))
        )
        service.starts(.success(.started(turnId: "turn1")))
        let stream = service.manualStream()
        let model = make()
        await model.open()
        model.draft = "draft it"
        await model.send()
        stream.yield(Fixture.event(2, .approval(Fixture.approval("apr1"))))
        await eventually { self.texts(model).contains("approval:apr1") }
        XCTAssertEqual(approvals.card(for: "apr1")?.standing(), .pending)
        stream.yield(Fixture.event(3, .result(ok: true, durationMs: 1, errorCode: nil)))
        stream.finish()
        await eventually { !model.isRunning }
        XCTAssertEqual(texts(model).filter { $0 == "approval:apr1" }.count, 1)
        XCTAssertEqual(approvals.pending.map(\.id), ["apr1"])
    }
}
