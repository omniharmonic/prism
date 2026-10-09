import Foundation
import OmniClient
@testable import OmniCore
import PrismAuth
import PrismTransport
import XCTest

@MainActor
final class AppModelTests: XCTestCase {
    private var service = FakeService()
    private var auth = FakeAuth()
    private var settings = FakeSettings()
    private var probe = FakeProbe(.ready)
    private var environmentsMade = 0
    private var signedOutSignal: (@Sendable () async -> Void)?

    private func make(defaultURL: String = "") -> AppModel {
        service.lists(.success(Fixture.list([])))
        service.pending(.success([]))
        return AppModel(settings: settings, probe: probe, deviceLabel: "Omni on Test Mac", defaultServerURL: defaultURL, sleep: noSleep) { [self] _, onSignedOut in
            environmentsMade += 1
            signedOutSignal = onSignedOut
            return ServerEnvironment(service: service, auth: auth)
        }
    }

    func testFirstRunAsksForTheServerWithTheDefaultFilledIn() async {
        let app = make(defaultURL: "http://127.0.0.1:8797")
        await app.start()
        XCTAssertEqual(app.phase, .needsServer)
        XCTAssertEqual(app.serverText, "http://127.0.0.1:8797")
        XCTAssertTrue(probe.probed.isEmpty, "nothing is contacted before the person presses Continue")
    }

    func testABadAddressIsExplainedAndNothingIsContacted() async {
        let app = make()
        for (text, message) in [
            ("", "Enter the server address."),
            ("prism.example.com", "That isn't a web address. It should look like https://prism.example.com."),
            ("http://prism.example.com", "Use https://. Plain http:// only works for a server on this Mac (127.0.0.1)."),
            ("https://prism.example.com/app", "Use just the server's address, with nothing after the host name."),
            ("http://127.0.0.1:1940", "That port is the vault, not the Prism Server."),
        ] {
            app.serverText = text
            await app.submitServer()
            XCTAssertEqual(app.serverError, message, text)
            XCTAssertEqual(app.phase, .needsServer)
        }
        XCTAssertTrue(probe.probed.isEmpty)
        XCTAssertNil(settings.serverURL())
    }

    func testAValidServerIsRememberedAndLeadsToSignIn() async {
        let app = make()
        app.serverText = " https://Prism.Example.com/ "
        await app.submitServer()
        XCTAssertNil(app.serverError)
        XCTAssertEqual(app.phase, .signedOut(notice: nil))
        XCTAssertEqual(app.serverText, "https://prism.example.com")
        XCTAssertEqual(settings.serverURL(), "https://prism.example.com")
        XCTAssertEqual(probe.probed, ["https://prism.example.com"])
        XCTAssertTrue(auth.labels.isEmpty, "a sign-in is never started without a press")
    }

    func testAnUnreachableServerHasAClearStateAndRetryWorks() async {
        probe = FakeProbe(.unreachable("timed out"), .ready)
        let app = make()
        app.serverText = "http://127.0.0.1:8797"
        await app.submitServer()
        XCTAssertEqual(app.phase, .unreachable(message: "Can't reach the server. Check that it's running and that this device is on the right network."))
        XCTAssertEqual(settings.serverURL(), "http://127.0.0.1:8797", "the address is kept for the retry")
        await app.connect()
        XCTAssertEqual(app.phase, .signedOut(notice: nil))
    }

    func testAServerWithOmniOffOrSomethingElseSaysSo() async {
        probe = FakeProbe(.omniOff, .unexpected(status: 302))
        let app = make()
        app.serverText = "https://prism.example.com"
        await app.submitServer()
        XCTAssertEqual(app.phase, .unreachable(message: "This server answered, but Omni isn't turned on there."))
        await app.connect()
        XCTAssertEqual(app.phase, .unreachable(message: "Something answered at that address, but it doesn't look like a Prism Server."))
    }

    func testSignInOpensASession() async {
        let app = make()
        app.serverText = "https://prism.example.com"
        await app.submitServer()
        app.signIn()
        XCTAssertEqual(app.phase, .signingIn)
        await eventually { app.phase == .signedIn }
        XCTAssertEqual(auth.labels, ["Omni on Test Mac"])
        XCTAssertNotNil(app.session)
    }

