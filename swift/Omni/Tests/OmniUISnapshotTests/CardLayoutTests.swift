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
