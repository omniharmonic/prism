import XCTest
@testable import OmniCore

final class WakeRecoveryPolicyTests: XCTestCase {
    func testRepeatedImmediateFailuresEnterBoundedCooldownUntilStableRollover() {
        var policy = WakeRecoveryPolicy()
        XCTAssertEqual((0..<8).map { _ in policy.failed().delaySeconds }, [1, 2, 4, 8, 16, 60, 60, 60])
        policy.stable()
        XCTAssertEqual(policy.failed().delaySeconds, 1)
    }
    func testNormalFinalRenewsPromptlyButFastFinalsAndErrorsAreBounded() {
        var policy = WakeRecoveryPolicy()
        for _ in 0..<10 {
            XCTAssertEqual(policy.ended(normally: true, elapsedSeconds: 5).delaySeconds, 1)
        }
        XCTAssertEqual((0..<6).map { _ in policy.ended(normally: true, elapsedSeconds: 0.01).delaySeconds }, [2, 4, 8, 16, 60, 60])
        XCTAssertEqual(policy.ended(normally: false, elapsedSeconds: 30).delaySeconds, 60)
        XCTAssertEqual(policy.ended(normally: true, elapsedSeconds: 10).delaySeconds, 1)
    }
    func testReplacementAndCancellationNeverReviveStaleRetries() {
        var policy = WakeRecoveryPolicy()
        let stale = policy.failed()
        let current = policy.failed()
        XCTAssertFalse(policy.consume(stale, allowed: true))
        XCTAssertTrue(policy.consume(current, allowed: true))
        XCTAssertFalse(policy.consume(current, allowed: true))
        let cancelled = policy.failed()
        policy.cancel()
        XCTAssertFalse(policy.consume(cancelled, allowed: true))
    }
    func testInjectedRecoveryCannotStartWithOffSleepConversationOrDeniedPermission() {
        for transition in 0..<4 {
            var gate = WakeListeningGate()
            var policy = WakeRecoveryPolicy()
            var epoch = WakeRecognitionEpoch()
            var starts = 0
            gate.update(enabled: true, ready: true, sleeping: false, conversationActive: false)
            let recognition = epoch.begin()
            let retry = policy.failed()
            epoch.invalidate()
            gate.update(enabled: transition != 0, ready: true, sleeping: transition == 1, conversationActive: transition == 2)
            let permissionGranted = transition != 3
            if policy.consume(retry, allowed: gate.canListen && permissionGranted) { starts += 1 }
            XCTAssertEqual(starts, 0)
            XCTAssertFalse(epoch.isCurrent(recognition))
            gate.update(enabled: true, ready: true, sleeping: false, conversationActive: false)
            XCTAssertFalse(policy.consume(retry, allowed: true))
            let fresh = policy.failed()
            if policy.consume(fresh, allowed: gate.canListen) { starts += 1 }
            XCTAssertEqual(starts, 1)
        }
    }
}
