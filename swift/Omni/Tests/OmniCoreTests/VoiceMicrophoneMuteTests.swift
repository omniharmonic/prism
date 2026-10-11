import XCTest
@testable import OmniCore

@MainActor final class VoiceMicrophoneMuteTests: XCTestCase {
    final class Audio: ConversationAudio {
        var recognized = "Captured words"
        var muted = false
        var starts = 0
        var failStart = false
        var startupDraft: String?
        var silenced = 0
        var speech: [String] = []
        var interruption: (@MainActor (VoiceInterruptionEvent) -> Void)?
        var playback: CheckedContinuation<Void, Never>?
        func setInputMuted(_ muted: Bool) { self.muted = muted }
        func start() async throws {
            starts += 1
            if failStart { throw NSError(domain: "startup", code: 1) }
        }
        func recoverStartupDraft() async -> String? { startupDraft }
        func finish() async throws -> String { recognized }
        func cancel() {}
        func silence() { silenced += 1 }
        func speak(_ text: String) { speech.append(text) }
        func waitForPlayback() async { await withCheckedContinuation { playback = $0 } }
        func configureInterruption(enabled: Bool, receive: @escaping @MainActor (VoiceInterruptionEvent) -> Void) { interruption = receive }
    }
    func testMutePreservesDraftAndRequiresUnmuteBeforeResume() async {
        let audio = Audio(); let voice = VoiceConversation(audio: audio)
        await voice.start(continuingDraft: "Existing prefix")
        voice.setMicrophoneMuted(true)
        XCTAssertTrue(audio.muted)
        await voice.finish { _ in XCTFail("Muted input must not send"); return true }
        var draft = "Existing prefix"
        await voice.finish(submit: false, draftReason: .microphoneMute) { _ in
            draft = voice.draftAfterCapture(preserving: draft); return true
        }
        XCTAssertEqual(draft, "Existing prefix Captured words")
        XCTAssertNil(voice.problem)
        XCTAssertEqual(voice.captureNotice, "Your words are saved as an unsent draft.")
        XCTAssertEqual(voice.state, .paused)
        await voice.start(continuingDraft: draft)
        XCTAssertEqual(audio.starts, 1)
        voice.setMicrophoneMuted(false)
        await voice.start(continuingDraft: draft)
        XCTAssertEqual(audio.starts, 2)
        XCTAssertEqual(voice.continuingDraft, draft)
        voice.cancel()
    }
    func testStartupFailureRecoversRecognizedInputAsUnsentDraft() async {
        let audio = Audio(); audio.failStart = true; audio.startupDraft = "Words before engine stopped"
        let voice = VoiceConversation(audio: audio)
        var saved = ""
        voice.saveRecoveredDraft = { saved = $0 }
        await voice.start(continuingDraft: "Earlier draft")
        XCTAssertEqual(saved, "Earlier draft Words before engine stopped")
        XCTAssertEqual(voice.state, .paused)
        XCTAssertTrue(voice.problem?.contains("unsent draft") == true)
        XCTAssertEqual(audio.speech, [])
        voice.cancel()
    }
    func testPrivacyLockClearsMuteWithoutResumingListening() async {
        let audio = Audio(); let voice = VoiceConversation(audio: audio)
        await voice.start(); voice.setMicrophoneMuted(true)
        voice.setPrivacyLocked(true)
        XCTAssertEqual(voice.state, .off)
        XCTAssertFalse(audio.muted)
        voice.setPrivacyLocked(false)
        XCTAssertEqual(audio.starts, 1)
        XCTAssertEqual(voice.state, .off)
    }
    func testReplyPlaysWhileMutedAndDrainDoesNotResumeCapture() async {
        let audio = Audio(); let voice = VoiceConversation(audio: audio)
        voice.acousticInterruptionEnabled = true
        voice.canAutomaticallyListen = { true }
        await voice.start(); await voice.finish { _ in true }
        let silenceCount = audio.silenced
        voice.setMicrophoneMuted(true)
        audio.interruption?(.speech)
        XCTAssertEqual(voice.state, .answering)
        XCTAssertEqual(audio.silenced, silenceCount)
        voice.agentDidComplete([.streamingText(id: "reply", text: "Reply continues", isFinal: true)])
        while audio.playback == nil { await Task.yield() }
        XCTAssertEqual(audio.speech, ["Reply continues"])
        audio.playback?.resume()
        for _ in 0..<20 { await Task.yield() }
        XCTAssertEqual(voice.state, .paused)
        XCTAssertEqual(audio.starts, 1)
        XCTAssertTrue(voice.isMicrophoneMuted)
        voice.cancel()
        XCTAssertFalse(voice.isMicrophoneMuted)
        XCTAssertFalse(audio.muted)
        audio.interruption?(.speech)
        XCTAssertEqual(voice.state, .off)
    }
}
