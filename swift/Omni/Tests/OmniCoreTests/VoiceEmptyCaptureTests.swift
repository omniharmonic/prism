import XCTest
@testable import OmniCore

@MainActor final class VoiceEmptyCaptureTests: XCTestCase {
    private final class Audio: ConversationAudio {
        var recognized = ""
        var recoveryNotice: String?
        var starts = 0
        var failFinish = false
        func start() async throws { starts += 1 }
        func finish() async throws -> String {
            if failFinish { throw NSError(domain: "fixture", code: 1) }
            return recognized
        }
        func cancel() {}
        func speak(_ text: String) {}
        func waitForPlayback() async {}
        func silence() {}
    }
    func testEmptyAutomaticCaptureRearmsTwiceThenPausesWithoutSending() async {
        let audio = Audio()
        let active = VoiceConversation(audio: audio)
        active.configureEndpoint(mode: .automatic, pauseSeconds: 4)
        active.canAutomaticallyListen = { true }
        await active.start()
        for expectedStarts in [2, 3] {
            await active.finish { _ in XCTFail("Empty capture cannot send"); return false }
            XCTAssertEqual(audio.starts, expectedStarts)
            XCTAssertEqual(active.state, .listening)
            XCTAssertTrue(active.isSessionActive)
            XCTAssertEqual(active.captureNotice, "Didn't catch that. Still listening.")
        }
        await active.finish { _ in XCTFail("Empty capture cannot send"); return false }
        XCTAssertEqual(audio.starts, 3)
        XCTAssertEqual(active.state, .paused)
        XCTAssertNotNil(active.problem)
        await active.start()
        await active.finish { _ in XCTFail("Empty capture cannot send"); return false }
        XCTAssertEqual(audio.starts, 5, "Explicit Resume resets the bounded empty recovery count")
        active.cancel()
    }
    func testManualPauseRecoveryFailureAndOwnerLossNeverRearm() async {
        for reason in ["manual", "pause", "recovery", "error", "owner"] {
            let audio = Audio()
            let active = VoiceConversation(audio: audio)
            if reason != "manual" { active.configureEndpoint(mode: .automatic, pauseSeconds: 4) }
            active.canAutomaticallyListen = { reason != "owner" }
            if reason == "recovery" { audio.recoveryNotice = "Transcription stopped; review the recording." }
            if reason == "error" { audio.failFinish = true }
            await active.start()
            await active.finish(submit: reason != "pause", draftReason: .pause) { _ in XCTFail("Empty capture cannot send"); return false }
            XCTAssertEqual(audio.starts, 1, reason)
            XCTAssertEqual(active.state, .paused, reason)
            XCTAssertTrue(active.isSessionActive, reason)
            if reason == "recovery" { XCTAssertEqual(active.problem, audio.recoveryNotice) }
            active.cancel()
        }
    }
}
