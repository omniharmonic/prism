import Foundation
import OmniClient
@testable import OmniCore
import PrismAuth
import PrismTransport
import XCTest

/// The small things the UI pass changed after looking at the screens.
@MainActor
final class PolishTests: XCTestCase {
    private let us = Locale(identifier: "en_US")

    /// Dates are formatted with a narrow no-break space before AM/PM; compare with a plain one.
    private func plain(_ text: String?) -> String? { text?.replacingOccurrences(of: "\u{202F}", with: " ") }
    private func words(_ cron: String, locale: Locale) -> String? { plain(JobPresentation.cronInWords(cron, locale: locale)) }

    func testCronLinesAreSaidInWordsAndUnusualOnesAreLeftAlone() {
        XCTAssertEqual(words("0 7 * * *", locale: us), "Every day at 7:00 AM")
        XCTAssertEqual(words("*/30 * * * *", locale: us), "Every 30 minutes")
        XCTAssertEqual(words("0 */2 * * *", locale: us), "Every 2 hours")
        XCTAssertEqual(words("0 * * * *", locale: us), "Every hour")
        XCTAssertEqual(words("15 * * * *", locale: us), "Every hour at :15")
        XCTAssertEqual(words("0 16 * * 5", locale: us), "Every Friday at 4:00 PM")
        XCTAssertEqual(words("30 8 * * 1-5", locale: us), "Weekdays at 8:30 AM")
        // Not guessed at: a day of the month, a list, a word, a six-field line.
        for odd in ["0 7 1 * *", "0 7,19 * * *", "hourly", "0 0 7 * * *", "0 7 * 3 *", "61 7 * * *", ""] {
            XCTAssertNil(JobPresentation.cronInWords(odd, locale: us), odd)
        }
    }

    func testATasksDueDateReadsAsADay() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/Denver")!
        let now = calendar.date(from: DateComponents(year: 2026, month: 10, day: 9, hour: 15))!
        func due(_ s: String?) -> String? { TodayModel.dueText(s, now: now, calendar: calendar, locale: us) }
        XCTAssertEqual(due("2026-10-09"), "Today")
        XCTAssertEqual(due("2026-10-10"), "Tomorrow")
        XCTAssertEqual(due("2026-10-08"), "Yesterday")
        XCTAssertEqual(due("2026-10-14"), "Oct 14")
        XCTAssertEqual(due("2026-10-14T09:00:00-06:00"), "Oct 14")
        XCTAssertEqual(due("2027-01-03"), "Jan 3, 2027")
        XCTAssertNil(due("soon"))
        XCTAssertNil(due(""))
        XCTAssertNil(due(nil))
    }

    func testAnInvitesTimesAreShownAsMomentsInThisDevicesZoneAndOddOnesAsStored() {
        let denver = TimeZone(identifier: "America/Denver")!
        XCTAssertEqual(plain(ApprovalContent.momentText("2026-10-14T10:00:00-06:00", timeZone: denver, locale: us)), "Wed, Oct 14, 2026 at 10:00 AM MDT")
        // The same instant written in another zone is the same moment here.
        XCTAssertEqual(plain(ApprovalContent.momentText("2026-10-14T16:00:00Z", timeZone: denver, locale: us)), "Wed, Oct 14, 2026 at 10:00 AM MDT")
        XCTAssertNil(ApprovalContent.momentText("next Tuesday", timeZone: denver, locale: us))
        let odd = ApprovalContent(kind: .calendarInvite, payload: .object(["title": .string("Review"), "start": .string("next Tuesday")]))
        XCTAssertEqual(odd.fields.first { $0.key == "start" }?.value, "next Tuesday")
        // Only an invite's start and end are moments: an email's fields are never reworded.
        let email = ApprovalContent(kind: .email, payload: .object(["to": .array([.string("a@example.com")]), "subject": .string("2026-10-14T10:00:00-06:00"), "body": .string("x")]))
        XCTAssertEqual(email.fields.first { $0.key == "subject" }?.value, "2026-10-14T10:00:00-06:00")
    }

    func testAnUnclearAnswerToAReadSaysTryAgainNotMaybeItWentThrough() {
        let unclear = PrismError.outcomeUnknown(OutcomeUnknown(status: nil, code: nil, reason: "timed out"))
        XCTAssertEqual(PlainLanguage.readMessage(for: unclear), "The server took too long to answer, or answered with an error. Try again.")
        XCTAssertEqual(PlainLanguage.message(for: unclear), "The server didn't answer clearly, so it's not known whether this went through.")
        // The agent being down is said the same way for both.
        let agent = PrismError.outcomeUnknown(OutcomeUnknown(status: 502, code: "hermes_unavailable", reason: "bad gateway"))
        XCTAssertEqual(PlainLanguage.readMessage(for: agent), PlainLanguage.message(for: agent))
        XCTAssertEqual(PlainLanguage.readMessage(for: PrismError.unreachable("x")), PlainLanguage.message(for: PrismError.unreachable("x")))
    }

    func testTypingANewAddressTakesTheOldRefusalAwayAndTheLastAddressIsRemembered() async {
        let settings = MemorySettings()
        let app = AppModel(settings: settings, probe: FixedProbe(), deviceLabel: "test", defaultServerURL: "", makeEnvironment: { _, _ in
            ServerEnvironment(service: FakeService(), auth: NoAuth())
        })
        await app.start()
        XCTAssertEqual(app.phase, .needsServer)
        XCTAssertEqual(app.serverText, "", "no address is made up when there is no default")
        app.serverText = "not an address"
        await app.submitServer()
        XCTAssertNotNil(app.serverError)
        app.serverText = "https://prism.example.com"
        XCTAssertNil(app.serverError, "the refusal of the old text stayed up over new text")
        await app.submitServer()
        XCTAssertEqual(app.phase, .signedOut(notice: nil))
        XCTAssertEqual(settings.serverURL(), "https://prism.example.com")
        // Going back to the server screen keeps the address in the field, and a new launch has it too.
        await app.changeServer()
        XCTAssertEqual(app.phase, .needsServer)
        XCTAssertEqual(app.serverText, "https://prism.example.com")
        let again = AppModel(settings: settings, probe: FixedProbe(), deviceLabel: "test", defaultServerURL: "http://127.0.0.1:8797", makeEnvironment: { _, _ in
            ServerEnvironment(service: FakeService(), auth: NoAuth())
        })
        XCTAssertEqual(again.serverText, "https://prism.example.com", "the remembered address lost to the default")
    }
}

private final class MemorySettings: SettingsStore, @unchecked Sendable {
    private let lock = NSLock()
    private var value: String?
    func serverURL() -> String? { lock.withLock { value } }
    func setServerURL(_ value: String?) { lock.withLock { self.value = value } }
}

private struct FixedProbe: ServerProbe {
    func probe(_ origin: ServerOrigin) async -> ServerProbeResult { .ready }
}

private struct NoAuth: SessionAuth {
    var hasToken: Bool { false }
    func signIn(label: String) async throws {}
    func signOut() async -> SignOutResult { .notSignedIn }
}
