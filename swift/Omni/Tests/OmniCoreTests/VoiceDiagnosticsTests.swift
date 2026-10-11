import Foundation
import XCTest
@testable import OmniCore

final class VoiceDiagnosticsTests: XCTestCase {
    func testTraceIsBoundedMetadataAndRetainsOrderAcrossReopen() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appending(path: "events.json")
        let log = VoiceEventLog(url: url, capacity: 2)
        log.record(.sessionStart); log.record(.captureReady); log.record(.transcribing)
        await log.flush()
        let reopened = VoiceEventLog(url: url, capacity: 2)
        reopened.record(.emptyCapture); await reopened.flush()
        let data = try Data(contentsOf: url)
        let rows = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [[String: Any]])
        XCTAssertEqual(rows.compactMap { $0["event"] as? String }, ["transcribing", "emptyCapture"])
        XCTAssertTrue(rows.allSatisfy { Set($0.keys) == ["at", "event"] })
        XCTAssertEqual(try FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? Int, 0o600)
    }
    func testMalformedPriorFileDoesNotPreventNewEvents() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appending(path: "events.json")
        try Data("invalid".utf8).write(to: url)
        let log = VoiceEventLog(url: url)
        log.record(.playbackFailed); await log.flush()
        let rows = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [[String: Any]])
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows.first?["event"] as? String, "playbackFailed")
    }
}
