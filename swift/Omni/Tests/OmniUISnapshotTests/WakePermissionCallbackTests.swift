#if os(macOS)
import Foundation
@preconcurrency import Speech
import XCTest
@testable import OmniUI

final class WakePermissionCallbackTests: XCTestCase {
    @MainActor func testProductionAuthorizationCallbackCreatedOnMainActorAcceptsEveryStatusOffMain() async {
        for status in [SFSpeechRecognizerAuthorizationStatus.notDetermined, .denied, .restricted, .authorized] {
            let granted: Bool = await withCheckedContinuation { continuation in
                // This is the same factory used inside the listener's MainActor
                // permission task. No permission API or microphone is invoked.
                let callback = MacWakeListener.authorizationCallback(continuation)
                DispatchQueue.global(qos: .userInitiated).async {
                    XCTAssertFalse(Thread.isMainThread)
                    callback(status)
                }
            }
            MainActor.assertIsolated()
            XCTAssertEqual(granted, status == .authorized)
        }
    }
}
#endif
