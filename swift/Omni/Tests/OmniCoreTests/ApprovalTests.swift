import Foundation
import OmniClient
@testable import OmniCore
import PrismTransport
import XCTest

@MainActor
final class ApprovalContentTests: XCTestCase {
    func testAnEmailShowsRecipientsSubjectAndTheWholeBody() {
        let long = String(repeating: "A long paragraph. ", count: 400)
        let approval = Fixture.approval("a", payload: ["to": ["dana@example.com", "tim@example.com"], "cc": ["kevin@example.com"], "subject": "Budget", "body": long])
        let content = ApprovalContent(approval)
        XCTAssertEqual(content.kindLabel, "Email")
        XCTAssertEqual(content.fields.map(\.label), ["To", "Cc", "Subject"])
        XCTAssertEqual(content.fields[0].value, "dana@example.com, tim@example.com")
        XCTAssertEqual(content.body, long, "the body is never truncated")
        XCTAssertEqual(content.headline, "Email to dana@example.com, tim@example.com")
    }

    func testAKeyThisBuildDoesNotKnowIsStillShown() {
        let approval = Fixture.approval("a", payload: ["to": ["dana@example.com"], "subject": "S", "body": "B", "bcc": ["hidden@example.com"], "attachments": [["name": "x.pdf"]]])
        let content = ApprovalContent(approval)
        XCTAssertEqual(content.fields.map(\.key), ["to", "subject", "attachments", "bcc"])
        XCTAssertEqual(content.fields.first { $0.key == "bcc" }?.value, "hidden@example.com")
        XCTAssertEqual(content.fields.first { $0.key == "attachments" }?.value, #"[{"name":"x.pdf"}]"#)
    }

    func testEveryKindHasItsFields() {
        let invite = ApprovalContent(Fixture.approval("i", kind: "calendar-invite", payload: ["title": "Budget review", "start": "2026-10-14T10:00:00-06:00", "end": "2026-10-14T10:45:00-06:00", "attendees": ["tim@example.com"], "description": "Agenda"]))
        XCTAssertEqual(invite.fields.map(\.label), ["Title", "Starts", "Ends", "Attendees"])
        XCTAssertEqual(invite.body, "Agenda")
        XCTAssertEqual(invite.headline, "Invite to tim@example.com")
        let wallet = ApprovalContent(Fixture.approval("w", kind: "wallet-proposal", payload: ["to": "0xabc", "amount": "50", "token": "USDC", "chain": "base", "purpose": "Bounty"]))
        XCTAssertEqual(wallet.fields.map(\.value), ["0xabc", "50", "USDC", "base"])
        XCTAssertEqual(wallet.body, "Bounty")
        let future = ApprovalContent(Fixture.approval("f", kind: "carrier-pigeon", payload: ["wing": "left"]))
        XCTAssertEqual(future.kindLabel, "Carrier pigeon")
        XCTAssertEqual(future.fields.map(\.value), ["left"])
    }

    func testADraftEditChangesOnlyTheTextItEdits() {
        let approval = Fixture.approval("a")
        var draft = ApprovalDraft(approval)!
        XCTAssertEqual(draft.fields.map(\.key), ["subject", "body"])
        XCTAssertFalse(draft.hasChanges)
        draft.fields[1].text = "Shorter."
        XCTAssertTrue(draft.hasChanges)
        XCTAssertEqual(draft.payload["body"]?.stringValue, "Shorter.")
        XCTAssertEqual(draft.payload["to"], approval.payload["to"])
        XCTAssertEqual(draft.payload["subject"]?.stringValue, "Budget call")
        XCTAssertNil(ApprovalDraft(Fixture.approval("w", kind: "wallet-proposal", payload: ["to": "0xabc", "amount": "1", "chain": "base", "purpose": "x"])), "a wallet proposal is not edited here")
    }
}

@MainActor
final class ApprovalCenterTests: XCTestCase {
    private var service = FakeService()
    private var signedOut = Counter()

    private func make(_ confirmation: any SendConfirmation = NoSendConfirmation()) -> ApprovalCenter {
        let counter = signedOut
        return ApprovalCenter(service: service, sink: ErrorSink { counter.bump() }, confirmation: confirmation)
    }

    private func decided(_ id: String, _ status: String, result: [String: Any]? = nil, http: Int = 200, replayed: Bool = false) -> ApprovalDecision {
        ApprovalDecision(approval: Fixture.approval(id, status: status, result: result), turnId: nil, replayed: replayed, httpStatus: http)
    }

