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
        for _ in 0..<40 { activity.append(Self.buffer()) }
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

    nonisolated static func nativeBuffer(rate: Double, frames: Int, interleaved: Bool) -> AVAudioPCMBuffer {
        let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 2, interleaved: interleaved)!
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames))!
        buffer.frameLength = AVAudioFrameCount(frames)
        for frame in 0..<frames {
            if interleaved {
                buffer.floatChannelData![0][frame * 2] = 0.2
                buffer.floatChannelData![0][frame * 2 + 1] = 0.4
            } else {
                buffer.floatChannelData![0][frame] = 0.2
                buffer.floatChannelData![1][frame] = 0.4
            }
        }
        return buffer
    }
    func testNativeTapSizesProduceFreshFramesWithoutFormatFallback() async {
        // 100 ms and 400 ms taps, including Apple's 4,800/19,200-frame 48 kHz sizes.
        for rate in [16_000.0, 44_100.0, 48_000.0, 96_000.0] {
            for duration in [0.1, 0.4] {
                for interleaved in [false, true] {
                    let probe = Probe()
                    let first = expectation(description: "First fresh local result \(rate)/\(duration)/\(interleaved)")
                    first.assertForOverFulfill = false
                    let unavailable = expectation(description: "Valid tap must not fall back"); unavailable.isInverted = true
                    let activity = LocalSpeechActivity(process: { await probe.process($0, state: $1) }, receive: { event in
                        switch event {
                        case let .frame(_, capturedAt, duration, _):
                            XCTAssertLessThanOrEqual(ProcessInfo.processInfo.systemUptime - capturedAt, 0.5)
                            XCTAssertEqual(duration, Double(VadManager.chunkSize) / 16_000)
                            first.fulfill()
                        case .unavailable: unavailable.fulfill()
                        }
                    })
                    let count = duration == 0.1 ? 3 : 1
                    let end = ProcessInfo.processInfo.systemUptime
                    for index in 0..<count {
                        let input = Self.nativeBuffer(rate: rate, frames: Int(rate * duration), interleaved: interleaved)
                        activity.append(input, capturedEnd: end - Double(count - index - 1) * duration)
                    }
                    await fulfillment(of: [first], timeout: 2)
                    activity.stop()
                    await fulfillment(of: [unavailable], timeout: 0.01)
                    let samples = await probe.samples
                    XCTAssertEqual(samples.count, VadManager.chunkSize)
                    let middle = samples.dropFirst(256).dropLast(256)
                    XCTAssertEqual(Double(middle.reduce(0, +)) / Double(middle.count), 0.3, accuracy: 0.01)
                }
            }
        }
    }
    func testOversizedDurationIsBoundedAndNeverInferred() async {
        let unavailable = expectation(description: "Unbounded tap rejected")
        let inferred = expectation(description: "Oversized tap never inferred"); inferred.isInverted = true
        let activity = LocalSpeechActivity(process: { _, state in
            inferred.fulfill(); return VadStreamResult(state: state, event: nil, probability: 0)
        }, receive: { if case .unavailable = $0 { unavailable.fulfill() } })
        activity.append(Self.nativeBuffer(rate: 48_000, frames: 24_000, interleaved: true))
        await fulfillment(of: [unavailable], timeout: 1)
        await fulfillment(of: [inferred], timeout: 0.01)
        activity.stop()
    }
    func testInferenceThatBecomesStaleCannotEmitSilence() async {
        let probe = Probe()
        let started = expectation(description: "Inference started")
        let unavailable = expectation(description: "Stale inference disables detector")
        let emitted = expectation(description: "No stale silence evidence"); emitted.isInverted = true
        let activity = LocalSpeechActivity(process: { await probe.process($0, state: $1, hold: true, onWaiting: { started.fulfill() }) }, receive: {
            switch $0 { case .frame: emitted.fulfill(); case .unavailable: unavailable.fulfill() }
        })
        defer { activity.stop() }
        activity.append(Self.buffer())
        await fulfillment(of: [started], timeout: 2)
        try? await Task.sleep(for: .milliseconds(550))
        await probe.release()
        await fulfillment(of: [unavailable], timeout: 1)
        await fulfillment(of: [emitted], timeout: 0.01)
    }

    private final class TapCount: @unchecked Sendable {
        private let lock = NSLock()
        private var value = 0
        func add() { lock.lock(); value += 1; lock.unlock() }
        var count: Int { lock.lock(); defer { lock.unlock() }; return value }
    }
    func testFirstTapReportsOncePerCaptureAndIgnoresEmptyOrClosedTap() throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let buffer = Self.buffer(); let count = TapCount()
        for index in 0..<2 {
            let writer = try CaptureFile(url: directory.appending(path: "capture-\(index).caf"), format: buffer.format)
            let tap = CaptureFile.tap(for: writer, firstTap: count.add)
            buffer.frameLength = 0; tap(buffer, AVAudioTime(sampleTime: 0, atRate: 16_000))
            XCTAssertEqual(count.count, index)
            buffer.frameLength = 4096
            for _ in 0..<8 { tap(buffer, AVAudioTime(sampleTime: 0, atRate: 16_000)) }
            XCTAssertEqual(count.count, index + 1)
            try writer.close()
            tap(buffer, AVAudioTime(sampleTime: 0, atRate: 16_000))
            XCTAssertEqual(count.count, index + 1)
        }
        let closed = try CaptureFile(url: directory.appending(path: "closed.caf"), format: buffer.format)
        let late = CaptureFile.tap(for: closed, firstTap: count.add)
        try closed.close(); late(buffer, AVAudioTime(sampleTime: 0, atRate: 16_000))
        XCTAssertEqual(count.count, 2)
    }

}
