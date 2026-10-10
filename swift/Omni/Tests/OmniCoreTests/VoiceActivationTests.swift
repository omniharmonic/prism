import Foundation
import XCTest
@testable import OmniCore

@MainActor final class VoiceActivationTests: XCTestCase {
    private func app(signedIn: Bool = true) async -> AppModel {
        let service = FakeService()
        let model = AppModel(settings: FakeSettings("https://prism.example.com"), probe: FakeProbe(.ready), deviceLabel: "Test", sleep: noSleep) { _, _ in
            ServerEnvironment(service: service, auth: FakeAuth(hasToken: signedIn))
        }
        await model.start()
        return model
    }
    private func ready(_ coordinator: VoiceActivationCoordinator, app: AppModel, id: UUID = UUID(), active: Bool = true, locked: Bool = false) -> UUID {
        coordinator.updateScene(id, app: app, active: active, locked: locked)
        if let session = app.session { coordinator.navigationAppeared(session, sceneID: id) }
        return id
    }
    func testColdRequestWaitsForSignInSceneUnlockAndNavigationThenConsumesOnce() async {
        let coordinator = VoiceActivationCoordinator()
        coordinator.request()
        let request = coordinator.pendingID
        let app = await app(signedIn: false)
        let id = ready(coordinator, app: app, active: false, locked: true)
        XCTAssertEqual(coordinator.pendingID, request)
        XCTAssertNil(app.session)
        app.signIn()
        await eventually { app.phase == .signedIn }
        let session = app.session!
        coordinator.updateScene(id, app: app, active: true, locked: true)
        coordinator.navigationAppeared(session, sceneID: id)
        XCTAssertNil(session.pendingVoiceActivationID)
        coordinator.updateScene(id, app: app, active: true, locked: false)
        XCTAssertEqual(session.pendingVoiceActivationID, request)
        XCTAssertEqual(session.destination, .newThread)
        XCTAssertFalse(coordinator.consume(session: session, sceneID: UUID(), threadID: nil))
        XCTAssertFalse(coordinator.consume(session: session, sceneID: id, threadID: "unrelated"))
        XCTAssertTrue(coordinator.consume(session: session, sceneID: id, threadID: nil))
        XCTAssertFalse(coordinator.consume(session: session, sceneID: id, threadID: nil))
        XCTAssertNil(coordinator.pendingID)
        session.stop()
    }
    func testNavigationCanMountBeforeRootReadiness() async {
        let app = await app(); let session = app.session!
        let coordinator = VoiceActivationCoordinator(); let id = UUID()
        coordinator.request()
        coordinator.navigationAppeared(session, sceneID: id)
        XCTAssertNil(session.pendingVoiceActivationID)
        coordinator.updateScene(id, app: app, active: true, locked: false)
        XCTAssertNotNil(session.pendingVoiceActivationID)
        XCTAssertTrue(coordinator.consume(session: session, sceneID: id, threadID: nil))
        session.stop()
    }
    func testPressBeforeStartTaskRunsDoesNotReplaceItsReservedSession() async {
        let app = await app(); let session = app.session!
        let coordinator = VoiceActivationCoordinator(); let id = ready(coordinator, app: app)
        coordinator.request()
        XCTAssertTrue(coordinator.consume(session: session, sceneID: id, threadID: nil))
        let audio = VoiceConversationTests.Audio(); let voice = VoiceConversation(audio: audio)
        session.claimVoice(audio: audio, voice: voice, threadID: nil)
        let lease = session.voiceLease
        session.beginVoiceStart()
        let count = session.newThreadRequests
        coordinator.request()
        XCTAssertNil(session.pendingVoiceActivationID)
        XCTAssertEqual(session.newThreadRequests, count)
        XCTAssertEqual(session.voiceLease, lease)
        session.endVoiceStart(lease: lease)
        session.stop()
    }
    func testMountedNavigationIsRequiredAndWarmPressesAreCoalesced() async {
        let app = await app(); let session = app.session!
        let coordinator = VoiceActivationCoordinator(); let id = UUID()
        coordinator.updateScene(id, app: app, active: true, locked: false)
        coordinator.request(); let request = coordinator.pendingID
        coordinator.request()
        XCTAssertEqual(coordinator.pendingID, request)
        XCTAssertFalse(session.newThreadUsesVoice)
        coordinator.navigationAppeared(session, sceneID: id)
        let count = session.newThreadRequests
        coordinator.request()
        XCTAssertEqual(session.newThreadRequests, count)
        XCTAssertEqual(session.pendingVoiceActivationID, request)
        coordinator.cancel(); session.stop()
    }
    func testLockInactivityDisappearanceAndExpiryRevokeRoutedStart() async {
        let app = await app(); let session = app.session!
        var time = Date(timeIntervalSince1970: 0)
        let coordinator = VoiceActivationCoordinator(now: { time })
        let id = ready(coordinator, app: app)
        for reason in 0..<4 {
            coordinator.updateScene(id, app: app, active: true, locked: false)
            coordinator.navigationAppeared(session, sceneID: id)
            coordinator.request()
            XCTAssertNotNil(session.pendingVoiceActivationID)
            switch reason {
            case 0: coordinator.updateScene(id, app: app, active: true, locked: true)
            case 1: coordinator.updateScene(id, app: app, active: false, locked: false)
            case 2: coordinator.navigationDisappeared(session, sceneID: id)
            default: time = time.addingTimeInterval(61); coordinator.expireIfNeeded()
            }
            XCTAssertNil(session.pendingVoiceActivationID)
            XCTAssertFalse(coordinator.consume(session: session, sceneID: id, threadID: nil))
            XCTAssertNil(coordinator.pendingID)
        }
        session.stop()
    }
    func testCloseTextEntryNavigationAndSessionStopCannotLeaveAnAutostart() async {
        let app = await app(); let session = app.session!
        let coordinator = VoiceActivationCoordinator(); let id = ready(coordinator, app: app)
        for reason in 0..<5 {
            coordinator.request(); XCTAssertNotNil(session.pendingVoiceActivationID)
            switch reason {
            case 0: session.closeNewVoice()
            case 1: session.requestNewThread()
            case 2: session.destination = .today
            case 3: session.requestNewVoice() // ordinary toolbar entry remains open-only
            default: session.stop()
            }
            XCTAssertNil(session.pendingVoiceActivationID)
            XCTAssertFalse(coordinator.consume(session: session, sceneID: id, threadID: nil))
            coordinator.cancel()
        }
    }
    func testSignOutInvalidatesTheQueuedSession() async {
        let app = await app(); let session = app.session!
        let coordinator = VoiceActivationCoordinator(); let id = ready(coordinator, app: app)
        coordinator.request()
        await app.signOut()
        coordinator.updateScene(id, app: app, active: true, locked: false)
        XCTAssertNil(session.pendingVoiceActivationID)
        XCTAssertNil(coordinator.pendingID)
        XCTAssertFalse(coordinator.consume(session: session, sceneID: id, threadID: nil))
    }
    func testActiveConversationIsReopenedWithoutRestartingCaptureOrNarration() async {
        let app = await app(); let session = app.session!
        let coordinator = VoiceActivationCoordinator(); _ = ready(coordinator, app: app)
        let audio = VoiceConversationTests.Audio(); let voice = VoiceConversation(audio: audio)
        session.requestNewVoice(); session.claimVoice(audio: audio, voice: voice, threadID: nil)
        await voice.start()
        let count = session.newThreadRequests
        coordinator.request(); coordinator.request()
        XCTAssertEqual(audio.starts, 1)
        XCTAssertEqual(voice.state, .listening)
        XCTAssertEqual(session.newThreadRequests, count)
        XCTAssertNil(session.pendingVoiceActivationID)
        await voice.finish { _ in true }
        coordinator.request()
        XCTAssertEqual(voice.state, .answering)
        XCTAssertEqual(audio.starts, 1)
        session.stop()
    }
    func testExpiredColdRequestDoesNotReviveOnUnrelatedLaunch() async {
        var time = Date(timeIntervalSince1970: 0)
        let coordinator = VoiceActivationCoordinator(now: { time })
        coordinator.request(); time = time.addingTimeInterval(61)
        let app = await app(); _ = ready(coordinator, app: app)
        XCTAssertNil(coordinator.pendingID)
        XCTAssertFalse(app.session!.newThreadUsesVoice)
        app.session?.stop()
    }
}
