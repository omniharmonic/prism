import XCTest
@testable import OmniCore

final class WakeListeningGateTests: XCTestCase {
    func testOptInAndReadyAreRequiredBeforeStartingAnInjectedEngine() {
        var gate = WakeListeningGate()
        var starts = 0
        func grant(_ token: UUID) { if gate.acceptsPermission(token) { starts += 1 } }
        grant(gate.permissionRequest())
        XCTAssertEqual(starts, 0)
        gate.update(enabled: true, ready: true, sleeping: false, conversationActive: false)
        grant(gate.permissionRequest())
        XCTAssertEqual(starts, 1)
    }
    func testLatePermissionCannotStartAfterOffOnLockSleepOrConversationPreemption() {
        for transition in 0..<4 {
            var gate = WakeListeningGate()
            gate.update(enabled: true, ready: true, sleeping: false, conversationActive: false)
            let pending = gate.permissionRequest()
            gate.update(enabled: transition != 0, ready: transition != 1,
                        sleeping: transition == 2, conversationActive: transition == 3)
            XCTAssertFalse(gate.acceptsPermission(pending))
            gate.update(enabled: true, ready: true, sleeping: false, conversationActive: false)
            XCTAssertFalse(gate.acceptsPermission(pending), "Returning to ready never revives an old grant")
            let fresh = gate.permissionRequest()
            XCTAssertTrue(gate.acceptsPermission(fresh))
        }
    }
}
