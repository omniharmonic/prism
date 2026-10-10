import XCTest
@testable import OmniCore

@MainActor final class VoiceContinuityTests: XCTestCase {
    final class Audio: ConversationAudio {
        var recoveryNotice: String?
        var interruption: (@MainActor (VoiceInterruptionEvent) -> Void)?
        var limit: (@MainActor () -> Void)?
        var starts = 0
        var silenced = 0
        func start() async throws { starts += 1 }
        func finish() async throws -> String { "Words recognized before failure" }
        func cancel() {}
        func speak(_ text: String) {}
        func waitForPlayback() async {}
        func silence() { silenced += 1 }
        func configureInterruption(enabled: Bool, receive: @escaping @MainActor (VoiceInterruptionEvent) -> Void) { interruption = enabled ? receive : nil }
        func configureRecordingLimit(_ receive: @escaping @MainActor () -> Void) { limit = receive }
    }
    func testRecoveryNeverInvokesSubmittedSend() async {
        let audio = Audio(); audio.recoveryNotice = "Only part of the recording could be recognized."
        let voice = VoiceConversation(audio: audio)
        var draft = ""
        voice.saveRecoveredDraft = { draft = $0 }
        await voice.start()
        var sends = 0
        await voice.finish { _ in sends += 1; return true }
        XCTAssertEqual(sends, 0)
        XCTAssertEqual(draft, "Words recognized before failure")
        XCTAssertEqual(voice.state, .paused)
        XCTAssertEqual(voice.problem, audio.recoveryNotice)
    }
    func testAcousticInterruptionKeepsExistingCaptureAndLateCallbackCannotRestart() async {
        let audio = Audio(); let voice = VoiceConversation(audio: audio)
        voice.acousticInterruptionEnabled = true
        await voice.start()
        await voice.finish { _ in true }
        let receive = audio.interruption
        XCTAssertEqual(voice.state, .answering)
        receive?(.speech)
        XCTAssertEqual(voice.state, .listening)
        XCTAssertEqual(audio.starts, 1, "The retained microphone lead-in must not be replaced by a new capture.")
        voice.cancel()
        receive?(.speech)
        XCTAssertEqual(voice.state, .off)
        XCTAssertEqual(audio.starts, 1)
    }
    func testRecordingLimitRequestsDraftWithoutAutomaticSubmission() async {
        let audio = Audio(); let voice = VoiceConversation(audio: audio)
        var limits = 0
        voice.recordingLimitReached = { limits += 1 }
        await voice.start()
        let receive = audio.limit
        receive?()
        XCTAssertEqual(limits, 1)
        XCTAssertEqual(voice.state, .listening)
        voice.cancel(); receive?()
        XCTAssertEqual(limits, 1)
    }
}
