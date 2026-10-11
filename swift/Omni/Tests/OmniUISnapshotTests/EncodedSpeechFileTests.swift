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
