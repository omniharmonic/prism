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
    func testSessionOwnershipPreemptsWakeAndEndAllowsAnotherSession() {
        let first = SessionModel(service: FakeService(), sleep: noSleep) {}
        let second = SessionModel(service: FakeService(), sleep: noSleep) {}
        defer { first.stop(); second.stop() }
        let coordinator = VoiceMicrophoneCoordinator.shared
        let wake = UUID()
        var preempted = false
        XCTAssertTrue(coordinator.acquireWake(owner: wake) { preempted = true })
        let audio = VoiceConversationTests.Audio()
        let voice = VoiceConversation(audio: audio)
        first.requestNewVoice()
        XCTAssertTrue(first.claimVoice(audio: audio, voice: voice, threadID: nil))
        XCTAssertTrue(preempted)
        let anotherAudio = VoiceConversationTests.Audio()
        let anotherVoice = VoiceConversation(audio: anotherAudio)
        second.requestNewVoice()
        XCTAssertFalse(second.claimVoice(audio: anotherAudio, voice: anotherVoice, threadID: nil))
        XCTAssertFalse(coordinator.acquireWake(owner: wake) {})
        XCTAssertTrue(first.cancelVoice(voice, threadID: nil))
        XCTAssertTrue(second.claimVoice(audio: anotherAudio, voice: anotherVoice, threadID: nil))
    }

}
