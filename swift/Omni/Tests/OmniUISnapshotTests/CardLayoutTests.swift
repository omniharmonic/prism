@testable import OmniUI
import XCTest

final class CardLayoutTests: XCTestCase {
    func testOptionsStackOnAPhoneAndAtAccessibilitySizesAndWrapOtherwise() {
        XCTAssertTrue(CardLayout.stacksOptions(compactWidth: true, accessibilitySize: false))
        XCTAssertTrue(CardLayout.stacksOptions(compactWidth: false, accessibilitySize: true))
        XCTAssertFalse(CardLayout.stacksOptions(compactWidth: false, accessibilitySize: false))
    }

    func testOneScaleAndFullTouchTargets() {
        XCTAssertEqual(CardMetrics.padding, 12)
        XCTAssertGreaterThanOrEqual(CardMetrics.touch, 44)
    }
}

final class NeedsYouTextTests: XCTestCase {
    func testTheEmptyStateSaysWhatIsInMotion() {
        XCTAssertEqual(NeedsYouText.clear(inMotion: 0), "You're clear.")
        XCTAssertEqual(NeedsYouText.clear(inMotion: 1), "You're clear. 1 thing is in motion.")
        XCTAssertEqual(NeedsYouText.clear(inMotion: 3), "You're clear. 3 things are in motion.")
    }

    func testTheInMotionSentenceAloneForTheEmptyState() {
        XCTAssertEqual(NeedsYouText.inMotion(0), "")
        XCTAssertEqual(NeedsYouText.inMotion(1), "1 thing is in motion.")
        XCTAssertEqual(NeedsYouText.inMotion(2), "2 things are in motion.")
    }
}
