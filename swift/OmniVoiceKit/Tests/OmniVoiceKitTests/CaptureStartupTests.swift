import XCTest
import AVFoundation
@testable import OmniVoiceKit

@MainActor final class CaptureStartupTests: XCTestCase {
    func testEmptyConfigurationStopRetriesOnceBeforeReadiness() async throws {
        var starts = 0, waits = 0, stops = 0, retries = 0
        try await CaptureStartup.run(start: { starts += 1 }, wait: {
            waits += 1
            if waits == 1 { throw SpeechPlaybackFailure.engineInactive }
        }, stopAndWasEmpty: { stops += 1; return true }, beforeRetry: { retries += 1 })
        XCTAssertEqual(starts, 2); XCTAssertEqual(waits, 2); XCTAssertEqual(stops, 1); XCTAssertEqual(retries, 1)
    }
    func testPersistentFailureIsBoundedAndRecordedInputNeverRetries() async {
        for empty in [true, false] {
            var starts = 0
            do {
                try await CaptureStartup.run(start: { starts += 1 }, wait: { throw SpeechPlaybackFailure.monitorNotReady }, stopAndWasEmpty: { empty }, beforeRetry: {})
                XCTFail("Expected failure")
            } catch { XCTAssertEqual(error as? SpeechPlaybackFailure, .monitorNotReady) }
            XCTAssertEqual(starts, empty ? 2 : 1)
        }
    }
    func testPermissionFailureDoesNotStopOrRetry() async {
        do {
            try await CaptureStartup.run(start: { throw VoiceFailure.permission }, wait: { XCTFail() }, stopAndWasEmpty: { XCTFail(); return true }, beforeRetry: { XCTFail() })
            XCTFail()
        } catch {}
    }
    func testCancellationDuringRecoveryNeverRestarts() async {
        var starts = 0
        let task = Task {
            try await CaptureStartup.run(start: { starts += 1 }, wait: { throw SpeechPlaybackFailure.engineInactive }, stopAndWasEmpty: { true }, beforeRetry: { try await Task.sleep(for: .seconds(30)) })
        }
        await Task.yield(); task.cancel()
        do { try await task.value; XCTFail() } catch { XCTAssertTrue(error is CancellationError) }
        XCTAssertLessThanOrEqual(starts, 1)
    }
    func testMuteDropsInputAndUnmuteRestoresDelivery() {
        let gate = CaptureInputGate()
        var deliveries = 0
        gate.withInput { deliveries += 1 }
        gate.setMuted(true)
        gate.withInput { deliveries += 1 }
        gate.setMuted(false)
        gate.withInput { deliveries += 1 }
        XCTAssertEqual(deliveries, 2)
    }
    func testMutedTapWritesNoFramesAndUnmutedTapResumesRecording() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".caf")
        defer { try? FileManager.default.removeItem(at: url) }
        let format = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: 16000, channels: 1))
        let writer = try CaptureFile(url: url, format: format)
        let gate = CaptureInputGate()
        let tap = CaptureFile.tap(for: writer, inputGate: gate)
        let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 64))
        buffer.frameLength = 64
        buffer.floatChannelData![0].initialize(repeating: 0, count: 64)
        gate.setMuted(true)
        tap(buffer, AVAudioTime(sampleTime: 0, atRate: 16000))
        XCTAssertFalse(writer.hasRecordedInput)
        gate.setMuted(false)
        tap(buffer, AVAudioTime(sampleTime: 64, atRate: 16000))
        XCTAssertTrue(writer.hasRecordedInput)
        gate.setMuted(true)
        tap(buffer, AVAudioTime(sampleTime: 128, atRate: 16000))
        try writer.close()
        XCTAssertEqual(try AVAudioFile(forReading: url).length, 64)
    }

}