    func testRefreshFillsTheQueueInTheServersOrder() async {
        service.pending(.success([Fixture.approval("new"), Fixture.approval("old")]))
        let center = make()
        await center.refresh()
        XCTAssertEqual(center.phase, .loaded)
        XCTAssertEqual(center.pending.map(\.id), ["new", "old"])
        XCTAssertEqual(center.pendingCount, 2)
        XCTAssertTrue(center.card(for: "new")!.canOfferSend())
        XCTAssertNil(center.card(for: "new")!.statusLine())
    }

    func testADigestMismatchIsNeverOfferedForSendAndNothingIsSent() async {
        let tampered = Fixture.approval("apr1", digest: String(repeating: "0", count: 64))
        XCTAssertFalse(tampered.digestMatchesPayload)
        let center = make()
        center.ingest([tampered])
        let card = center.card(for: "apr1")!
        XCTAssertEqual(card.standing(), .mismatch)
        XCTAssertFalse(card.canOfferSend())
        XCTAssertFalse(card.canOfferCancel())
        XCTAssertFalse(card.canOfferEdit())
        XCTAssertEqual(card.statusLine(), "This draft doesn't match the fingerprint the server gave for it, so Omni won't offer to send it. Reload it.")
        await center.send("apr1")
        XCTAssertTrue(service.decides.isEmpty, "a mismatched draft must not reach the server")
        XCTAssertEqual(center.card(for: "apr1")?.notice?.tone, .failure)

        // Reload brings the real draft; Send is offered again.
        service.approvalReads(.success(Fixture.approval("apr1")))
        await center.reload("apr1")
        XCTAssertTrue(center.card(for: "apr1")!.canOfferSend())
        XCTAssertNil(center.card(for: "apr1")?.notice)
    }

    func testSendDecidesOnTheDraftShownAndShowsSent() async {
        let confirmation = FakeConfirmation(true)
        service.decisions(.success(decided("apr1", "sent", result: ["messageId": "m1"])))
        let center = make(confirmation)
        center.ingest([Fixture.approval("apr1")])
        await center.send("apr1")
        XCTAssertEqual(service.decides.count, 1)
        XCTAssertEqual(service.decides[0].decision, .send)
        XCTAssertEqual(service.decides[0].digest, Fixture.approval("apr1").digest)
        XCTAssertEqual(confirmation.reasons, ["send this email"])
        let card = center.card(for: "apr1")!
        XCTAssertEqual(card.standing(), .sent)
        XCTAssertEqual(card.statusLine(), "Sent.")
        XCTAssertFalse(card.canOfferSend())
        XCTAssertTrue(center.pending.isEmpty)
        XCTAssertNil(center.keptKey(for: "apr1"))
    }

    func testWithoutConfirmationOnTheDeviceNothingIsSent() async {
        let center = make(FakeConfirmation(false))
        center.ingest([Fixture.approval("apr1")])
        await center.send("apr1")
        XCTAssertTrue(service.decides.isEmpty)
        XCTAssertEqual(center.card(for: "apr1")?.notice?.text, "Not sent — it wasn't confirmed on this device.")
        XCTAssertEqual(center.card(for: "apr1")?.standing(), .pending)
        // Cancel needs no confirmation.
        service.decisions(.success(decided("apr1", "cancelled")))
        await center.cancel("apr1")
        XCTAssertEqual(center.card(for: "apr1")?.statusLine(), "Cancelled — nothing was sent.")
    }

    func testAnExecutorThatIsOffIsReportedHonestlyAndTheDraftStaysPending() async {
        service.decisions(.failure(OmniError.executorNotReady(code: "executor_disabled", executor: "proton-send")))
        let center = make()
        center.ingest([Fixture.approval("apr1", executorEnabled: false)])
        XCTAssertEqual(center.card(for: "apr1")?.sendingSwitchedOff, "Sending is switched off on this server.")
        await center.send("apr1")
        let card = center.card(for: "apr1")!
        XCTAssertEqual(card.notice, .init(tone: .warning, text: "Sending is switched off on this server — nothing was sent. The draft is still waiting."))
        XCTAssertEqual(card.standing(), .pending)
        XCTAssertNil(card.retry, "a refused send is not a decision; there is nothing to retry")
        XCTAssertEqual(center.pending.map(\.id), ["apr1"])
        // A new press is a new press: a new key.
        await center.send("apr1")
        XCTAssertEqual(service.decides.count, 2)
        XCTAssertNotEqual(service.decides[0].key, service.decides[1].key)
    }

    func testAnExecutorThatDoesNotExistYetSaysSo() async {
        service.decisions(.failure(OmniError.executorNotReady(code: "executor_unavailable", executor: nil)))
        let center = make()
        center.ingest([Fixture.approval("t", kind: "tweet", payload: ["text": "hello"])])
        await center.send("t")
        XCTAssertEqual(center.card(for: "t")?.notice?.text, "This server can't send this kind of thing yet — nothing was sent. The draft is still waiting.")
    }

