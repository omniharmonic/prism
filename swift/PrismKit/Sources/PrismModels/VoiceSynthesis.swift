import Foundation

public struct VoiceProviderCatalog: Decodable, Sendable {
    public let providers: [VoiceProvider]
}
public struct VoiceProvider: Decodable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let available: Bool
    public let cloud: Bool
    public let disclosure: String
    public let defaultVoiceID: String
    public let voices: [RemoteSpeechVoice]
    public let maxCharacters: Int
    public let maxAudioBytes: Int
}
public struct RemoteSpeechVoice: Decodable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let language: String
}
public struct VoiceSynthesisRequest: Encodable, Sendable {
    public let sessionID: String
    public let requestID: String
    public let providerID: String
    public let voiceID: String
    public let text: String
    public init(sessionID: String, requestID: String, providerID: String, voiceID: String, text: String) {
        self.sessionID = sessionID; self.requestID = requestID; self.providerID = providerID; self.voiceID = voiceID; self.text = text
    }
}
