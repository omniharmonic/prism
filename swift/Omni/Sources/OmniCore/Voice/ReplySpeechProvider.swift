import Foundation
import Observation
import OmniClient
import PrismTransport

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
/// Local Apple and authenticated paired-server adapters share playback ownership.
public protocol ReplySpeechProvider: Sendable {
    func render(_ text: String) async throws -> ReplySpeechRendering
}
public struct AppleReplySpeechProvider: ReplySpeechProvider {
    public init() {}
    public func render(_ text: String) async throws -> ReplySpeechRendering { try Task.checkCancellation(); return .systemVoice(text) }
}
public struct HermesReplySpeechProvider: ReplySpeechProvider {
    private let providerID: String
    private let service: any HermesSpeechService
    private let sessionID: String
    private let voiceID: String
    private let diagnostic: @Sendable (VoiceDiagnosticEvent) -> Void
    public init(service: any HermesSpeechService, sessionID: String, voiceID: String, providerID: String = "hermes-edge", diagnostic: @escaping @Sendable (VoiceDiagnosticEvent) -> Void = VoiceDiagnostics.record) {
        self.providerID = providerID; self.service = service; self.sessionID = sessionID; self.voiceID = voiceID; self.diagnostic = diagnostic
    }
    public func render(_ text: String) async throws -> ReplySpeechRendering {
        let requestID = UUID().uuidString
        let request = VoiceSynthesisRequest(sessionID: sessionID, requestID: requestID, providerID: providerID, voiceID: voiceID, text: text)
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            diagnostic(.synthesisStarted)
            do {
                let data = try await service.synthesizeVoice(request)
                try Task.checkCancellation()
                diagnostic(.synthesisFinished)
                return .encodedAudio(data)
            } catch {
                if !Task.isCancelled, !(error is CancellationError) {
                    diagnostic(.synthesisFailed)
                    diagnostic(SynthesisFailureDiagnostic.event(for: error))
                }
                throw error
            }
        } onCancel: {
            Task { try? await service.cancelVoiceSynthesis(sessionID: sessionID, requestID: requestID) }
        }
    }
}
/// Only fixed categories reach the event trace. Server details, raw errors and
/// response bodies are never recorded. A remote cancellation remains a failure
/// when this task is still active, allowing the caller to deliver its fallback.
enum SynthesisFailureDiagnostic {
    static func event(for error: Error) -> VoiceDiagnosticEvent {
        if let error = error as? PrismError {
            if error.httpStatus == 409, error.serverCode == "voice_cancelled" { return .synthesisRemoteCancelled }
            if error.httpStatus == 408 || error.httpStatus == 504 { return .synthesisTimeout }
            if error.httpStatus == 429 || error.httpStatus == 503 { return .synthesisUnavailable }
            switch error {
            case .notSignedIn, .signedOut, .unauthorized, .forbidden: return .synthesisUnauthorized
            case .decoding: return .synthesisInvalidAudio
            case .invalidRequest, .rejected: return .synthesisInvalidRequest
            case .unreachable: return .synthesisTransportFailed
            case .outcomeUnknown(let outcome): return outcome.status == nil ? .synthesisTransportFailed : .synthesisOtherFailure
            default: return .synthesisOtherFailure
            }
        }
        if let error = error as? URLError {
            return error.code == .timedOut ? .synthesisTimeout : .synthesisTransportFailed
        }
        return .synthesisOtherFailure
    }
}
public typealias HermesEdgeReplySpeechProvider = HermesReplySpeechProvider

@MainActor @Observable public final class ReplySpeechPreferences {
    public enum Provider: String, CaseIterable, Sendable { case apple, hermesEdge = "hermes-edge", kokoro = "kokoro-local" }
    public var provider: Provider { didSet { defaults.set(provider.rawValue, forKey: "omni.replySpeech.provider") } }
    public var edgeVoiceID: String? { didSet { defaults.set(edgeVoiceID, forKey: "omni.replySpeech.edgeVoice") } }
    public var kokoroVoiceID: String { didSet { defaults.set(kokoroVoiceID, forKey: "omni.replySpeech.kokoroVoice") } }
    private let defaults: UserDefaults
    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        // Prefer Kokoro for new installations. Preserve every explicit choice,
        // including Apple and its independent downloaded-voice identifier.
        provider = defaults.string(forKey: "omni.replySpeech.provider").flatMap(Provider.init(rawValue:)) ?? .kokoro
        edgeVoiceID = defaults.string(forKey: "omni.replySpeech.edgeVoice")
        kokoroVoiceID = defaults.string(forKey: "omni.replySpeech.kokoroVoice") ?? "af_heart"
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
