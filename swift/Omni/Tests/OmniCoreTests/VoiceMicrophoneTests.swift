import XCTest
@testable import OmniCore

@MainActor final class VoiceMicrophoneTests: XCTestCase {
    func testConversationPreemptsWakeSynchronouslyAndHoldsOwnershipUntilEnd() {
        let coordinator = VoiceMicrophoneCoordinator()
        let wake = UUID(), conversation = UUID()
        var stopped = false
        XCTAssertTrue(coordinator.acquireWake(owner: wake) { stopped = true })
        XCTAssertTrue(coordinator.acquireConversation(owner: conversation))
        XCTAssertTrue(stopped)
        XCTAssertFalse(coordinator.acquireWake(owner: wake) {})
        XCTAssertTrue(coordinator.acquireConversation(owner: conversation))
        coordinator.releaseConversation(owner: UUID())
        XCTAssertEqual(coordinator.conversationOwner, conversation)
        coordinator.releaseConversation(owner: conversation)
        XCTAssertTrue(coordinator.acquireWake(owner: wake) {})
    }
    func testOtherOwnersCannotStealOrReleaseMicrophone() {
        let coordinator = VoiceMicrophoneCoordinator()
        let wake = UUID()
        XCTAssertTrue(coordinator.acquireWake(owner: wake) {})
        coordinator.releaseWake(owner: UUID())
        XCTAssertFalse(coordinator.acquireWake(owner: UUID()) {})
        let first = UUID()
        XCTAssertTrue(coordinator.acquireConversation(owner: first))
        XCTAssertFalse(coordinator.acquireConversation(owner: UUID()))
    }
}
