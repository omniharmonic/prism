import Foundation
import PrismTransport

extension OmniClient {
    public func voiceProviders() async throws -> VoiceProviderCatalog {
        try await transport.send(.get("/api/omni/voice/providers"))
    }
    public func synthesizeVoice(_ request: VoiceSynthesisRequest) async throws -> Data {
        guard request.text.utf16.count <= 4000, !request.text.isEmpty else { throw PrismError.invalidRequest("The speech passage is too long or empty.") }
        var call = try PrismRequest.json("POST", "/api/omni/voice/synthesis", body: request)
        call.timeout = 40
        let response: PrismResponse = try await transport.send(call)
        guard response.header("Content-Type")?.split(separator: ";").first?.trimmingCharacters(in: .whitespaces) == "audio/mpeg",
              !response.body.isEmpty, response.body.count <= 10 * 1024 * 1024 else {
            throw PrismError.decoding("The speech server returned unsupported or oversized audio.")
        }
        return response.body
    }
    public func cancelVoiceSynthesis(sessionID: String, requestID: String) async throws {
        guard UUID(uuidString: requestID) != nil, UUID(uuidString: sessionID) != nil else { throw PrismError.invalidRequest("Invalid speech request identifier.") }
        struct Body: Encodable { let sessionID: String }
        let _: PrismResponse = try await transport.send(.json("DELETE", "/api/omni/voice/synthesis/\(requestID)", body: Body(sessionID: sessionID)))
    }
}
