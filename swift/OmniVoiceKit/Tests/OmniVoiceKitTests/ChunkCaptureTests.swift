@preconcurrency import AVFoundation
import Foundation
import XCTest
@testable import OmniVoiceKit

final class ChunkCaptureTests: XCTestCase {
    func testRotationPreservesPCMAndOverlappingLeadIn() throws {
        let url = FileManager.default.temporaryDirectory.appending(path: "chunks-\(UUID().uuidString).caf")
        let format = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1))
        let writer = try CaptureFile(url: url, format: format, chunkSeconds: 2)
        defer { writer.recordings().forEach { try? FileManager.default.removeItem(at: $0) } }
        // Each buffer carries a distinct value, exposing a lost/reordered boundary.
        for index in 0..<5 {
            let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 16_000))
            buffer.frameLength = 16_000
            for sample in 0..<16_000 { buffer.floatChannelData![0][sample] = Float(index + 1) / 10 }
            writer.append(buffer)
        }
        try writer.close()
        let files = writer.recordings()
        XCTAssertEqual(files.count, 4)
        var values: [Float] = []
        for (index, url) in files.enumerated() {
            let file = try AVAudioFile(forReading: url)
            XCTAssertLessThanOrEqual(file.length, 32_000)
            let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)))
            try file.read(into: buffer)
            // Drop the deliberately duplicated one-second lead-in after chunk zero.
            let offset = index == 0 ? 0 : 16_000
            values.append(contentsOf: UnsafeBufferPointer(start: buffer.floatChannelData![0] + offset, count: Int(buffer.frameLength) - offset))
        }
        XCTAssertEqual(values.count, 80_000)
        for index in 0..<5 { XCTAssertEqual(values[index * 16_000], Float(index + 1) / 10, accuracy: 0.001) }
    }
    func testTranscriptOverlapKeepsWordsAndPunctuation() {
        XCTAssertEqual(ConversationTranscript.join("I was thinking about the garden.", "the garden and its trees."), "I was thinking about the garden. and its trees.")
        XCTAssertEqual(ConversationTranscript.join("First thought.", "Second thought."), "First thought. Second thought.")
        XCTAssertEqual(ConversationTranscript.join("", "A new thought."), "A new thought.")
    }
}
