import XCTest
@testable import OmniCore

@MainActor final class VoiceSubmissionProgressTests: XCTestCase {
    func testSlowSendDistinguishesRecognitionFromSubmissionAndClearsOnSuccess() async {
        let audio = VoiceConversationTests.Audio()
        let active = VoiceConversation(audio: audio)
        audio.waitForTranscript = true
        await active.start()
        var sendGate: CheckedContinuation<Bool, Never>?
        let finish = Task { await active.finish { _ in await withCheckedContinuation { sendGate = $0 } } }
        await eventually { audio.finishGate != nil }
        XCTAssertEqual(active.state, .transcribing)
        XCTAssertFalse(active.isSubmitting)
        audio.finishGate?.resume(returning: "Recognized words"); audio.finishGate = nil
        await eventually { sendGate != nil }
        XCTAssertTrue(active.isSubmitting, "The panel must show sending after recognition finishes")
        sendGate?.resume(returning: true)
        await finish.value
        XCTAssertEqual(active.state, .answering)
        XCTAssertFalse(active.isSubmitting)
        active.cancel()
    }
    func testCancelPendingSendClearsProgressAndCannotRestartSession() async {
        let audio = VoiceConversationTests.Audio()
        let voice = VoiceConversation(audio: audio)
        await voice.start()
        var sendGate: CheckedContinuation<Bool, Never>?
        let finish = Task { await voice.finish { _ in await withCheckedContinuation { sendGate = $0 } } }
        await eventually { sendGate != nil }
        XCTAssertTrue(voice.isSubmitting)
        voice.cancel()
        XCTAssertFalse(voice.isSubmitting)
        sendGate?.resume(returning: true)
        await finish.value
        XCTAssertEqual(voice.state, .off)
        XCTAssertFalse(voice.isSessionActive)
    }
}
