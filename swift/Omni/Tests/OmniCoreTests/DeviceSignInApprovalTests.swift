import Foundation
import OmniClient
@testable import OmniCore
import PrismTransport
import XCTest

/// One door review R2-1: a new device signing in as the owner, while he already has one, is
/// an approval of kind `device-sign-in` in Needs you. It is Approved or Denied on an existing
/// device — never edited, never revised — through the same decide path as any approval.
@MainActor
final class DeviceSignInApprovalTests: XCTestCase {
    static let payload: [String: Any] = [
        "clientId": "omni-native", "label": "Omni on a new iPhone", "redirectUri": "http://127.0.0.1:53111/callback",
        "requestedAt": "2026-10-15T09:00:00.000Z", "ipHint": "192.168.1.x", "userAgentHint": "Omni/1.0 iOS",
    ]
    static func approval(_ id: String = "dev1", status: String = "pending") -> Approval {
        Fixture.approval(id, kind: "device-sign-in", payload: payload, status: status, threadId: nil)
    }

    private var service = FakeService()
    private func make(_ confirmation: any SendConfirmation = NoSendConfirmation()) -> ApprovalCenter {
        ApprovalCenter(service: service, sink: ErrorSink {}, confirmation: confirmation)
    }

    func testContentShowsTheClaimedNameAsAClaimAndEveryFact() {
        let c = ApprovalContent(Self.approval())
        XCTAssertEqual(c.kindLabel, "Sign in a new device")
        XCTAssertEqual(c.headline, "Sign in a new device: Omni on a new iPhone")
        XCTAssertEqual(c.fields.map(\.key), ["label", "redirectUri", "requestedAt", "ipHint", "userAgentHint", "clientId"])
        XCTAssertEqual(c.fields[0].label, "Device (its own name for itself)", "the label is marked as the device's claim")
        XCTAssertEqual(c.fields[1].value, "http://127.0.0.1:53111/callback")
        XCTAssertNotEqual(c.fields[2].value, "2026-10-15T09:00:00.000Z", "the time is shown as a moment, not raw")
        XCTAssertNil(c.body)
        // An unexpected key still shows up: nothing rides along unseen.
        var extra = Self.payload
        extra["scope"] = "owner"
        XCTAssertTrue(ApprovalContent(Fixture.approval("x", kind: "device-sign-in", payload: extra)).fields.contains { $0.key == "scope" })
    }

    /// Review round 3 (I1): the card carries the code shown on the sign-in page, first and on
    /// its own, with the instruction to compare; a card without one warns instead.
    func testTheMatchingCodeIsShownWithTheInstructionAndNotRepeatedAsARow() {
        var coded = Self.payload
        coded["matchCode"] = "482 913"
        let c = ApprovalContent(Fixture.approval("dev2", kind: "device-sign-in", payload: coded))
        XCTAssertEqual(c.matchCode, "482 913")
        XCTAssertEqual(c.matchCodeNotice, "Approve only if this code matches the one on the sign-in page")
        XCTAssertEqual(ApprovalContent.matchCodeCaption, "Code on the sign-in page")
        XCTAssertFalse(c.fields.contains { $0.key == "matchCode" }, "shown once, at the top")
        XCTAssertEqual(c.fields.map(\.key), ["label", "redirectUri", "requestedAt", "ipHint", "userAgentHint", "clientId"])
    }

    func testACardWithoutAMatchingCodeWarnsAndStillShowsEverything() {
        let c = ApprovalContent(Self.approval())
        XCTAssertNil(c.matchCode)
        XCTAssertEqual(c.matchCodeNotice, "No matching code — do not approve unless you are sure")
        XCTAssertEqual(c.fields.count, 6)
        var blank = Self.payload
        blank["matchCode"] = "   "
        XCTAssertNil(ApprovalContent(Fixture.approval("dev3", kind: "device-sign-in", payload: blank)).matchCode, "a blank code is no code")
        // Other kinds never get a code or a notice, whatever their payload carries.
        let email = ApprovalContent(Fixture.approval("e1", kind: "email", payload: ["to": ["a@b.co"], "subject": "s", "body": "b", "matchCode": "1"]))
        XCTAssertNil(email.matchCode)
        XCTAssertNil(email.matchCodeNotice)
        XCTAssertTrue(email.fields.contains { $0.key == "matchCode" }, "shown as an ordinary extra key there")
    }

    func testItIsNeverEditedOrRevisedOnlyApprovedOrDenied() {
        let center = make()
        center.ingest([Self.approval()])
        let card = center.card(for: "dev1")!
        XCTAssertTrue(card.isDeviceSignIn)
        XCTAssertNil(ApprovalDraft(card.approval))
        XCTAssertFalse(card.canOfferEdit())
        XCTAssertFalse(card.canOfferRevise())
        XCTAssertTrue(card.canOfferSend())
        XCTAssertTrue(card.canOfferCancel())
        XCTAssertEqual(card.statusLine(), "A device is asking to sign in as you. Approve only if you started this sign-in yourself, just now. If you didn't, deny it.")
    }

    func testApproveGoesThroughTheDecidePathAfterConfirmationOnThisDevice() async {
        let confirmation = FakeConfirmation(true)
        service.decisions(.success(ApprovalDecision(approval: Self.approval(status: "sent"), turnId: nil, replayed: false, httpStatus: 200)))
        let center = make(confirmation)
        center.ingest([Self.approval()])
        await center.send("dev1")
        XCTAssertEqual(service.decides.count, 1)
        XCTAssertEqual(service.decides[0].decision, .send)
        XCTAssertEqual(service.decides[0].digest, Self.approval().digest)
        XCTAssertEqual(confirmation.reasons, ["approve this device sign-in"])
        XCTAssertEqual(center.card(for: "dev1")?.statusLine(), "Approved — that device can finish signing in.")
    }

    func testDenyIsTheCancelDecisionAndAnUnconfirmedApproveDecidesNothing() async {
        let unconfirmed = make(FakeConfirmation(false))
        unconfirmed.ingest([Self.approval()])
        await unconfirmed.send("dev1")
        XCTAssertTrue(service.decides.isEmpty)
        XCTAssertEqual(unconfirmed.card(for: "dev1")?.notice?.text, "Not approved — it wasn't confirmed on this device.")

        service.decisions(.success(ApprovalDecision(approval: Self.approval(status: "cancelled"), turnId: nil, replayed: false, httpStatus: 200)))
        let center = make()
        center.ingest([Self.approval()])
        await center.cancel("dev1")
        XCTAssertEqual(service.decides.map(\.decision), [.cancel])
        XCTAssertEqual(center.card(for: "dev1")?.statusLine(), "Denied — the device was not signed in.")
    }
}
