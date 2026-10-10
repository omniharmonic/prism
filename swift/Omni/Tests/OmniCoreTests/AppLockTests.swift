import Foundation
import XCTest
@testable import OmniCore

@MainActor final class AppLockTests: XCTestCase {
    func testAnEnabledLockStartsClosedAndOnlyAuthenticationOpensIt() async {
        let key = "omni.lock-test.\(UUID().uuidString)"
        defer { UserDefaults.standard.removeObject(forKey: key) }
        UserDefaults.standard.set(true, forKey: key)
        let denied = AppLock(preferenceKey: key, authentication: { _ in false })
        XCTAssertTrue(denied.locked)
        await denied.unlock()
        XCTAssertTrue(denied.locked)
        await denied.setEnabled(false)
        XCTAssertTrue(denied.enabled)
        let accepted = AppLock(preferenceKey: key, authentication: { _ in true })
        await accepted.unlock()
        XCTAssertFalse(accepted.locked)
        accepted.lock()
        XCTAssertTrue(accepted.locked)
        await accepted.setEnabled(false)
        XCTAssertFalse(accepted.enabled)
        XCTAssertFalse(accepted.locked)
        XCTAssertFalse(UserDefaults.standard.bool(forKey: key))
    }

    func testOptInRequiresAuthenticationAndSurvivesRelaunch() async {
        let key = "omni.lock-test.\(UUID().uuidString)"
        defer { UserDefaults.standard.removeObject(forKey: key) }
        let lock = AppLock(preferenceKey: key, authentication: { _ in true })
        XCTAssertFalse(lock.enabled)
        await lock.setEnabled(true)
        XCTAssertTrue(lock.enabled)
        XCTAssertFalse(lock.locked)
        XCTAssertTrue(AppLock(preferenceKey: key).locked)
    }
    func testBackgroundInvalidatesInFlightUnlockAndPreferenceChanges() async {
        let key = "omni.lock-test.\(UUID().uuidString)"
        defer { UserDefaults.standard.removeObject(forKey: key) }
        UserDefaults.standard.set(true, forKey: key)
        var completion: CheckedContinuation<Bool, Never>?
        let lock = AppLock(preferenceKey: key, authentication: { _ in
            await withCheckedContinuation { completion = $0 }
        })
        let unlock = Task { await lock.unlock() }
        while completion == nil { await Task.yield() }
        lock.lock()
        completion?.resume(returning: true)
        await unlock.value
        XCTAssertTrue(lock.locked)
        completion = nil
        let disable = Task { await lock.setEnabled(false) }
        while completion == nil { await Task.yield() }
        lock.lock()
        completion?.resume(returning: true)
        await disable.value
        XCTAssertTrue(lock.enabled)
        XCTAssertTrue(lock.locked)
        XCTAssertTrue(UserDefaults.standard.bool(forKey: key))
    }

}
