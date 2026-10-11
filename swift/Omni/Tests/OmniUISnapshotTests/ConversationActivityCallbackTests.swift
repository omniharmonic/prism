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
    func testFirstTapCallbackIsOffMainSafeAndRejectsCancelledCaptureGeneration() async {
        let delivered = expectation(description: "First microphone tap reaches owning device")
        delivered.assertForOverFulfill = true
        let (device, callback) = await MainActor.run {
            let device = ConversationDevice(diagnostic: { event in
                MainActor.assertIsolated()
                if event == .microphoneFirstTap { delivered.fulfill() }
            })
            return (device, ConversationDevice.firstTapCallback(for: device, request: 0))
        }
        await Task.detached { callback() }.value
        await fulfillment(of: [delivered], timeout: 2)
        await MainActor.run { device.cancel() }
        let stale = ConversationDevice.firstTapCallback(for: device, request: 0)
        // Reusing the same expectation would over-fulfil if a stale tap crossed the guard.
        await Task.detached { stale() }.value
        for _ in 0..<10 { await Task.yield() }
    }

}
