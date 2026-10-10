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
    func testBackpressureIsAnErrorInsteadOfSuccessfulEmptyPlayback() async throws {
        let bridge = SpeechPCMStream()
        let format = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1))
        let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 160))
        buffer.frameLength = 160
        for _ in 0..<129 { bridge.accept(buffer) }
        do {
            for try await _ in bridge.stream {}
            XCTFail("Dropped speech must never be reported as successful playback")
        } catch { XCTAssertTrue(error.localizedDescription.contains("keep up")) }
    }
}