    func testAFailedSignInSaysWhyAndACancelledOneSaysNothing() async {
        let app = make()
        app.serverText = "https://prism.example.com"
        await app.submitServer()
        auth.failSignIn(DeviceAuthError.denied("access_denied"))
        app.signIn()
        await eventually { app.phase != .signingIn }
        XCTAssertEqual(app.phase, .signedOut(notice: "Sign-in was denied in the browser."))
        auth.failSignIn(DeviceAuthError.cancelled)
        app.signIn()
        await eventually { app.phase != .signingIn }
        XCTAssertEqual(app.phase, .signedOut(notice: nil))
        XCTAssertNil(app.session)
    }

    func testGivingUpOnTheBrowserReturnsToSignIn() async {
        let app = make()
        app.serverText = "https://prism.example.com"
        await app.submitServer()
        auth.failSignIn(DeviceAuthError.timedOut)
        app.signIn()
        app.cancelSignIn()
        XCTAssertEqual(app.phase, .signedOut(notice: nil))
        // The abandoned attempt's late failure changes nothing.
        try? await Task.sleep(for: .milliseconds(20))
        XCTAssertEqual(app.phase, .signedOut(notice: nil))
    }

    func testARememberedServerWithATokenGoesStraightIn() async {
        settings = FakeSettings("https://prism.example.com")
        auth = FakeAuth(hasToken: true)
        let app = make()
        await app.start()
        XCTAssertEqual(app.phase, .signedIn)
        XCTAssertEqual(app.origin?.value, "https://prism.example.com")
        XCTAssertTrue(auth.labels.isEmpty)
    }

    func testSignOutRevokesForgetsAndKeepsTheServer() async {
        settings = FakeSettings("https://prism.example.com")
        auth = FakeAuth(hasToken: true)
        let app = make()
        await app.start()
        await app.signOut()
        XCTAssertEqual(auth.signOuts, 1)
        XCTAssertEqual(app.phase, .signedOut(notice: "Signed out."))
        XCTAssertNil(app.session)
        XCTAssertEqual(settings.serverURL(), "https://prism.example.com")
        XCTAssertEqual(app.serverText, "https://prism.example.com")
    }

    func testASignOutTheServerCouldNotConfirmSaysSo() async {
        settings = FakeSettings("https://prism.example.com")
        auth = FakeAuth(hasToken: true)
        auth.signOutResult = .forgottenLocally(reason: "offline")
        let app = make()
        await app.start()
        await app.signOut()
        XCTAssertEqual(app.phase, .signedOut(notice: "Signed out here. The server couldn't confirm it, so this device may still be listed in Prism → Account → Devices."))
    }

    func testAConfirmedDeadTokenGoesBackToSignInOnTheSameServer() async {
        settings = FakeSettings("https://prism.example.com")
        auth = FakeAuth(hasToken: true)
        let app = make()
        await app.start()
        XCTAssertEqual(app.phase, .signedIn)
        // PrismKit's transport: a 401 that /auth/me confirmed. It has forgotten the token.
        await signedOutSignal?()
        XCTAssertEqual(app.phase, .signedOut(notice: "Your sign-in is no longer valid on this server. Sign in again."))
        XCTAssertNil(app.session)
        XCTAssertEqual(app.origin?.value, "https://prism.example.com")
        XCTAssertEqual(settings.serverURL(), "https://prism.example.com")
        XCTAssertEqual(auth.signOuts, 0, "the token is already dead: nothing to revoke")
        XCTAssertTrue(auth.labels.isEmpty, "and no sign-in starts by itself")
    }

    func testASignedOutErrorFromAnyScreenGoesBackToSignIn() async {
        settings = FakeSettings("https://prism.example.com")
        auth = FakeAuth(hasToken: true)
        let app = make()
        await app.start()
        service.lists(.failure(PrismError.signedOut))
        await app.session?.threads.refresh()
        XCTAssertEqual(app.phase, .signedOut(notice: "Your sign-in is no longer valid on this server. Sign in again."))
        XCTAssertEqual(app.serverText, "https://prism.example.com")
    }

