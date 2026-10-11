import XCTest
import AVFoundation
@testable import OmniUI

final class EncodedSpeechFileTests: XCTestCase {
    private var fixture: URL { Bundle.module.url(forResource: "edge-eof", withExtension: "mp3", subdirectory: "Fixtures")! }

    func testRealEdgeMP3DrainsEveryFrameThenReturnsCleanEOF() throws {
        // 4096 ends with a partial block; 576 ends on an exact block boundary.
        // Both must reach EOF without the old AVAudioFile nilError failure.
        for block: UInt32 in [4096, 576] {
            let reader = try EncodedSpeechFile(url: fixture)
            var total = 0
            var last: UInt32 = 0
            while let buffer = try reader.read(frameCount: block) {
                XCTAssertGreaterThan(buffer.frameLength, 0)
                XCTAssertLessThanOrEqual(buffer.frameLength, block)
                total += Int(buffer.frameLength); last = buffer.frameLength
            }
            XCTAssertEqual(total, 148032)
            XCTAssertEqual(last, 576)
            XCTAssertNil(try reader.read(frameCount: block))
        }
    }
    func testWAVAndMP3DecodeWithContentAgnosticTemporarySuffix() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".audio")
        defer { try? FileManager.default.removeItem(at: url) }
        // A real RIFF PCM16 mono waveform at Kokoro's 24 kHz sample rate.
        let frames = 2400
        var wav = Data()
        func ascii(_ value: String) { wav.append(contentsOf: value.utf8) }
        func little<T: FixedWidthInteger>(_ value: T) {
            var value = value.littleEndian
            withUnsafeBytes(of: &value) { wav.append(contentsOf: $0) }
        }
        ascii("RIFF"); little(UInt32(36 + frames * 2)); ascii("WAVEfmt ")
        little(UInt32(16)); little(UInt16(1)); little(UInt16(1))
        little(UInt32(24000)); little(UInt32(48000)); little(UInt16(2)); little(UInt16(16))
        ascii("data"); little(UInt32(frames * 2))
        for frame in 0..<frames { little(Int16(sin(Double(frame) * 2 * .pi * 440 / 24000) * 8000)) }
        try wav.write(to: url)
        let reader = try EncodedSpeechFile(url: url)
        XCTAssertEqual(reader.format.sampleRate, 24000)
        var decoded = 0
        while let buffer = try reader.read() { decoded += Int(buffer.frameLength) }
        XCTAssertEqual(decoded, frames)
        XCTAssertNil(try reader.read())
        try Data(contentsOf: fixture).write(to: url)
        let mp3 = try EncodedSpeechFile(url: url)
        var mp3Frames = 0
        while let buffer = try mp3.read() { mp3Frames += Int(buffer.frameLength) }
        XCTAssertEqual(mp3Frames, 148032)
    }
    func testDecodedDurationBudgetStillRejectsNonemptyAudio() throws {
        let reader = try EncodedSpeechFile(url: fixture, maximumSeconds: 0.1)
        XCTAssertThrowsError(try reader.read())
    }
    func testMalformedFileIsNotTreatedAsCleanEOF() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".mp3")
        defer { try? FileManager.default.removeItem(at: url) }
        try Data([0, 1, 2, 3]).write(to: url)
        XCTAssertThrowsError(try EncodedSpeechFile(url: url))
    }
}
