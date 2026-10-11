import XCTest
@testable import OmniVoiceKit

@MainActor final class AudioCaptureReadinessTests: XCTestCase {
    func testFirstTapRequiredAndStopRejectsOldReadiness() async throws {
        let readiness = AudioCaptureReadiness()
        var finished = false
        let waiting = Task { try await readiness.wait(timeout: .seconds(1), isRunning: { true }); finished = true }
        await Task.yield()
        XCTAssertFalse(finished)
        readiness.receivedFirstTap()
        try await waiting.value
        XCTAssertTrue(finished)
        readiness.invalidate()
        readiness.receivedFirstTap()
        do { try await readiness.wait(timeout: .seconds(1), isRunning: { true }); XCTFail("Stopped capture is not ready") }
        catch { XCTAssertEqual(error as? SpeechPlaybackFailure, .captureMissing) }
    }
    func testEngineStopsBeforeFirstTapAndTimeoutFailWithoutRestart() async {
        let stopped = AudioCaptureReadiness()
        do { try await stopped.wait(timeout: .seconds(1), isRunning: { false }); XCTFail("Stopped engine must fail") }
        catch { XCTAssertEqual(error as? SpeechPlaybackFailure, .engineInactive) }
        let missingTap = AudioCaptureReadiness()
        do { try await missingTap.wait(timeout: .milliseconds(30), isRunning: { true }); XCTFail("Missing tap must time out") }
        catch { XCTAssertEqual(error as? SpeechPlaybackFailure, .monitorNotReady) }
    }
    func testCancellationBeforeTapCannotPublishReadiness() async {
        let readiness = AudioCaptureReadiness()
        let waiting = Task { try await readiness.wait(timeout: .seconds(1), isRunning: { true }) }
        await Task.yield()
        waiting.cancel()
        do { try await waiting.value; XCTFail("Expected cancellation") }
        catch { XCTAssertTrue(error is CancellationError) }
    }
}
