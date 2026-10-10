import XCTest
@testable import OmniCore

final class SpeechTextTests: XCTestCase {
    func testProjectsMarkdownWithoutChangingMeaningfulNumbersAndNames() {
        let original = "# Hello, **Benjamin**\n- Ask [Omni](https://example.com) about `Prism`.\n1. Cost is $3.14; meet at 10:30.\n- [x] Ready?"
        XCTAssertEqual(SpeechText.narration(from: original), "Hello, Benjamin\nAsk Omni about Prism.\nCost is $3.14; meet at 10:30.\nReady?")
        XCTAssertTrue(original.contains("**Benjamin**"))
    }
    func testSuppressesFencedCodeImagesTablesAndExplicitToolBlocks() {
        let markdown = "Answer.\n```swift\nprint(1)\n```\n![chart](image.png)\n| log | value |\n<tool_result>\nsecret log\n</tool_result>\nContinue."
        XCTAssertEqual(SpeechText.narration(from: markdown), "Answer.\nContinue.")
    }
    func testUnclosedFenceCannotLeakCodeIntoNarration() {
        XCTAssertEqual(SpeechText.narration(from: "Answer.\n~~~python\nprint('hidden')"), "Answer.")
    }
    func testOrdinaryProseMathAndIdentifiersRemain() {
        let text = "Is 2 * 3 equal to 6? Use snake_case. Dr. Smith said yes... Take your time."
        XCTAssertEqual(SpeechText.narration(from: text), text)
    }
    func testNoInventedSummaryForCodeOnlyAnswer() {
        XCTAssertEqual(SpeechText.narration(from: "```\ncode\n```"), "")
    }
    func testReferenceLinksQuotesAndDividers() {
        XCTAssertEqual(SpeechText.narration(from: "> *Read* [the note][n].\n[n]: https://example.com\n---"), "Read the note.")
    }
    func testHermesAudioAttachmentAndCachePlumbingIsNotNarratedAgain() {
        let markdown = "The answer is ready.\nMEDIA:/tmp/hermes/audio_cache/tts_123.mp3\nAudio path: `/Users/owner/.hermes/audio_cache/reply.wav`\n[Listen](file:///tmp/reply.mp3)\n{\"audio_path\":\"/tmp/reply.ogg\"}\nWe can continue."
        XCTAssertEqual(SpeechText.narration(from: markdown), "The answer is ready.\nWe can continue.")
        XCTAssertTrue(markdown.contains("audio_cache"), "Chat content remains untouched")
    }
    func testAudioFilenameDiscussionIsStillReadable() {
        XCTAssertEqual(SpeechText.narration(from: "Use an MP3 file named answer.mp3. The notes are in Prism."), "Use an MP3 file named answer.mp3. The notes are in Prism.")
    }

}
