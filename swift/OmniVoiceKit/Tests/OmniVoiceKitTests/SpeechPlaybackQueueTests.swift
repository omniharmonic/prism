@preconcurrency import AVFoundation
import XCTest
@testable import OmniVoiceKit

@MainActor final class SpeechPlaybackQueueTests: XCTestCase {
    func testHardwareCompletionBoundsSchedulingAndCancelReleasesBlockedProducer() async throws {
        let queue = SpeechPlaybackQueue()
        let format = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1))
        let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 16_000))
        buffer.frameLength = 16_000
        var completions: [@Sendable () -> Void] = []
        var scheduled = 0
        let play: @MainActor (AVAudioPCMBuffer, @escaping @Sendable () -> Void) throws -> Void = { _, completion in
            scheduled += 1; completions.append(completion)
        }
        try await queue.schedule(buffer, play: play)
        try await queue.schedule(buffer, play: play)
        let blocked = Task { try await queue.schedule(buffer, play: play) }
        for _ in 0..<10 { await Task.yield() }
        XCTAssertEqual(scheduled, 2)
        XCTAssertEqual(queue.inFlightSeconds, 2)
        completions[0](); try await blocked.value
        XCTAssertEqual(scheduled, 3)
        XCTAssertEqual(queue.inFlightSeconds, 2)
        let cancelled = Task { try await queue.schedule(buffer, play: play) }
        for _ in 0..<10 { await Task.yield() }
        queue.cancel()
        do { try await cancelled.value; XCTFail("Cancellation must release a blocked producer with an error") } catch { XCTAssertTrue(error is CancellationError) }
        XCTAssertEqual(queue.inFlightBytes, 0)
        XCTAssertEqual(queue.inFlightSeconds, 0)
        // Old hardware callbacks cannot debit a restarted queue.
        try await queue.schedule(buffer, play: play)
        completions[1](); completions[2]()
        for _ in 0..<10 { await Task.yield() }
        XCTAssertEqual(queue.inFlightSeconds, 1)
        queue.cancel()
    }
    func testSingleProducerCancellationDoesNotReleaseAlreadyScheduledAudio() async throws {
        let queue = SpeechPlaybackQueue(maximumSeconds: 1)
        let format = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1))
        let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 16_000))
        buffer.frameLength = 16_000
        try await queue.schedule(buffer) { _, _ in }
        let blocked = Task { try await queue.schedule(buffer) { _, _ in XCTFail("Cancelled producer must never schedule") } }
        for _ in 0..<10 { await Task.yield() }
        blocked.cancel()
        do { try await blocked.value; XCTFail("Expected cancellation") } catch { XCTAssertTrue(error is CancellationError) }
        XCTAssertEqual(queue.inFlightSeconds, 1)
        queue.cancel()
    }
    func testLongGeneratedPCMReplayPreservesEveryFrameWithinHardwareBudget() async throws {
        for (rate, channels) in [(24_000.0, AVAudioChannelCount(1)), (48_000.0, AVAudioChannelCount(2))] {
            let queue = SpeechPlaybackQueue()
            let format = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: rate, channels: channels))
            let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 4096))
            buffer.frameLength = 4096
            let pieces = Int(90 * rate / 4096)
            var completions: [@Sendable () -> Void] = []
            var scheduled = 0
            var complete = false
            let producer = Task {
                defer { complete = true }
                for _ in 0..<pieces {
                    try await queue.schedule(buffer) { pcm, release in
                        XCTAssertEqual(pcm.frameLength, 4096)
                        scheduled += 1; completions.append(release)
                    }
                }
            }
            var played = 0
            while !complete || !completions.isEmpty {
                // Let the producer fill the hardware window before advancing it.
                for _ in 0..<4 { await Task.yield() }
                XCTAssertLessThanOrEqual(queue.inFlightSeconds, queue.maximumSeconds + 0.000001)
                XCTAssertLessThanOrEqual(queue.inFlightBytes, queue.maximumBytes)
                if !completions.isEmpty { completions.removeFirst()(); played += 1 }
            }
            try await producer.value
            for _ in 0..<4 { await Task.yield() }
            XCTAssertEqual(scheduled, pieces); XCTAssertEqual(played, pieces)
            XCTAssertEqual(queue.inFlightSeconds, 0, accuracy: 0.000001)
            XCTAssertEqual(queue.inFlightBytes, 0)
        }
    }

}
