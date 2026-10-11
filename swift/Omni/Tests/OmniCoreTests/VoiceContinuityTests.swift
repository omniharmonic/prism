import XCTest
@testable import OmniCore

@MainActor final class VoiceContinuityTests: XCTestCase {
    final class Audio: ConversationAudio {
        var activity: (@MainActor (VoiceActivityEvent) -> Void)?
        func configureActivity(enabled: Bool, receive: @escaping @MainActor (VoiceActivityEvent) -> Void) { activity = receive }
        var recoveryNotice: String?
        var interruption: (@MainActor (VoiceInterruptionEvent) -> Void)?
        var limit: (@MainActor () -> Void)?
        var starts = 0
        var silenced = 0
        func start() async throws { starts += 1 }
        var recognized = "Words recognized before failure"
        func finish() async throws -> String { recognized }
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
    func testAcousticPromotionStartsNewTurnWithoutAlreadySentDraftPrefix() async {
        let evidence = VoiceActivityFrame(audioTime: 1, capturedAt: ProcessInfo.processInfo.systemUptime, duration: 0.32, isSpeech: true)
        for event in [VoiceInterruptionEvent.speech, .speechEvidence(evidence)] {
            let audio = Audio()
            let active = VoiceConversation(audio: audio)
            active.acousticInterruptionEnabled = true
            await active.start(continuingDraft: "Saved prefix")
            var sent: [String] = []
            await active.finish { sent.append($0); return true }
            XCTAssertEqual(sent, ["Saved prefix Words recognized before failure"])
            audio.interruption?(event)
            XCTAssertEqual(active.state, .listening)
            XCTAssertEqual(active.continuingDraft, "")
            XCTAssertEqual(active.draftAfterCapture(preserving: "Edited new draft"), "Edited new draft", "Old captured words must not be merged into the new turn")
            audio.recognized = "New interruption words"
            await active.finish { sent.append($0); return true }
            XCTAssertEqual(sent, ["Saved prefix Words recognized before failure", "New interruption words"])
            XCTAssertEqual(audio.starts, 1, "Acoustic promotion retains real lead-in rather than starting another recording")
            active.cancel()
        }
    }
    func testShortInterruptionLeadInSeedsAutomaticCompletion() async {
        let audio = Audio(); let voice = VoiceConversation(audio: audio)
        voice.acousticInterruptionEnabled = true
        voice.configureEndpoint(mode: .automatic, pauseSeconds: 8)
        var completions = 0
        voice.automaticFinish = { completions += 1 }
        await voice.start(); await voice.finish { _ in true }
        let now = ProcessInfo.processInfo.systemUptime
        audio.interruption?(.speechEvidence(VoiceActivityFrame(audioTime: 1, capturedAt: now, duration: 0.32, isSpeech: true)))
        // The short utterance ended inside the preserved lead-in. Only actual
        // subsequent detector silence follows; it must still finish the turn.
        for index in 1...36 {
            audio.activity?(.frame(VoiceActivityFrame(audioTime: 1 + Double(index) * 0.32, capturedAt: now, duration: 0.32, isSpeech: false)))
        }
        XCTAssertEqual(completions, 1)
        voice.cancel()
    }
    func testPlaybackFailurePausesInsteadOfPretendingReplyDrained() async {
        let audio = Audio(); let voice = VoiceConversation(audio: audio)
        voice.acousticInterruptionEnabled = true
        voice.canAutomaticallyListen = { true }
        await voice.start(); await voice.finish { _ in true }
        audio.interruption?(.playbackFailed("Audio route disconnected"))
        XCTAssertEqual(voice.state, .paused)
        XCTAssertTrue(voice.problem?.contains("Audio route disconnected") == true)
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
