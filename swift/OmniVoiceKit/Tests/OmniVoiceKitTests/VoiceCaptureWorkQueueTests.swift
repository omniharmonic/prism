import XCTest
@testable import OmniVoiceKit

@MainActor final class VoiceCaptureWorkQueueTests: XCTestCase {
    func testCancelOwnsEveryTaskAndLateOldCompletionCannotDebitNewCapture() async {
        let queue = VoiceCaptureWorkQueue()
        var oldGate: CheckedContinuation<Void, Never>?
        var newGate: CheckedContinuation<Void, Never>?
        var oldWasCancelled = false
        var queuedOldRan = false
        let old = queue.enqueue {
            await withCheckedContinuation { oldGate = $0 }
            oldWasCancelled = Task.isCancelled
        }
        let queued = queue.enqueue { queuedOldRan = true }
        while oldGate == nil { await Task.yield() }
        XCTAssertEqual(queue.pendingCount, 2)
        queue.cancel()
        let current = queue.enqueue { await withCheckedContinuation { newGate = $0 } }
        while newGate == nil { await Task.yield() }
        oldGate?.resume(); await old.value; await queued.value
        XCTAssertTrue(oldWasCancelled)
        XCTAssertFalse(queuedOldRan)
        XCTAssertEqual(queue.pendingCount, 1)
        newGate?.resume(); await current.value
        XCTAssertEqual(queue.pendingCount, 0)
    }
}
