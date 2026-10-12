#if os(macOS)
import AVFoundation
import XCTest
import WakeAudioBridge
import WakeAudioBridgeTestSupport
@testable import OmniUI

@MainActor final class WakeAudioStartupTests: XCTestCase {
    func testRouteReplacementCreatesFreshEngineAndRejectsRetiredConfigurationNotification() {
        var creations = 0
        let cycle = WakeAudioEngineCycle(makeEngine: { creations += 1; return AVAudioEngine() })
        let (first, oldToken) = cycle.begin()
        XCTAssertTrue(cycle.accepts(oldToken))
        XCTAssertTrue(cycle.retire() === first)
        XCTAssertFalse(cycle.accepts(oldToken))
        let (replacement, newToken) = cycle.begin()
        XCTAssertFalse(replacement === first)
        XCTAssertEqual(creations, 2)
        XCTAssertFalse(cycle.accepts(oldToken), "A queued old route notification must not stop its replacement")
        XCTAssertTrue(cycle.accepts(newToken))
        _ = cycle.retire()
        XCTAssertNil(cycle.engine)
    }

    func testPreparationExceptionAndOrdinaryStartErrorBothRemainRecoverable() throws {
        let engine = OmniTestWakeAudioEngine()
        engine.failPreparation = true
        XCTAssertThrowsError(try OmniWakeAudioBridge.prepareAndStart(engine.audioEngine)) { error in
            XCTAssertEqual((error as NSError).domain, "OmniWakeAudioStartup")
        }
        XCTAssertEqual(engine.starts, 0)
        MainActor.assertIsolated()
        engine.failPreparation = false
        engine.failStart = true
        XCTAssertThrowsError(try OmniWakeAudioBridge.prepareAndStart(engine.audioEngine)) { error in
            XCTAssertEqual((error as NSError).domain, "SyntheticAudioStart")
        }
        engine.failStart = false
        try OmniWakeAudioBridge.prepareAndStart(engine.audioEngine)
        XCTAssertEqual(engine.starts, 2)
    }

    func testNativeTapFormatAndObjectiveCExceptionBecomeRecoverableSwiftError() throws {
        let node = OmniTestWakeAudioNode()
        try OmniWakeAudioBridge.installTap(on: node.audioNode, block: { _, _ in })
        XCTAssertTrue(node.receivedNativeFormat)
        XCTAssertEqual(node.installations, 1)
        node.failInstallation = true
        XCTAssertThrowsError(try OmniWakeAudioBridge.installTap(on: node.audioNode, block: { _, _ in })) { error in
            XCTAssertEqual((error as NSError).domain, "OmniWakeAudioStartup")
        }
        // No ObjC exception crosses a Swift callback or concurrency frame. Following
        // the caught startup failure, the main executor remains safe to inspect.
        MainActor.assertIsolated()
        XCTAssertTrue(node.receivedNativeFormat)
        XCTAssertEqual(node.installations, 2)
        node.failInstallation = false
        try OmniWakeAudioBridge.installTap(on: node.audioNode, block: { _, _ in })
        XCTAssertEqual(node.installations, 3)
    }
}
#endif