    func testFailedMeansProvablyNotSentAndUnknownMeansItMayHaveBeen() async {
        service.decisions(
            .success(decided("f", "failed", result: ["error": "recipient_refused"], http: 422)),
            .success(decided("u", "unknown", http: 502))
        )
        let center = make()
        center.ingest([Fixture.approval("f"), Fixture.approval("u")])
        await center.send("f")
        await center.send("u")
        let failed = center.card(for: "f")!
        let unknown = center.card(for: "u")!
        XCTAssertEqual(failed.standing(), .failed)
        XCTAssertEqual(failed.statusLine(), "Not sent — the attempt failed before anything went out (recipient_refused).")
        XCTAssertEqual(unknown.standing(), .unknown)
        XCTAssertEqual(unknown.statusLine(), "This may have been sent — the sender never confirmed. Check before sending it again.")
        // Neither can be sent again from here.
        XCTAssertFalse(failed.canOfferSend())
        XCTAssertFalse(unknown.canOfferSend())
        XCTAssertNil(unknown.retry)
        await center.send("u")
        XCTAssertEqual(service.decides.count, 2)
    }

    func testAnUnclearOutcomeKeepsTheKeyAndTryAgainResendsIt() async {
        service.decisions(.failure(Fixture.unknownOutcome), .failure(PrismError.unreachable("offline")), .success(decided("apr1", "sent", replayed: true)))
        let center = make()
        center.ingest([Fixture.approval("apr1")])
        await center.send("apr1")
        var card = center.card(for: "apr1")!
        XCTAssertEqual(card.retry, .send)
        XCTAssertEqual(card.notice?.text, "It isn't clear whether this went through. Try again — the server will not act on it twice.")
        XCTAssertEqual(card.standing(), .pending)
        let kept = center.keptKey(for: "apr1")
        XCTAssertNotNil(kept)

        await center.retry("apr1")
        card = center.card(for: "apr1")!
        XCTAssertEqual(card.notice?.text, "Can't reach the server. Nothing was sent.")
        XCTAssertEqual(card.retry, .send)

        // Pressing Send again instead of Try again is the same action: the same key.
        await center.send("apr1")
        XCTAssertEqual(service.decides.map(\.key), [kept!, kept!, kept!])
        XCTAssertEqual(center.card(for: "apr1")?.standing(), .sent)
        XCTAssertNil(center.card(for: "apr1")?.retry)
        XCTAssertNil(center.keptKey(for: "apr1"))
    }

    func testAKeptKeyIsNotReusedForADifferentDecision() async {
        service.decisions(.failure(Fixture.unknownOutcome), .success(decided("apr1", "cancelled")))
        let center = make()
        center.ingest([Fixture.approval("apr1")])
        await center.send("apr1")
        await center.cancel("apr1")
        XCTAssertEqual(service.decides.map(\.decision), [.send, .cancel])
        XCTAssertNotEqual(service.decides[0].key, service.decides[1].key)
    }

    func testAChangedDraftOnTheServerIsShownAgainInsteadOfSent() async {
        let changed = Fixture.approval("apr1", payload: ["to": ["dana@example.com"], "subject": "Budget call", "body": "A different body."])
        service.decisions(.failure(PrismError.conflict(Fixture.failure(409, "digest_mismatch"))))
        service.approvalReads(.success(changed))
        let center = make()
        center.ingest([Fixture.approval("apr1")])
        await center.send("apr1")
        let card = center.card(for: "apr1")!
        XCTAssertEqual(service.approvalReadIDs, ["apr1"])
        XCTAssertEqual(card.approval.payload["body"]?.stringValue, "A different body.")
        XCTAssertEqual(card.notice?.text, "The draft changed on the server. Review the latest version.")
        XCTAssertNil(card.retry)
        XCTAssertNil(center.keptKey(for: "apr1"))
        XCTAssertTrue(card.canOfferSend(), "the new version can be reviewed and sent with a new press")
    }

    func testAlreadyDecidedElsewhereShowsWhatHappened() async {
        service.decisions(.failure(PrismError.conflict(Fixture.failure(409, "already_decided"))))
        service.approvalReads(.success(Fixture.approval("apr1", status: "sent")))
        let center = make()
        center.ingest([Fixture.approval("apr1")])
        await center.send("apr1")
        XCTAssertEqual(center.card(for: "apr1")?.standing(), .sent)
        XCTAssertEqual(center.card(for: "apr1")?.notice?.text, "This was already decided.")
    }

    func testAnExpiredDraftCannotBeSent() async {
        let center = make()
        center.ingest([Fixture.approval("apr1", expiresAt: "2020-01-01T00:00:00.000Z")])
        let card = center.card(for: "apr1")!
        XCTAssertEqual(card.standing(), .expired)
        XCTAssertFalse(card.canOfferSend())
        await center.send("apr1")
        XCTAssertTrue(service.decides.isEmpty)
    }

