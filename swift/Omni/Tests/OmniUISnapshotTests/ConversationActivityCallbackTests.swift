import Foundation
import OmniCore
import OmniVoiceKit
import XCTest
@testable import OmniUI

final class ConversationActivityCallbackTests: XCTestCase {
    func testMainActorCreatedDetectorCallbackCanRunOffMainAndOnlyDeliversOnMainActor() async {
        let delivered = expectation(description: "Local activity delivered on main actor")
        let (device, callback) = await MainActor.run {
            let device = ConversationDevice()
            device.configureActivity(enabled: true) { event in
                MainActor.assertIsolated()
                if case .frame(let frame) = event {
                    XCTAssertEqual(frame.audioTime, 0.256)
                    XCTAssertTrue(frame.isSpeech)
                    delivered.fulfill()
                }
            }
            return (device, ConversationDevice.activityCallback(for: device, request: 0))
        }
        await Task.detached {
            XCTAssertFalse(Thread.isMainThread)
            callback(.frame(audioTime: 0.256, capturedAt: ProcessInfo.processInfo.systemUptime, duration: 0.256, isSpeech: true))
        }.value
        await fulfillment(of: [delivered], timeout: 2)
        let stale = expectation(description: "Cancelled generation cannot deliver"); stale.isInverted = true
        await MainActor.run {
            device.cancel() // No microphone was started; only invalidates callback ownership.
            device.configureActivity(enabled: true) { _ in stale.fulfill() }
        }
        await Task.detached {
            XCTAssertFalse(Thread.isMainThread)
            callback(.unavailable("Late detector failure"))
        }.value
        await fulfillment(of: [stale], timeout: 0.1)
    }
}
