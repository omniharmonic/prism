import Foundation
import XCTest
@testable import OmniCore

final class PushEnvironmentTests: XCTestCase {
    private func executable(_ value: String?) throws -> Data {
        let plist = try PropertyListSerialization.data(fromPropertyList: value.map { ["aps-environment": $0] } ?? [:], format: .xml, options: 0)
        func word(_ value: UInt32, big: Bool = false) -> Data {
            let shifts = big ? [24, 16, 8, 0] : [0, 8, 16, 24]
            return Data(shifts.map { UInt8(truncatingIfNeeded: value >> $0) })
        }
        var bytes = Data(count: 32)
        bytes.replaceSubrange(0..<4, with: word(0xfeedfacf))
        bytes.replaceSubrange(16..<20, with: word(1))
        let signatureLength = UInt32(28 + plist.count)
        for value in [UInt32(0x1d), 16, 48, signatureLength] { bytes.append(word(value)) }
        for value in [UInt32(0xfade0cc0), signatureLength, 1, 5, 20, 0xfade7171, UInt32(8 + plist.count)] { bytes.append(word(value, big: true)) }
        bytes.append(plist)
        return bytes
    }

    func testSigningEnvironmentIsReadFromEntitlement() throws {
        XCTAssertEqual(PushEnvironment.entitlement(in: try executable("development")), "sandbox")
        XCTAssertEqual(PushEnvironment.entitlement(in: try executable("production")), "production")
    }

    func testUniversalMacSignatureAndOutOfBoundsSlice() throws {
        let slice = try executable("production")
        func big(_ value: UInt32) -> Data { Data([24, 16, 8, 0].map { UInt8(truncatingIfNeeded: value >> $0) }) }
        var fat = Data()
        for value in [UInt32(0xcafebabe), 1, 0x0100000c, 0, 28, UInt32(slice.count), 0] { fat.append(big(value)) }
        fat.append(slice)
        XCTAssertEqual(PushEnvironment.entitlement(in: fat), "production")
        fat.replaceSubrange(16..<20, with: [255, 255, 255, 255])
        XCTAssertNil(PushEnvironment.entitlement(in: fat))
    }

    func testUnsignedAndMalformedExecutablesFailClosed() throws {
        XCTAssertNil(PushEnvironment.entitlement(in: Data()))
        XCTAssertNil(PushEnvironment.entitlement(in: try executable(nil)))
        XCTAssertNil(PushEnvironment.entitlement(in: try executable("unknown")))
        let bytes = try executable("development")
        for count in [4, 31, 40, 48, bytes.count - 1] {
            XCTAssertNil(PushEnvironment.entitlement(in: bytes.prefix(count)))
        }
        var broken = bytes
        broken.replaceSubrange(40..<44, with: [255, 255, 255, 255])
        XCTAssertNil(PushEnvironment.entitlement(in: broken))
    }
}
