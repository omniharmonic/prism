import Foundation
import XCTest
@testable import OmniVoiceKit

final class VoiceVocabularyStoreTests: XCTestCase {
    private func withStore(_ body: (VoiceVocabularyStore) throws -> Void) throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: "vocabulary-tests-\(UUID().uuidString)", directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: directory) }
        try body(VoiceVocabularyStore(directory: directory))
    }
    func testMissingVocabularyHasNoSeededBias() throws {
        try withStore { store in XCTAssertEqual(store.load(), []) }
    }
    func testExplicitEmptyVocabularySurvivesRestorationAndIndependentReaders() throws {
        try withStore { store in
            try store.save(["Benjamin Life", "Hermes", "Parachute"])
            let conversation = VoiceVocabularyStore(directory: store.directory)
            XCTAssertEqual(conversation.load(), ["Benjamin Life", "Hermes", "Parachute"])
            try store.save([])
            XCTAssertEqual(conversation.load(), [])
            XCTAssertEqual(VoiceVocabularyStore(directory: store.directory).load(), [])
        }
    }
    func testExistingBenchmarkVocabularyIsReadWithoutReplacement() throws {
        try withStore { store in
            try FileManager.default.createDirectory(at: store.directory, withIntermediateDirectories: true)
            let existing = ["a particular poem", "Zephyr"]
            try JSONEncoder().encode(existing).write(to: store.directory.appending(path: "vocabulary.json"))
            XCTAssertEqual(store.load(), existing)
        }
    }
    func testCorruptVocabularyFailsToUnbiasedEmptyList() throws {
        try withStore { store in
            try FileManager.default.createDirectory(at: store.directory, withIntermediateDirectories: true)
            try Data("invalid json".utf8).write(to: store.directory.appending(path: "vocabulary.json"))
            XCTAssertEqual(store.load(), [])
        }
    }
}
