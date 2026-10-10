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
            var chunk: [Float] = []
            // AVAudioFile.read may return a partial buffer (observed 31,744 of
            // 32,000 frames). Drain the file rather than mistaking one read for EOF.
            while file.framePosition < file.length {
                let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length - file.framePosition)))
                try file.read(into: buffer)
                XCTAssertGreaterThan(buffer.frameLength, 0)
                guard buffer.frameLength > 0 else { break }
                chunk.append(contentsOf: UnsafeBufferPointer(start: buffer.floatChannelData![0], count: Int(buffer.frameLength)))
            }
            XCTAssertEqual(chunk.count, Int(file.length))
            let offset = index == 0 ? 0 : 16_000
            values.append(contentsOf: chunk.dropFirst(offset))
        }
        XCTAssertEqual(values.count, 80_000)
        for index in 0..<5 { XCTAssertEqual(values[index * 16_000], Float(index + 1) / 10, accuracy: 0.001) }
    }
    func testInterruptionPromotionRetainsOnlyRecentLeadIn() throws {
        let url = FileManager.default.temporaryDirectory.appending(path: "lead-in-\(UUID().uuidString).caf")
        let format = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1))
        let writer = try CaptureFile(url: url, format: format, chunkSeconds: 60)
        defer { writer.recordings().forEach { try? FileManager.default.removeItem(at: $0) } }
        for index in 0..<4 {
            let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 16_000))
            buffer.frameLength = 16_000
            for sample in 0..<16_000 { buffer.floatChannelData![0][sample] = Float(index + 1) / 10 }
            writer.append(buffer)
        }
        try writer.retainLeadIn(); try writer.close()
        let file = try AVAudioFile(forReading: url)
        XCTAssertEqual(file.length, 16_000)
        let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: 16_000))
        try file.read(into: buffer)
        XCTAssertEqual(buffer.floatChannelData![0][0], 0.4, accuracy: 0.001)
    }
    func testTranscriptOverlapKeepsWordsAndPunctuation() {
        XCTAssertEqual(ConversationTranscript.join("I was thinking about the garden.", "the garden and its trees."), "I was thinking about the garden. and its trees.")
        XCTAssertEqual(ConversationTranscript.join("First thought.", "Second thought."), "First thought. Second thought.")
        XCTAssertEqual(ConversationTranscript.join("No", "no, I meant yes."), "No no, I meant yes.")
        XCTAssertEqual(ConversationTranscript.join("", "A new thought."), "A new thought.")
    }
}
