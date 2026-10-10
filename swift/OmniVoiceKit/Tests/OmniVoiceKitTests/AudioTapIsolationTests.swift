@preconcurrency import AVFoundation
import Foundation
import XCTest
@testable import OmniVoiceKit

final class AudioTapIsolationTests: XCTestCase {
    nonisolated private static func offMainThread() -> Bool { !Thread.isMainThread }
    @MainActor func testTapCreatedFromMainActorWritesRealBufferOffMainAndIgnoresAfterClose() async throws {
        let url = FileManager.default.temporaryDirectory.appending(path: "tap-isolation-\(UUID().uuidString).caf")
        defer { try? FileManager.default.removeItem(at: url) }
        let format = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1))
        let writer = try CaptureFile(url: url, format: format)
        // This is the same factory used by AudioIO.start while on MainActor.
        let tap = CaptureFile.tap(for: writer)
        let captured = try await Task.detached {
            guard Self.offMainThread() else { throw VoiceFailure.unavailable("Test callback must run off main.") }
            let format = AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1)!
            let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 160)!
            buffer.frameLength = 160
            for index in 0..<160 { buffer.floatChannelData![0][index] = 0.25 }
            tap(buffer, AVAudioTime(sampleTime: 0, atRate: 16_000))
            try writer.close()
            // A late callback retains the writer, but may not write a closed file.
            tap(buffer, AVAudioTime(sampleTime: 160, atRate: 16_000))
            let recorded = try AVAudioFile(forReading: url)
            let output = AVAudioPCMBuffer(pcmFormat: recorded.processingFormat, frameCapacity: 160)!
            try recorded.read(into: output)
            return (recorded.length, output.floatChannelData![0][0])
        }.value
        XCTAssertEqual(captured.0, 160)
        XCTAssertEqual(captured.1, 0.25, accuracy: 0.001)
    }
}
