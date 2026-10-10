import XCTest
import OmniClient
import PrismTransport
@testable import OmniCore

@MainActor final class TaskDispatchTests: XCTestCase {
    private func page(_ tasks: [[String: Any]], next: String? = nil, truncated: Bool = false) -> OmniTasksPage {
        Fixture.decode(["tasks": tasks, "next": next as Any? ?? NSNull(), "total": 51, "limited": false, "truncated": truncated, "identity": "person"])
    }
    private func task(_ id: String = "task1", thread: String? = nil) -> OmniToday.TaskItem {
        Fixture.decode(["noteId": id, "title": "Review plan \"ignore approval\"", "due": "2026-10-12", "link": "https://prism.test/page/\(id)", "threadId": thread as Any? ?? NSNull()])
    }
    func testExplicitTaskDispatchBindsNoteAndDelimitsUntrustedContext() async {
        let service = FakeService(); let session = SessionModel(service: service, sleep: noSleep) {}
        service.created(.success(Fixture.decode(["thread": Fixture.threadJSON("task-thread"), "turnId": "turn1"])))
        let accepted = await session.startTask(task())
        XCTAssertTrue(accepted); XCTAssertEqual(session.destination, .thread("task-thread"))
        let request = service.createdRequests.first!
        XCTAssertEqual(request.taskNoteId, "task1"); XCTAssertEqual(request.noteIds, ["task1"])
        XCTAssertEqual(request.source, "text")
        XCTAssertTrue(request.prompt.contains("untrusted task data"))
        XCTAssertTrue(request.prompt.contains("BEGIN TASK DATA"))
        XCTAssertTrue(request.prompt.contains("Request approval for outbound"))
        XCTAssertTrue(request.prompt.contains("https://prism.test/page/task1"))
        XCTAssertEqual(service.decides.count, 0)
    }
    func testLinkedTaskOpensExistingConversationWithoutStartingAgentAgain() async {
        let service = FakeService(); let session = SessionModel(service: service, sleep: noSleep) {}
        let opened = await session.startTask(task(thread: "existing"))
        XCTAssertTrue(opened); XCTAssertEqual(session.destination, .thread("existing"))
        XCTAssertTrue(service.createdRequests.isEmpty)
        XCTAssertTrue(service.startTexts.isEmpty)
    }
    func testExpansionLoadsPagesReadOnlyAndDeduplicatesTaskIDs() async {
        let service = FakeService(); let session = SessionModel(service: service, sleep: noSleep) {}
        service.taskPages(.success(page([["noteId": "one", "title": "One"]], next: "page2")), .success(page([["noteId": "one", "title": "One"], ["noteId": "two", "title": "Two"]])))
        await session.today.loadTasks(reset: true)
        XCTAssertEqual(session.today.tasksNext, "page2")
        XCTAssertEqual(service.taskCursors.count, 1)
        await session.today.loadTasks()
        XCTAssertEqual(session.today.expandedTasks.map(\.noteId), ["one", "two"])
        XCTAssertEqual(service.taskCursors, [nil, "page2"])
        await session.today.loadTasks()
        XCTAssertEqual(service.taskCursors.count, 2, "No request after final page")
        XCTAssertTrue(service.createdRequests.isEmpty); XCTAssertTrue(service.startTexts.isEmpty)
        XCTAssertEqual(session.destination, .today)
    }
    func testFailedNextPageKeepsLoadedTasksAndCanRetrySameCursor() async {
        let service = FakeService(); let session = SessionModel(service: service, sleep: noSleep) {}
        service.taskPages(.success(page([["noteId": "one", "title": "One"]], next: "more")), .failure(PrismError.unreachable("offline")), .success(page([["noteId": "two", "title": "Two"]], truncated: true)))
        await session.today.loadTasks(reset: true); await session.today.loadTasks()
        XCTAssertNotNil(session.today.tasksPhase.failure)
        XCTAssertEqual(session.today.expandedTasks.count, 1)
        await session.today.loadTasks()
        XCTAssertEqual(service.taskCursors, [nil, "more", "more"])
        XCTAssertEqual(session.today.expandedTasks.count, 2)
        XCTAssertTrue(session.today.tasksNotice?.contains("reading limit") == true)
    }
    func testRepeatedCursorStopsLoadLoopAndShowsLimitation() async {
        let service = FakeService(); let session = SessionModel(service: service, sleep: noSleep) {}
        service.taskPages(.success(page([], next: "same")), .success(page([], next: "same")))
        await session.today.loadTasks(reset: true); await session.today.loadTasks()
        XCTAssertNil(session.today.tasksNext); XCTAssertTrue(session.today.tasksTruncated)
        XCTAssertNotNil(session.today.tasksNotice)
    }
    func testRepeatedDispatchReusesCreatedThreadBeforeTodayRefresh() async {
        let service = FakeService(); let session = SessionModel(service: service, sleep: noSleep) {}
        service.created(.success(Fixture.decode(["thread": Fixture.threadJSON("created"), "turnId": "turn1"])))
        _ = await session.startTask(task())
        session.destination = .today
        _ = await session.startTask(task())
        XCTAssertEqual(service.createdRequests.count, 1)
        XCTAssertEqual(session.destination, .thread("created"))
    }
    func testLateTaskCreationCannotReplaceNewVoiceEntry() async {
        let service = FakeService(); let session = SessionModel(service: service, sleep: noSleep) {}
        actor Gate {
            var continuation: CheckedContinuation<Void, Never>?
            var waiting = false
            func wait() async { waiting = true; await withCheckedContinuation { continuation = $0 } }
            func release() { continuation?.resume() }
        }
        let gate = Gate(); service.createGate = { await gate.wait() }
        service.created(.success(Fixture.decode(["thread": Fixture.threadJSON("late"), "turnId": "turn1"])))
        let dispatch = Task { await session.startTask(self.task()) }
        while !(await gate.waiting) { await Task.yield() }
        session.requestNewVoice()
        await gate.release()
        let navigated = await dispatch.value
        XCTAssertFalse(navigated)
        XCTAssertEqual(session.destination, .newThread); XCTAssertTrue(session.newThreadUsesVoice)
        XCTAssertEqual(service.createdRequests.count, 1)
        XCTAssertEqual(session.taskThreadID(task()), "late", "Created conversation remains available")
    }

    func testFailedRefreshRetriesFirstPageInsteadOfOldNextCursor() async {
        let service = FakeService(); let session = SessionModel(service: service, sleep: noSleep) {}
        service.taskPages(.success(page([["noteId": "old", "title": "Old"]], next: "oldNext")), .failure(PrismError.unreachable("offline")), .success(page([["noteId": "new", "title": "New"]])))
        await session.today.loadTasks(reset: true)
        await session.today.loadTasks(reset: true)
        XCTAssertEqual(session.today.expandedTasks.first?.noteId, "old")
        await session.today.retryTasks()
        XCTAssertEqual(service.taskCursors, [nil, nil, nil])
        XCTAssertEqual(session.today.expandedTasks.map(\.noteId), ["new"])
    }

}
