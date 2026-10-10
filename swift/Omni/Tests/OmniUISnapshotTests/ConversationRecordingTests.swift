@preconcurrency import AVFoundation
import Foundation
import XCTest
@testable import OmniUI

final class ConversationRecordingTests: XCTestCase {
    func testEmptyCAFIsAnEmptyTranscriptCandidateAndQuietPCMStillNeedsTranscription() throws {
        let format = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1))
        for frames in [AVAudioFrameCount(0), AVAudioFrameCount(160)] {
            let file = FileManager.default.temporaryDirectory.appending(path: "empty-pause-\(UUID().uuidString).caf")
            defer { try? FileManager.default.removeItem(at: file) }
            do {
                let writer = try AVAudioFile(forWriting: file, settings: format.settings)
                if frames > 0 {
                    let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames))
                    buffer.frameLength = frames
                    for frame in 0..<Int(frames) { buffer.floatChannelData![0][frame] = 0 }
                    try writer.write(from: buffer)
                }
            }
            XCTAssertEqual(try ConversationDevice.recordingIsEmpty(file), frames == 0)
        }
        let missing = FileManager.default.temporaryDirectory.appending(path: "missing-recording-\(UUID().uuidString).caf")
        XCTAssertThrowsError(try ConversationDevice.recordingIsEmpty(missing), "A real file failure must not become a quiet empty Pause")
    }
}