    func testChangingTheServerSignsOutAndASignalFromTheOldServerIsIgnored() async {
        settings = FakeSettings("https://prism.example.com")
        auth = FakeAuth(hasToken: true)
        let app = make()
        await app.start()
        let oldSignal = signedOutSignal
        await app.changeServer()
        XCTAssertEqual(app.phase, .needsServer)
        XCTAssertEqual(auth.signOuts, 1)
        auth = FakeAuth(hasToken: true)
        app.serverText = "https://other.example.com"
        await app.submitServer()
        XCTAssertEqual(app.phase, .signedIn)
        XCTAssertEqual(environmentsMade, 2)
        await oldSignal?()
        XCTAssertEqual(app.phase, .signedIn, "the old server's 401 says nothing about the new one")
    }
}

@MainActor
final class SessionModelTests: XCTestCase {
    private var service = FakeService()

    private func make() -> SessionModel {
        service.lists(.success(Fixture.list([Fixture.threadJSON("t1", state: "working")])))
        service.pending(.success([]))
        return SessionModel(service: service, sleep: noSleep) {}
    }

    func testTheChangeChannelRefreshesWhatIsShown() async {
        let notices = service.noticeStream()
        let session = make()
        session.start()
        notices.yield(.connected)
        await eventually("connected refresh") { self.service.listReads == 1 && self.service.pendingReads == 1 }
        notices.yield(.notice(Fixture.decode(["type": "thread", "id": "t1", "op": "done"])))
        await eventually("thread notice") { self.service.listReads == 2 }
        notices.yield(.notice(Fixture.decode(["type": "approval", "id": "apr1", "op": "pending", "threadId": "t1"])))
        await eventually("approval notice") { self.service.pendingReads == 2 }
        // A reconnect: notices are not replayed, so everything is read again.
        notices.yield(.reconnecting(delay: .seconds(1)))
        notices.yield(.connected)
        await eventually("reconnect refresh") { self.service.listReads == 3 && self.service.pendingReads == 3 }
        session.stop()
    }

    func testANoticeForTheOpenThreadReloadsIt() async {
        let notices = service.noticeStream()
        let session = make()
        service.details(.success(Fixture.detail("t1")))
        session.start()
        let thread = session.threadModel(for: "t1")
        XCTAssertTrue(session.threadModel(for: "t1") === thread)
        await thread.open()
        XCTAssertEqual(service.detailReads, 1)
        notices.yield(.notice(Fixture.decode(["type": "thread", "id": "t1", "op": "message"])))
        await eventually { self.service.detailReads == 2 }
        notices.yield(.notice(Fixture.decode(["type": "card", "id": "n1", "op": "updated", "threadId": "t1"])))
        await eventually { self.service.detailReads == 3 }
        notices.yield(.notice(Fixture.decode(["type": "thread", "id": "other", "op": "message"])))
        await eventually { self.service.listReads >= 2 }
        XCTAssertEqual(service.detailReads, 3)
        session.stop()
        XCTAssertFalse(thread.isOpen)
    }

    func testStartingAThreadOpensItAndKeyboardRequestsMoveTheWindow() async {
        let session = make()
        service.created(.success(Fixture.decode(["thread": Fixture.threadJSON("new", state: "working"), "turnId": "turn1"])))
        session.requestNewThread()
        XCTAssertEqual(session.destination, .newThread)
        let started = await session.startThread(prompt: "call Dana")
        XCTAssertTrue(started)
        XCTAssertEqual(session.destination, .thread("new"))
        session.requestSearch()
        XCTAssertEqual(session.searchRequests, 1)
        XCTAssertFalse(session.canStopCurrentTurn)
    }

    func testStopActsOnTheThreadOnScreen() async {
        let session = make()
        service.details(.success(Fixture.detail("t1", lastSeq: 1, activeTurnId: "turn1")))
        service.cancels(.success(Fixture.decode(["turnId": "turn1", "status": "cancelling"])))
        _ = service.manualStream()
        session.destination = .thread("t1")
        let thread = session.threadModel(for: "t1")
        await thread.open()
        XCTAssertTrue(session.canStopCurrentTurn)
        await session.stopCurrentTurn()
        XCTAssertEqual(service.cancelled, ["turn1"])
        session.stop()
    }
}

