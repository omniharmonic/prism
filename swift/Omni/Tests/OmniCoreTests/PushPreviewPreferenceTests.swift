@testable import OmniCore
import XCTest

final class PushPreviewPreferenceTests: XCTestCase {
    func testNeverChosenSendsNothingAndShowsTitleAndPreview() {
        XCTAssertNil(PushPreviewPreference.sent(stored: nil))
        XCTAssertEqual(PushPreviewPreference.shown(stored: nil), "title_preview")
        // Something unreadable in storage counts as never chosen, not as generic.
        XCTAssertNil(PushPreviewPreference.sent(stored: "loud"))
        XCTAssertEqual(PushPreviewPreference.shown(stored: "loud"), "title_preview")
    }

    func testAnExplicitChoiceIsSentAndShown() {
        for value in ["generic", "title", "title_preview"] {
            XCTAssertEqual(PushPreviewPreference.sent(stored: value), value)
            XCTAssertEqual(PushPreviewPreference.shown(stored: value), value)
        }
    }
}
