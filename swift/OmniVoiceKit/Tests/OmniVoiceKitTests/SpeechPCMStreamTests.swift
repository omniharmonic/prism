@preconcurrency import AVFoundation
import XCTest
@testable import OmniVoiceKit

final class SpeechPCMStreamTests: XCTestCase {
    func testBorrowedPCMIsCopiedAndEndCannotOvertakeQueuedAudio() async throws {
        let bridge = SpeechPCMStream()
        let format = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1))
        let reused = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 160))
        reused.frameLength = 160
        for value: Float in [0.1, 0.2, 0.3] {
            for index in 0..<160 { reused.floatChannelData![0][index] = value }
            bridge.accept(reused)
        }
        reused.frameLength = 0; bridge.accept(reused)
        // Simulate Apple reusing its callback buffer before MainActor consumes it.
        reused.frameLength = 160
        for index in 0..<160 { reused.floatChannelData![0][index] = 0.9 }
        var values: [Float] = []
        for try await owned in bridge.stream { values.append(owned.buffer.floatChannelData![0][0]) }
        XCTAssertEqual(values.count, 3)
        for (value, expected) in zip(values, [Float(0.1), 0.2, 0.3]) { XCTAssertEqual(value, expected, accuracy: 0.001) }
    }
    func testBurstBeyond128SmallBuffersPreservesEveryFrameWithinByteBudget() async throws {
        let bridge = SpeechPCMStream()
        let format = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1))
        let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 64))
        buffer.frameLength = 64
        for _ in 0..<512 { bridge.accept(buffer) }
        buffer.frameLength = 0; bridge.accept(buffer)
        var samples = 0
        for try await owned in bridge.stream { samples += Int(owned.buffer.frameLength); bridge.release(owned) }
        XCTAssertEqual(samples, 512 * 64)
    }
    func testByteBudgetRejectsOversizedBurstBeforeCountLimit() async throws {
        let bridge = SpeechPCMStream()
        let format = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1))
        let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 65_536))
        buffer.frameLength = 65_536
        for _ in 0..<17 { bridge.accept(buffer) }
        var samples = 0
        do {
            for try await owned in bridge.stream { samples += Int(owned.buffer.frameLength); bridge.release(owned) }
            XCTFail("Expected byte budget failure")
        } catch { XCTAssertTrue(error.localizedDescription.contains("keep up")) }
        XCTAssertLessThanOrEqual(samples * 4, bridge.maximumBytes)
    }
    func testLongReplySegmentsPreserveAllWordsAndOrder() {
        let text = Array(repeating: "A thoughtful reply with dates 2026 and punctuation.", count: 100).joined(separator: " ")
        let segments = SpeechUtteranceSegments.split(text)
        XCTAssertGreaterThan(segments.count, 1)
        XCTAssertTrue(segments.allSatisfy { $0.count <= 160 })
        XCTAssertEqual(segments.joined(separator: " "), text)
    }
    func testBackpressureIsAnErrorInsteadOfSuccessfulEmptyPlayback() async throws {
        let bridge = SpeechPCMStream()
        let format = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1))
        let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 160))
        buffer.frameLength = 160
        for _ in 0..<4097 { bridge.accept(buffer) }
        do {
            for try await _ in bridge.stream {}
            XCTFail("Dropped speech must never be reported as successful playback")
        } catch { XCTAssertTrue(error.localizedDescription.contains("keep up")) }
    }
}
