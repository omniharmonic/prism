import Foundation
import XCTest
@testable import OmniUI

final class NotificationCompletionTests: XCTestCase {
    @MainActor func testCompletionIsPromptAndExactlyOnceForEveryPayload() {
        for value in [nil, "invalid", "https://example.com", "omni://thread/cold-tap"] as [String?] {
            var count = 0
            NativeNotifications.shared.completeResponse(value) {
                XCTAssertTrue(Thread.isMainThread)
                count += 1
            }
            XCTAssertEqual(count, 1)
        }
    }
}
