#if os(macOS)
import AppKit
import OmniClient
@testable import OmniCore
@testable import OmniUI
import SwiftUI
import XCTest

/// One door review R2-1: the `device-sign-in` card, drawn off-screen. The pictures go to a
/// temporary folder (or `OMNI_SNAPSHOT_DIR`) so this test never rewrites the tracked set
/// under qa/screenshots.
@MainActor
final class DeviceSignInSnapshotTests: XCTestCase {
    static let payload: [String: Any] = [
        "clientId": "omni-native", "label": "Omni on a new iPhone", "redirectUri": "http://127.0.0.1:53111/callback",
        "requestedAt": "2026-10-15T09:00:00.000Z", "ipHint": "192.168.1.x", "userAgentHint": "Omni/1.0 iOS",
    ]

    var root: URL {
        if let custom = ProcessInfo.processInfo.environment["OMNI_SNAPSHOT_DIR"], !custom.isEmpty { return URL(fileURLWithPath: custom) }
        return FileManager.default.temporaryDirectory.appendingPathComponent("omni-device-sign-in-snapshots")
    }

    func testTheSignInCardRendersWithApproveAndDenyInLightDarkAndLargeText() async throws {
        NSApplication.shared.setActivationPolicy(.prohibited)
        for (name, dark, size) in [("device-sign-in/light", false, DynamicTypeSize.large), ("device-sign-in/dark", true, .large), ("device-sign-in/accessibility", false, .accessibility3)] {
            let service = SampleService()
            var row = SampleService.draft("dev1", thread: "", kind: "device-sign-in", payload: Self.payload, executor: ["name": "device-sign-in", "available": true, "enabled": true])
            row["threadId"] = NSNull()
            row["summary"] = "Sign in a new device"
            service.addApproval(row)
            let session = SessionModel(service: service) {}
            await session.approvals.refresh()
            let card = try XCTUnwrap(session.approvals.card(for: "dev1"))
            XCTAssertTrue(card.isDeviceSignIn && card.canOfferSend() && card.canOfferCancel() && !card.canOfferEdit() && !card.canOfferRevise())
            var walk = Walk(variant: .init(folder: name, size: CGSize(width: 420, height: 520), dark: dark), root: root)
            try await walk.draw("card", settle: .milliseconds(300), ApprovalCardView(center: session.approvals, id: "dev1").dynamicTypeSize(size).padding(16).frame(maxHeight: .infinity, alignment: .top))
            XCTAssertEqual(walk.count, 1)
            let image = try XCTUnwrap(NSBitmapImageRep(data: Data(contentsOf: root.appendingPathComponent("\(name)/01-card.png"))))
            var colors = Set<String>()
            for y in stride(from: 0, to: image.pixelsHigh, by: 12) {
                for x in stride(from: 0, to: image.pixelsWide, by: 12) {
                    if let color = image.colorAt(x: x, y: y) { colors.insert(color.description) }
                }
            }
            XCTAssertGreaterThan(colors.count, 8, "the sign-in card must contain rendered content (\(name))")
        }
    }
}
#endif
