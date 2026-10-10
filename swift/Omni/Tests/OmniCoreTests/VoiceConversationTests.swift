import XCTest
@testable import OmniCore

@MainActor final class VoiceConversationTests: XCTestCase {
    final class Audio: ConversationAudio {
        var gate: CheckedContinuation<Void, Never>?
        var finishGate: CheckedContinuation<String, Never>?
        var wait = false
        var waitForTranscript = false
        var starts = 0
        var failStart = false
        var cancelled = 0
        var speech: [String] = []
        func start() async throws {
            starts += 1
            if wait { await withCheckedContinuation { gate = $0 } }
            if failStart { throw NSError(domain: "fixture", code: 1) }
        }
        func finish() async throws -> String {
            if waitForTranscript { return await withCheckedContinuation { finishGate = $0 } }
            return "  What is next?  "
        }
        func cancel() { cancelled += 1 }
        func speak(_ text: String) { speech.append(text) }
        func silence() {}
    }
    func testLifecycleCancelsPendingPermissionAndLateSuccessCannotListen() async {
        let audio = Audio(); audio.wait = true
        let voice = VoiceConversation(audio: audio)
        let pending = Task { await voice.start() }
        while audio.gate == nil { await Task.yield() }
        XCTAssertEqual(voice.state, .preparing)
        await voice.start()
        XCTAssertEqual(audio.starts, 1)
        voice.cancel()
        audio.gate?.resume(); await pending.value
        XCTAssertEqual(voice.state, .off)
        XCTAssertGreaterThanOrEqual(audio.cancelled, 2)
    }
    func testCancelThenRestartWaitsForOldSuccessOrFailureWithoutStaleCleanup() async {
        for fails in [false, true] {
            let audio = Audio(); audio.wait = true; audio.failStart = fails
            let voice = VoiceConversation(audio: audio)
            let old = Task { await voice.start() }
            while audio.gate == nil { await Task.yield() }
            voice.cancel()
            let cancelled = audio.cancelled
            XCTAssertFalse(voice.canStart)
            await voice.start() // restart is deliberately unavailable until preparation settles
            XCTAssertEqual(audio.starts, 1)
            audio.gate?.resume(); await old.value
            XCTAssertEqual(audio.cancelled, cancelled)
            XCTAssertTrue(voice.canStart)
            audio.wait = false; audio.failStart = false
            await voice.start()
            XCTAssertEqual(voice.state, .listening)
            XCTAssertEqual(audio.starts, 2)
        }
    }
    func testManualPrivacyLockStopsCaptureAndSpeechWithoutUnmounting() async {
        let audio = Audio(); let voice = VoiceConversation(audio: audio)
        await voice.start()
        XCTAssertEqual(voice.state, .listening)
        voice.setPrivacyLocked(true)
        XCTAssertEqual(voice.state, .off)
        XCTAssertFalse(voice.canStart)
        var submitted = false
        await voice.finish { _ in submitted = true; return true }
        await voice.start()
        XCTAssertFalse(submitted)
        XCTAssertEqual(audio.starts, 1)
        voice.setPrivacyLocked(false)
        XCTAssertEqual(voice.state, .off) // unlocking never resumes capture
        await voice.start()
        XCTAssertEqual(audio.starts, 2)
    }
    func testCaptureTimeoutCanTranscribeIntoDraftWithoutStartingSpokenAnswer() async {
        let audio = Audio(); let voice = VoiceConversation(audio: audio)
        await voice.start()
        var draft = ""
        await voice.finish(submit: false) { draft = $0; return true }
        XCTAssertEqual(draft, "What is next?")
        XCTAssertEqual(voice.state, .off)
        voice.consume([.streamingText(id: "old", text: "Old answer.", isFinal: true)], running: false)
        XCTAssertTrue(audio.speech.isEmpty)
    }
    func testCancelledTranscriptionCannotSubmitLateRecognizedText() async {
        let audio = Audio(); audio.waitForTranscript = true
        let voice = VoiceConversation(audio: audio)
        await voice.start()
        var sent = false
        let pending = Task { await voice.finish { _ in sent = true; return true } }
        while audio.finishGate == nil { await Task.yield() }
        voice.cancel()
        audio.finishGate?.resume(returning: "Late text")
        await pending.value
        XCTAssertFalse(sent)
        XCTAssertEqual(voice.state, .off)
    }
    func testActualStreamSentencesAreNotRepeatedOnReplayOrFinalReplacement() async {
        let audio = Audio(); let voice = VoiceConversation(audio: audio)
        await voice.start()
        var submitted = ""
        await voice.finish { submitted = $0; return true }
        XCTAssertEqual(submitted, "What is next?")
        voice.consume([.streamingText(id: "b1", text: "First answer. More", isFinal: false)], running: true)
        voice.consume([.streamingText(id: "b1", text: "First answer. More", isFinal: false)], running: true)
        voice.consume([.streamingText(id: "b1", text: "First answer. More detail.", isFinal: true)], running: false)
        XCTAssertEqual(audio.speech, ["First answer.", "More detail."])
        voice.cancel()
        voice.consume([.streamingText(id: "b2", text: "Late answer.", isFinal: true)], running: false)
        XCTAssertEqual(audio.speech.count, 2)
    }
    func testPreviousAnswerBaselineIsNotReadAsNewVoiceResponse() async {
        let audio = Audio(); let voice = VoiceConversation(audio: audio)
        await voice.start()
        let previous: [TimelineItem] = [.streamingText(id: "old", text: "Old answer.", isFinal: true)]
        await voice.finish { _ in
            voice.consume(previous, running: false)
            return true
        }
        voice.consume([.streamingText(id: "old", text: "New answer.", isFinal: true)], running: false)
        XCTAssertEqual(audio.speech, ["New answer."])
    }
}
