import XCTest
@testable import OmniUI

@MainActor final class ConversationSpeechTests: XCTestCase {
    final class Output: ConversationSpeechOutput {
        var texts: [String] = []
        var identifiers: [String?] = []
        var rates: [Float] = []
        var completions: [@MainActor () -> Void] = []
        var stops = 0
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
}
