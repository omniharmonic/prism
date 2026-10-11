import Foundation

/// The benchmark and conversation share only vocabulary explicitly saved on this device.
public struct VoiceVocabularyStore: Sendable {
    public let directory: URL
    public init(directory: URL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appending(path: "OmniSpeechBench", directoryHint: .isDirectory)) {
        self.directory = directory
    }
    public func load() -> [String] {
        guard let data = try? Data(contentsOf: directory.appending(path: "vocabulary.json")),
              let words = try? JSONDecoder().decode([String].self, from: data) else { return [] }
        return words
    }
    public func save(_ words: [String]) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try JSONEncoder().encode(words).write(to: directory.appending(path: "vocabulary.json"), options: .atomic)
    }
}
