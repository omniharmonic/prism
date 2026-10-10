import XCTest
@testable import OmniCore

final class WakePhraseMatcherTests: XCTestCase {
    func testWholeWordsCaseAndPunctuationUseProductionMatcher() {
        for text in ["Hey Omni", "HEY, OMNI!", "please, hey Omni", "hey\nomni", "hey omni hey omni"] {
            XCTAssertTrue(WakePhraseMatcher.matches(text), text)
        }
        for text in ["they omni", "hey omniscient", "heyomni", "hey only", "omni hey", "hey my omni", ""] {
            XCTAssertFalse(WakePhraseMatcher.matches(text), text)
        }
    }
    func testOldPhraseOutsideBoundedPreviewCannotWakeAndClippedWordsAreIgnored() {
        XCTAssertFalse(WakePhraseMatcher.matches("hey omni " + String(repeating: "x", count: 5000)))
        // Suffix starts at the h in they: never mistake the clipped word for hey.
        let tail = "they omni " + String(repeating: ".", count: WakePhraseMatcher.maximumCharacters - 9)
        XCTAssertFalse(WakePhraseMatcher.matches(tail))
        XCTAssertTrue(WakePhraseMatcher.matches(String(repeating: "x", count: 5000) + " hey omni"))
    }
    func testRepeatedPartialPhraseAndStaleCallbacksActivateOnlyOnce() {
        var epoch = WakeRecognitionEpoch()
        let first = epoch.begin()
        var activations = 0
        for phrase in ["hey omni", "hey omni please", "hey omni hey omni"] {
            if WakePhraseMatcher.matches(phrase), epoch.consumeWake(first) { activations += 1 }
        }
        XCTAssertEqual(activations, 1)
        let second = epoch.begin()
        XCTAssertFalse(epoch.consumeWake(first))
        epoch.invalidate()
        XCTAssertFalse(epoch.consumeWake(second), "Disabled/preempted capture cannot activate late")
    }

}
