import XCTest
@testable import OmniUI

@MainActor final class ConversationSpeechTests: XCTestCase {
    final class Output: ConversationSpeechOutput {
        var texts: [String] = []
        var identifiers: [String?] = []
        var rates: [Float] = []
        var completions: [@MainActor () -> Void] = []
        var audio: [Data] = []
        var failAudio = false
        func playAudio(_ data: Data, completion: @escaping @MainActor () -> Void) throws {
            if failAudio { throw NSError(domain: "fixture", code: 1) }
            audio.append(data); completions.append(completion)
        }
        var stops = 0
        var failure: (@MainActor (String) -> Void)?
        func configureFailure(_ receive: @escaping @MainActor (String) -> Void) { failure = receive }
        func speak(_ text: String, identifier: String?, rate: Float, completion: @escaping @MainActor () -> Void) {
            texts.append(text); identifiers.append(identifier); rates.append(rate); completions.append(completion)
        }
        func stop() { stops += 1 }
    }
    func testRecordingStopsPreviewAndRejectsPlaybackUntilOwnerReleases() {
        let output = Output(); let speech = ConversationSpeech(output: output); let playbackOwner = UUID()
        speech.preview(owner: playbackOwner, identifier: "chosen", rate: 0.6)
        speech.stopPreview(owner: UUID()); speech.silence(owner: UUID())
        XCTAssertTrue(speech.isPreviewing)
        XCTAssertEqual(output.identifiers, ["chosen"]); XCTAssertEqual(output.rates, [0.6])
        let owner = UUID(); speech.beginRecording(owner: owner)
        speech.silence(owner: UUID())
        XCTAssertFalse(speech.isPreviewing)
        speech.preview(owner: playbackOwner, identifier: nil, rate: 0.5); speech.speak("No capture overlap.", owner: playbackOwner, identifier: nil, rate: 0.5)
        XCTAssertEqual(output.texts.count, 1)
        speech.endRecording(owner: UUID()) // stale device cannot release another microphone owner
        speech.preview(owner: playbackOwner, identifier: nil, rate: 0.5)
        XCTAssertEqual(output.texts.count, 1)
        speech.endRecording(owner: owner)
        speech.preview(owner: playbackOwner, identifier: nil, rate: 0.5)
        output.completions[0]() // late cancelled preview cannot clear the new preview
        XCTAssertTrue(speech.isPreviewing)
        output.completions[1]()
        XCTAssertFalse(speech.isPreviewing)
    }
    func testReplyPreemptsPreviewAndPreviewNeverPreemptsQueuedReplies() {
        let output = Output(); let speech = ConversationSpeech(output: output); let playbackOwner = UUID()
        speech.preview(owner: playbackOwner, identifier: nil, rate: 0.5)
        speech.speak("First sentence.", owner: playbackOwner, identifier: nil, rate: 0.5)
        speech.speak("Second sentence.", owner: playbackOwner, identifier: nil, rate: 0.5)
        XCTAssertFalse(speech.isPreviewing)
        let stops = output.stops
        speech.silence(owner: UUID())
        XCTAssertEqual(output.stops, stops)
        speech.preview(owner: playbackOwner, identifier: nil, rate: 0.5)
        speech.stopPreview(owner: playbackOwner) // dismissal must not silence a reply that replaced the preview
        XCTAssertEqual(output.texts.count, 3)
        output.completions[0](); output.completions[1]()
        speech.preview(owner: playbackOwner, identifier: nil, rate: 0.5)
        XCTAssertEqual(output.texts.count, 3)
        output.completions[2]()
        speech.preview(owner: playbackOwner, identifier: nil, rate: 0.5)
        XCTAssertEqual(output.texts.count, 4)
        speech.stopPreview(owner: playbackOwner); XCTAssertFalse(speech.isPreviewing)
    }
    func testPlaybackDrainWaitsForEveryQueuedSentence() async {
        let output = Output(); let speech = ConversationSpeech(output: output); let owner = UUID()
        speech.speak("First.", owner: owner, identifier: nil, rate: 0.5)
        speech.speak("Second.", owner: owner, identifier: nil, rate: 0.5)
        var drained = false
        let waiter = Task { await speech.waitForPlayback(owner: owner); drained = true }
        await Task.yield()
        output.completions[0]()
        await Task.yield()
        XCTAssertFalse(drained)
        output.completions[1]()
        await waiter.value
        XCTAssertTrue(drained)
    }
    func testSilenceReleasesDrainAndLateCallbackCannotFinishNewPlayback() async {
        let output = Output(); let speech = ConversationSpeech(output: output); let owner = UUID()
        speech.speak("Cancelled.", owner: owner, identifier: nil, rate: 0.5)
        let waiter = Task { await speech.waitForPlayback(owner: owner) }
        await Task.yield()
        speech.silence(owner: owner)
        await waiter.value
        speech.speak("Current.", owner: owner, identifier: nil, rate: 0.5)
        var drained = false
        let current = Task { await speech.waitForPlayback(owner: owner); drained = true }
        await Task.yield()
        output.completions[0]()
        await Task.yield()
        XCTAssertFalse(drained)
        output.completions[1]()
        await current.value
        XCTAssertTrue(drained)
    }
    func testPlaybackFailureReportsBeforeDrainAndIgnoresStaleOwner() async {
        let output = Output(); let speech = ConversationSpeech(output: output); let owner = UUID()
        var failure = ""
        speech.configurePlaybackFailure(owner: owner) { failure = $0 }
        let oldFailure = output.failure
        speech.speak("Reply.", owner: owner, identifier: nil, rate: 0.5)
        var drained = false
        let waiter = Task { await speech.waitForPlayback(owner: owner); drained = true }
        await Task.yield()
        output.failure?("Output route failed")
        await waiter.value
        XCTAssertEqual(failure, "Output route failed")
        XCTAssertTrue(drained)
        failure = ""
        speech.speak("Different session.", owner: UUID(), identifier: nil, rate: 0.5)
        oldFailure?("Stale error")
        XCTAssertTrue(failure.isEmpty)
    }

    func testGeneratedAudioUsesSameOwnedDrainAndCancelledCompletionCannotReleaseNewReply() async throws {
        let output = Output(); let speech = ConversationSpeech(output: output); let owner = UUID()
        try speech.playAudio(Data([1]), owner: owner)
        var drained = false
        let waiting = Task { await speech.waitForPlayback(owner: owner); drained = true }
        await Task.yield(); XCTAssertFalse(drained)
        speech.silence(owner: owner); await waiting.value
        XCTAssertTrue(drained)
        try speech.playAudio(Data([2]), owner: owner)
        var nextDrained = false
        let next = Task { await speech.waitForPlayback(owner: owner); nextDrained = true }
        await Task.yield()
        output.completions[0](); await Task.yield()
        XCTAssertFalse(nextDrained)
        output.completions[1](); await next.value
        XCTAssertTrue(nextDrained); XCTAssertEqual(output.audio, [Data([1]), Data([2])])
    }
    func testGeneratedAudioSetupFailureDoesNotStrandDrain() async {
        let output = Output(); output.failAudio = true
        let speech = ConversationSpeech(output: output); let owner = UUID()
        XCTAssertThrowsError(try speech.playAudio(Data([1]), owner: owner))
        await speech.waitForPlayback(owner: owner)
        XCTAssertTrue(output.audio.isEmpty)
    }

}
