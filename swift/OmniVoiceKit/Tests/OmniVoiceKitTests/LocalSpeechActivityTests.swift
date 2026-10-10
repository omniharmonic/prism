@preconcurrency import AVFoundation
import FluidAudio
import Foundation
import XCTest
@testable import OmniVoiceKit

final class LocalSpeechActivityTests: XCTestCase {
    actor Probe {
        var samples: [Float] = []
        var waiting = false
        var gate: CheckedContinuation<Void, Never>?
        func process(_ chunk: [Float], state: VadStreamState, hold: Bool = false, onWaiting: (@Sendable () -> Void)? = nil) async -> VadStreamResult {
            samples = chunk
            if hold { waiting = true; onWaiting?(); await withCheckedContinuation { gate = $0 } }
            var next = state; next.processedSamples += chunk.count
            return VadStreamResult(state: next, event: nil, probability: 0.9)
        }
        func release() { gate?.resume(); gate = nil }
    }
    nonisolated static func buffer(frames: Int = 4096, value: Float = 0.25) -> AVAudioPCMBuffer {
        let format = AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1)!
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames))!
        buffer.frameLength = AVAudioFrameCount(frames)
        for index in 0..<frames { buffer.floatChannelData![0][index] = value }
        return buffer
    }
    func testPersistentResamplerKeepsOutputCountAcrossManyNativeRateChunks() throws {
        for rate in [44_100.0, 48_000.0] {
            let converter = ActivityResampler()
            let input = [Float](repeating: 0.25, count: 1024)
            var output: [Float] = []
            for _ in 0..<64 { output += try converter.convert(input, rate: rate) }
            let expected = Double(64 * input.count) * 16_000 / rate
            // Allow the single initial converter prime, not repeated per-tap loss.
            XCTAssertEqual(Double(output.count), expected, accuracy: 128)
            XCTAssertGreaterThan(output.count, 1000)
            let middle = output.dropFirst(256).dropLast(256)
            XCTAssertEqual(Double(middle.reduce(0, +)) / Double(middle.count), 0.25, accuracy: 0.01)
            XCTAssertThrowsError(try converter.convert(input, rate: rate == 44_100 ? 48_000 : 44_100))
        }
    }
    func testRealTapOffMainCopiesScalarsBeforeBufferIsReused() async throws {
        let probe = Probe(); let received = expectation(description: "Processed local frame")
        let activity = LocalSpeechActivity(process: { await probe.process($0, state: $1) }, receive: { event in
            if case .frame = event { received.fulfill() }
        })
        defer { activity.stop() }
        let url = FileManager.default.temporaryDirectory.appending(path: "activity-tap-\(UUID().uuidString).caf")
        defer { try? FileManager.default.removeItem(at: url) }
        let writer = try CaptureFile(url: url, format: AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1)!)
        let tap = await MainActor.run { CaptureFile.tap(for: writer, activity: activity) }
        try await Task.detached {
            XCTAssertFalse(Thread.isMainThread)
            let input = Self.buffer()
            tap(input, AVAudioTime(sampleTime: 0, atRate: 16_000))
            for index in 0..<4096 { input.floatChannelData![0][index] = 0 }
            try writer.close()
        }.value
        await fulfillment(of: [received], timeout: 2)
        let samples = await probe.samples
        XCTAssertEqual(samples.count, 4096)
        XCTAssertEqual(samples.first ?? 0, 0.25, accuracy: 0.001)
        XCTAssertEqual(samples.last ?? 0, 0.25, accuracy: 0.001)
    }
    func testBackpressureDisablesDetectorAndLateInferenceCannotEmitFrame() async throws {
        let probe = Probe()
        let started = expectation(description: "Inference entered model-free gate")
        let unavailable = expectation(description: "Bounded queue overflow disables auto")
        let late = expectation(description: "No frame after stop"); late.isInverted = true
        let activity = LocalSpeechActivity(process: { await probe.process($0, state: $1, hold: true, onWaiting: { started.fulfill() }) }, receive: { event in
            switch event { case .frame: late.fulfill(); case .unavailable: unavailable.fulfill() }
        })
        defer { activity.stop() }
        activity.append(Self.buffer())
        await fulfillment(of: [started], timeout: 2)
        let waiting = await probe.waiting; XCTAssertTrue(waiting)
        for _ in 0..<20 { activity.append(Self.buffer()) }
        await fulfillment(of: [unavailable], timeout: 2)
        await probe.release()
        await fulfillment(of: [late], timeout: 0.1)
    }
    func testTapRejectsDelayedValidHostTimeEvenWhenCallbackJustArrived() async throws {
        let inferred = expectation(description: "Old captured audio cannot be inference evidence")
        inferred.isInverted = true
        let unavailable = expectation(description: "Delayed microphone capture falls back to manual")
        let activity = LocalSpeechActivity(process: { chunk, state in
            inferred.fulfill()
            return VadStreamResult(state: state, event: nil, probability: 0.9)
        }, receive: { event in
            if case .unavailable = event { unavailable.fulfill() }
        })
        defer { activity.stop() }
        let url = FileManager.default.temporaryDirectory.appending(path: "host-time-\(UUID().uuidString).caf")
        defer { try? FileManager.default.removeItem(at: url) }
        let writer = try CaptureFile(url: url, format: AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1)!)
        let tap = await MainActor.run { CaptureFile.tap(for: writer, activity: activity) }
        try await Task.detached {
            let oldStart = ProcessInfo.processInfo.systemUptime - 2
            let time = AVAudioTime(hostTime: AVAudioTime.hostTime(forSeconds: oldStart))
            XCTAssertTrue(time.isHostTimeValid)
            tap(Self.buffer(), time)
            try writer.close()
        }.value
        await fulfillment(of: [unavailable], timeout: 1)
        await fulfillment(of: [inferred], timeout: 0.1)
    }

}
