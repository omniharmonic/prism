import Foundation
import PrismTransport

extension OmniClient {
    public func voiceProviders() async throws -> VoiceProviderCatalog {
        try await transport.send(.get("/api/omni/voice/providers"))
    }
    public func synthesizeVoice(_ request: VoiceSynthesisRequest) async throws -> Data {
        let contentType: String
        let maximumCharacters: Int
        let maximumAudioBytes: Int
        switch request.providerID {
        case "hermes-edge":
            contentType = "audio/mpeg"; maximumCharacters = 4000; maximumAudioBytes = 10 * 1024 * 1024
        case "kokoro-local":
            contentType = "audio/wav"; maximumCharacters = 160; maximumAudioBytes = 1_440_044
        default: throw PrismError.invalidRequest("Unsupported speech provider.")
        }
        guard request.text.utf16.count <= maximumCharacters, !request.text.isEmpty else { throw PrismError.invalidRequest("The speech passage is too long or empty.") }
        var call = try PrismRequest.json("POST", "/api/omni/voice/synthesis", body: request)
        call.timeout = 40
        let response: PrismResponse = try await transport.send(call)
        guard response.header("Content-Type")?.split(separator: ";").first?.trimmingCharacters(in: .whitespaces) == contentType,
              !response.body.isEmpty, response.body.count <= maximumAudioBytes else {
            throw PrismError.decoding("The speech server returned unsupported or oversized audio.")
        }
        if request.providerID == "kokoro-local" {
            // Validate the container signature; playback owns full PCM decoding.
            guard response.body.count >= 44,
                  response.body.prefix(4) == Data("RIFF".utf8),
                  response.body.dropFirst(8).prefix(4) == Data("WAVE".utf8) else {
                throw PrismError.decoding("The speech server returned an invalid WAV container.")
            }
        }
        return response.body
    }
    public func cancelVoiceSynthesis(sessionID: String, requestID: String) async throws {
        guard UUID(uuidString: requestID) != nil, UUID(uuidString: sessionID) != nil else { throw PrismError.invalidRequest("Invalid speech request identifier.") }
        struct Body: Encodable { let sessionID: String }
        let _: PrismResponse = try await transport.send(.json("DELETE", "/api/omni/voice/synthesis/\(requestID)", body: Body(sessionID: sessionID)))
    }
}
