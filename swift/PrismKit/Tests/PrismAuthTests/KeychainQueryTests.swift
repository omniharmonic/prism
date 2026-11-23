import Foundation
@testable import PrismAuth
import Security
import XCTest

final class KeychainQueryTests: XCTestCase {
    /// Every keychain query must name its keychain explicitly (true or false); an absent key
    /// makes macOS search/delete both keychains.
    func testQueryAlwaysSetsDataProtectionAttribute() throws {
        let origin = try ServerOrigin("https://example.test")
        for flag in [true, false] {
            let store = KeychainTokenStore(service: "test.svc", useDataProtectionKeychain: flag)
            let q = store.baseQuery(origin)
            XCTAssertEqual(q[kSecUseDataProtectionKeychain as String] as? Bool, flag, "flag=\(flag)")
        }
    }
}