@MainActor
final class TodayAndJobsTests: XCTestCase {
    private var service = FakeService()

    func testTheDayAskedForIsThePersonsDay() {
        var denver = Calendar(identifier: .gregorian)
        denver.timeZone = TimeZone(identifier: "America/Denver")!
        // 03:30 UTC on the 9th is still the evening of the 8th in Boulder.
        let late = ISO8601DateFormatter().date(from: "2026-10-09T03:30:00Z")!
        XCTAssertEqual(TodayModel.dayString(late, calendar: denver), "2026-10-08")
        // The system puts a narrow no-break space before AM/PM.
        let time = TodayModel.timeText("2026-10-08T17:30:00+01:00", timeZone: denver.timeZone, locale: Locale(identifier: "en_US"))
        XCTAssertEqual(time?.replacingOccurrences(of: "\u{202F}", with: " "), "10:30 AM")
        XCTAssertNil(TodayModel.timeText("sometime"))
    }

    func testTodayLoadsItsSectionsAndNamesTheOnesThatFailed() async {
        let sink = ErrorSink {}
        let approvals = ApprovalCenter(service: service, sink: sink)
        var denver = Calendar(identifier: .gregorian)
        denver.timeZone = TimeZone(identifier: "America/Denver")!
        let now = ISO8601DateFormatter().date(from: "2026-10-09T03:30:00Z")!
        let zone = denver
        let model = TodayModel(service: service, sink: sink, approvals: approvals, calendar: { zone }, now: { now })
        service.todays(.success(Fixture.decode([
            "date": "2026-10-08",
            "agenda": NSNull(),
            "tasks": [["noteId": "n1", "title": "Send Kevin the Buoy spec", "status": "pending", "due": "2026-10-08"]],
            "taskIdentity": "person",
            "needsYou": ["approvals": [Fixture.approvalJSON("apr1")], "nudges": []],
            "inFlight": [["id": "t1", "title": "Venue research", "state": "working", "lastActivityAt": "2026-10-08T15:00:00.000Z"]],
            "openLoops": NSNull(), "brief": NSNull(),
            "errors": ["agenda": "query_502"],
        ])))
        await model.refresh()
        XCTAssertEqual(service.todayDates, ["2026-10-08"])
        XCTAssertEqual(model.phase, .loaded)
        XCTAssertTrue(model.agenda.isEmpty)
        XCTAssertEqual(model.sectionProblems, ["agenda": "Couldn't load the agenda just now."])
        XCTAssertEqual(model.tasks.map(\.title), ["Send Kevin the Buoy spec"])
        XCTAssertEqual(model.inFlight.map(\.id), ["t1"])
        XCTAssertEqual(model.approvalIDs, ["apr1"])
        XCTAssertEqual(approvals.pending.map(\.id), ["apr1"], "Today's approvals are the same cards as everywhere else")
    }

    func testJobsListPauseAndResume() async {
        let running: [String: Any] = ["id": "aaaaaaaaaaaa", "name": "Morning brief", "schedule": "30 7 * * *", "enabled": true, "next_run_at": "2026-10-09T13:30:00Z", "last_status": "ok"]
        var paused = running
        paused["enabled"] = false
        let model = JobsModel(service: service, sink: ErrorSink {})
        service.jobs(.success([Fixture.decode(running)]))
        service.jobActions(.success(Fixture.decode(paused)), .success(Fixture.decode(running)))
        await model.refresh()
        XCTAssertEqual(model.phase, .loaded)
        XCTAssertFalse(JobPresentation.isPaused(model.jobs[0]))
        await model.toggle(model.jobs[0])
        XCTAssertTrue(JobPresentation.isPaused(model.jobs[0]))
        await model.toggle(model.jobs[0])
        XCTAssertFalse(JobPresentation.isPaused(model.jobs[0]))
        XCTAssertEqual(service.jobCalls, ["aaaaaaaaaaaa:pause", "aaaaaaaaaaaa:resume"])
        XCTAssertNil(model.busyJobID)
    }