    func testSignedOutDuringADecisionGoesToTheApp() async {
        service.decisions(.failure(PrismError.signedOut))
        let center = make()
        center.ingest([Fixture.approval("apr1")])
        await center.send("apr1")
        XCTAssertEqual(signedOut.count, 1)
        XCTAssertEqual(center.card(for: "apr1")?.activity, .idle)
    }

    func testReviseSendsTheFeedback() async {
        service.decisions(.success(ApprovalDecision(approval: Fixture.approval("apr1", status: "revised"), turnId: "turn9", replayed: false, httpStatus: 200)))
        let center = make()
        var changedThreads: [String] = []
        center.threadDidChange = { changedThreads.append($0) }
        center.ingest([Fixture.approval("apr1")])
        await center.revise("apr1", feedback: "  make it shorter ")
        XCTAssertEqual(service.decides[0].decision, .revise)
        XCTAssertEqual(service.decides[0].feedback, "make it shorter")
        XCTAssertEqual(center.card(for: "apr1")?.notice?.text, "Omni is writing a new draft.")
        XCTAssertEqual(center.card(for: "apr1")?.statusLine(), "Replaced by a newer draft.")
        XCTAssertEqual(changedThreads, ["t1"])
    }

    func testAnEditReplacesTheDraftEverywhere() async {
        let original = Fixture.approval("apr1")
        var draft = ApprovalDraft(original)!
        draft.fields[1].text = "Shorter."
        let replacement = Fixture.approval("apr2", payload: ["to": ["dana@example.com"], "subject": "Budget call", "body": "Shorter."])
        service.edits(.success(Fixture.decode(["approval": Fixture.approvalJSON("apr2", payload: ["to": ["dana@example.com"], "subject": "Budget call", "body": "Shorter."]), "replaced": "apr1"])))
        let center = make()
        center.ingest([original])
        let saved = await center.saveEdit("apr1", draft: draft)
        XCTAssertTrue(saved)
        XCTAssertEqual(service.editedPayloads, [draft.payload])
        // The thread's card (which still carries the old id) now shows the new draft.
        XCTAssertEqual(center.card(for: "apr1")?.id, "apr2")
        XCTAssertEqual(center.card(for: "apr1")?.approval.digest, replacement.digest)
        XCTAssertEqual(center.pending.map(\.id), ["apr2"])
        XCTAssertEqual(center.card(for: "apr2")?.notice?.text, "Edited. Review it before sending.")
        // Once the server lists the old one as revised, each id shows its own card again.
        center.ingest([Fixture.approval("apr1", status: "revised"), replacement])
        XCTAssertEqual(center.card(for: "apr1")?.standing(), .revised)
        XCTAssertEqual(center.pending.map(\.id), ["apr2"])
    }

    func testAnUnchangedEditSendsNothingAndAnUnclearEditReadsTheQueue() async {
        let original = Fixture.approval("apr1")
        let center = make()
        center.ingest([original])
        let unchanged = await center.saveEdit("apr1", draft: ApprovalDraft(original)!)
        XCTAssertTrue(unchanged)
        XCTAssertTrue(service.editedPayloads.isEmpty)

        var draft = ApprovalDraft(original)!
        draft.fields[0].text = "New subject"
        service.edits(.failure(Fixture.unknownOutcome))
        service.pending(.success([original]))
        let saved = await center.saveEdit("apr1", draft: draft)
        XCTAssertFalse(saved)
        XCTAssertEqual(service.editedPayloads.count, 1, "an edit has no idempotency key: never retried automatically")
        XCTAssertEqual(service.pendingReads, 1)
        XCTAssertEqual(center.card(for: "apr1")?.notice?.tone, .warning)
    }

    func testADraftThatLeftTheQueueIsReadOnceMore() async {
        service.pending(.success([Fixture.approval("a"), Fixture.approval("b")]), .success([Fixture.approval("b")]))
        service.approvalReads(.success(Fixture.approval("a", status: "sent")))
        let center = make()
        await center.refresh()
        await center.refresh()
        XCTAssertEqual(service.approvalReadIDs, ["a"])
        XCTAssertEqual(center.card(for: "a")?.standing(), .sent)
        XCTAssertEqual(center.pending.map(\.id), ["b"])
    }

    func testAFailedRefreshIsPlainLanguage() async {
        service.pending(.failure(PrismError.forbidden(Fixture.failure(403, "forbidden"))))
        let center = make()
        await center.refresh()
        XCTAssertEqual(center.phase.failure, "This account isn't allowed to use Omni on this server. Omni is for the server's owner.")
    }
}
