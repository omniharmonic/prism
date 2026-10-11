import Foundation
import Observation
import OmniClient

/// Optional authenticated synthesis capability. No microphone audio is sent.
public protocol HermesSpeechService: Sendable {
    var speechServiceIdentity: ObjectIdentifier { get }
    func voiceProviders() async throws -> VoiceProviderCatalog
    func synthesizeVoice(_ request: VoiceSynthesisRequest) async throws -> Data
    func cancelVoiceSynthesis(sessionID: String, requestID: String) async throws
}
public extension HermesSpeechService {
    /// Reference adapters retain their identity; value adapters should expose
    /// the identity of their stable authenticated transport.
    var speechServiceIdentity: ObjectIdentifier { ObjectIdentifier(self as AnyObject) }
}
extension LiveOmniService: HermesSpeechService {
    public var speechServiceIdentity: ObjectIdentifier { ObjectIdentifier(client.transport) }
    public func voiceProviders() async throws -> VoiceProviderCatalog { try await client.voiceProviders() }
    public func synthesizeVoice(_ request: VoiceSynthesisRequest) async throws -> Data { try await client.synthesizeVoice(request) }
    public func cancelVoiceSynthesis(sessionID: String, requestID: String) async throws { try await client.cancelVoiceSynthesis(sessionID: sessionID, requestID: requestID) }
}

public enum ReplySpeechRendering: Sendable {
    case systemVoice(String)
    case encodedAudio(Data)
}
/// A new local model adapter can implement this seam without changing sessions or playback.
/// Only the shipped Apple and authenticated Hermes adapters are exposed in settings.
public protocol ReplySpeechProvider: Sendable {
    func render(_ text: String) async throws -> ReplySpeechRendering
}
public struct AppleReplySpeechProvider: ReplySpeechProvider {
    public init() {}
    public func render(_ text: String) async throws -> ReplySpeechRendering { try Task.checkCancellation(); return .systemVoice(text) }
}
public struct HermesEdgeReplySpeechProvider: ReplySpeechProvider {
    private let service: any HermesSpeechService
    private let sessionID: String
    private let voiceID: String
    private let diagnostic: @Sendable (VoiceDiagnosticEvent) -> Void
    public init(service: any HermesSpeechService, sessionID: String, voiceID: String, diagnostic: @escaping @Sendable (VoiceDiagnosticEvent) -> Void = VoiceDiagnostics.record) {
        self.service = service; self.sessionID = sessionID; self.voiceID = voiceID; self.diagnostic = diagnostic
    }
    public func render(_ text: String) async throws -> ReplySpeechRendering {
        let requestID = UUID().uuidString
        let request = VoiceSynthesisRequest(sessionID: sessionID, requestID: requestID, providerID: "hermes-edge", voiceID: voiceID, text: text)
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            diagnostic(.synthesisStarted)
            do {
                let data = try await service.synthesizeVoice(request)
                try Task.checkCancellation()
                diagnostic(.synthesisFinished)
                return .encodedAudio(data)
            } catch {
                if !Task.isCancelled, !(error is CancellationError) { diagnostic(.synthesisFailed) }
                throw error
            }
        } onCancel: {
            Task { try? await service.cancelVoiceSynthesis(sessionID: sessionID, requestID: requestID) }
        }
    }
}
@MainActor @Observable public final class ReplySpeechPreferences {
    public enum Provider: String, CaseIterable, Sendable { case apple, hermesEdge = "hermes-edge" }
    public var provider: Provider { didSet { defaults.set(provider.rawValue, forKey: "omni.replySpeech.provider") } }
    public var edgeVoiceID: String? { didSet { defaults.set(edgeVoiceID, forKey: "omni.replySpeech.edgeVoice") } }
    private let defaults: UserDefaults
    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        // Owner chose Hermes for this rollout. Preserve every later explicit choice,
        // including Apple and its independent downloaded-voice identifier.
        provider = defaults.string(forKey: "omni.replySpeech.provider").flatMap(Provider.init(rawValue:)) ?? .hermesEdge
        edgeVoiceID = defaults.string(forKey: "omni.replySpeech.edgeVoice")
    }
}
public enum ReplySpeechPassages {
    /// Bounded exact-text partitions for the server's UTF-16 character budget.
    /// Prefer sentence/word boundaries; never summarize or discard a remainder.
    public static func split(_ text: String, maxCharacters: Int = 4000) -> [String] {
        guard maxCharacters > 0 else { return [] }
        var result: [String] = []
        var start = text.startIndex
        while start < text.endIndex {
            var end = start; var count = 0
            while end < text.endIndex {
                let next = text.index(after: end)
                let width = text[end..<next].utf16.count
                if count + width > maxCharacters { break }
                count += width; end = next
            }
            // An extremely long grapheme must not stall the loop. Ordinary prose
            // never reaches this case; report it rather than silently losing text.
            guard end > start else { return [] }
            if end < text.endIndex, let boundary = text[start..<end].lastIndex(where: { $0.isWhitespace }) {
                let after = text.index(after: boundary)
                if after > start { end = after }
            }
            result.append(String(text[start..<end])); start = end
        }
        return result
    }
}