    func testAFailedPauseSaysSoAndShowsTheServersState() async {
        let job: OmniJob = Fixture.decode(["id": "aaaaaaaaaaaa", "name": "Sweep", "enabled": true])
        let model = JobsModel(service: service, sink: ErrorSink {})
        service.jobs(.success([job]))
        service.jobActions(.failure(Fixture.unknownOutcome))
        await model.refresh()
        await model.toggle(job)
        XCTAssertEqual(model.actionProblem, "The server didn't answer clearly, so it's not known whether this went through.")
        XCTAssertEqual(model.jobs.map(\.id), ["aaaaaaaaaaaa"])
    }

    func testJobFieldsInHermesShapesBecomeText() {
        let cron: OmniJob = Fixture.decode(["id": "a", "schedule": ["kind": "cron", "expr": "0 * * * *", "display": "hourly"], "next_run_at": 1_791_000_000, "last_status": "error", "paused": true])
        XCTAssertEqual(JobPresentation.name(cron), "Job a")
        XCTAssertEqual(JobPresentation.schedule(cron), "hourly")
        XCTAssertEqual(JobPresentation.date(cron.nextRunAt), Date(timeIntervalSince1970: 1_791_000_000))
        XCTAssertEqual(JobPresentation.lastRun(cron), "Last run failed")
        XCTAssertTrue(JobPresentation.isPaused(cron))
        let plain: OmniJob = Fixture.decode(["id": "b", "name": "Brief", "schedule": "30 7 * * *", "next_run_at": 1_791_000_000_000 as Int64, "last_status": "ok"])
        XCTAssertEqual(JobPresentation.schedule(plain), "30 7 * * *")
        XCTAssertEqual(JobPresentation.date(plain.nextRunAt), Date(timeIntervalSince1970: 1_791_000_000))
        XCTAssertEqual(JobPresentation.lastRun(plain), "Last run worked")
        XCTAssertNil(JobPresentation.date(nil))
    }
}

@MainActor
final class PlainLanguageTests: XCTestCase {
    func testTurnFailuresAndErrorsNeverShowACodeAlone() {
        for code in ["cancelled", "auth", "usage_limit", "budget", "timeout", "iteration_limit", "agent_failed", "stream_ended", "hermes_auth", "hermes_unavailable", "hermes_timeout", "hermes_not_configured", "internal_error", "something_new"] {
            let text = PlainLanguage.turnFailure(code)
            XCTAssertFalse(text.contains("_"), code)
            XCTAssertTrue(text.hasSuffix("."), code)
        }
        XCTAssertEqual(PlainLanguage.message(for: PrismError.outcomeUnknown(OutcomeUnknown(status: 502, code: "hermes_unavailable", reason: "x"))), "The server is up, but it can't reach the agent right now.")
        XCTAssertEqual(PlainLanguage.message(for: PrismError.rejected(Fixture.failure(410, "expired"))), "This draft expired.")
        XCTAssertEqual(PlainLanguage.message(for: PrismError.forbidden(Fixture.failure(403, "human_origin_required"))), "Only a person can do this, from a signed-in device.")
    }

    func testWhichErrorsMeanSignedOutAndWhichLeaveTheOutcomeUnknown() {
        XCTAssertTrue(PlainLanguage.isSignedOut(PrismError.signedOut))
        XCTAssertTrue(PlainLanguage.isSignedOut(PrismError.notSignedIn))
        XCTAssertFalse(PlainLanguage.isSignedOut(PrismError.unauthorized), "one 401 is a suspicion, not a sign-out")
        XCTAssertTrue(PlainLanguage.outcomeIsUnknown(Fixture.unknownOutcome))
        XCTAssertTrue(PlainLanguage.outcomeIsUnknown(PrismError.unauthorized))
        XCTAssertFalse(PlainLanguage.outcomeIsUnknown(PrismError.unreachable("x")))
        XCTAssertFalse(PlainLanguage.outcomeIsUnknown(PrismError.conflict(Fixture.failure(409, "conflict"))))
        XCTAssertFalse(PlainLanguage.outcomeIsUnknown(OmniError.executorNotReady(code: "executor_disabled", executor: nil)))
    }
}
