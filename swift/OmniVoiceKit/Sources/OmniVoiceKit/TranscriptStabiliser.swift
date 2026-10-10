import Foundation

/// Engines provide a complete hypothesis. Only their explicitly confirmed prefix becomes
/// stable; volatile words may change freely and are never interpreted as an action.
public struct TranscriptStabiliser: Sendable {
    public private(set) var confirmed = ""
    public private(set) var volatile = ""
    public init() {}
    public mutating func update(confirmed: String, volatile: String) {
        self.confirmed = confirmed.trimmingCharacters(in: .whitespacesAndNewlines)
        self.volatile = volatile.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    public mutating func finish(_ text: String) { update(confirmed: text, volatile: "") }
    public var text: String { [confirmed, volatile].filter { !$0.isEmpty }.joined(separator: " ") }
}

public enum SpeechCondition: String, Codable, CaseIterable, Sendable {
    case quiet, outdoors, airPodsCar
}
public struct TranscriptEvent: Sendable {
    public let confirmed: String
    public let volatile: String
    public init(confirmed: String, volatile: String) { self.confirmed = confirmed; self.volatile = volatile }
}
public struct EngineResult: Codable, Sendable {
    public let engine: String
    public let text: String
    /// Measured from beginning replay, not from model preparation/download.
    public let firstWordMilliseconds: Double?
    /// Measured from the VAD speech end in real-time replay through final output.
    public let finalMilliseconds: Double
}
public enum VoiceFailure: Error, LocalizedError {
    case unavailable(String), permission, notPrepared
    public var errorDescription: String? {
        switch self {
        case .unavailable(let detail): detail
        case .permission: "Microphone or speech permission was not granted."
        case .notPrepared: "Prepare the local speech models first."
        }
    }
}
public protocol STTEngine: Sendable {
    var name: String { get }
    func availability() async -> String?
    func prepare(vocabulary: [String]) async throws
    func transcribe(file: URL, speechEnd: Double, update: @escaping @Sendable (TranscriptEvent) async -> Void) async throws -> EngineResult
}
