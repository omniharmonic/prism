import Foundation
import OmniClient
import PrismAuth
import PrismTestSupport
import PrismTransport
import XCTest

final class VoiceSynthesisTests: XCTestCase {
    func make(_ handler: @escaping StubServer.Handler) throws -> (OmniClient, StubServer) {
        let server = StubServer(handler)
        let origin = try ServerOrigin("https://prism.example.com")
        let store = InMemoryTokenStore(); try store.setToken(TestTokens.device, for: origin)
        return (OmniClient(transport: PrismClient(origin: origin, tokenStore: store, session: server.session)), server)
    }
    func testAuthenticatedDirectAudioAndExactSessionCancellationContract() async throws {
        let (client, server) = try make { request in
            if request.method == "DELETE" { return .json(200, #"{"ok":true}"#) }
            return .response(status: 200, headers: ["Content-Type": "audio/mpeg", "Cache-Control": "no-store"], chunks: [Data([1, 2, 3])])
        }
        let sessionID = UUID().uuidString; let requestID = UUID().uuidString
        let request = VoiceSynthesisRequest(sessionID: sessionID, requestID: requestID, providerID: "hermes-edge", voiceID: "en-US-AriaNeural", text: "Hello, Benjamin.")
        let audio = try await client.synthesizeVoice(request)
        XCTAssertEqual(audio, Data([1, 2, 3]))
        XCTAssertEqual(server.requests.first?.path, "/api/omni/voice/synthesis")
        XCTAssertEqual(server.requests.first?.header("Authorization"), "Bearer \(TestTokens.device)")
        let body = try JSONDecoder().decode([String: String].self, from: server.requests[0].body)
        XCTAssertEqual(body["text"], request.text); XCTAssertEqual(body["sessionID"], sessionID)
        try await client.cancelVoiceSynthesis(sessionID: sessionID, requestID: requestID)
        XCTAssertEqual(server.requests.last?.method, "DELETE")
        XCTAssertEqual(server.requests.last?.path, "/api/omni/voice/synthesis/\(requestID)")
        XCTAssertEqual(try JSONDecoder().decode([String: String].self, from: server.requests[1].body), ["sessionID": sessionID])
    }
    func testUnsupportedAudioAndOversizedTextFailWithoutNarrationOrNetworkRetry() async throws {
        let (client, server) = try make { _ in .json(200, #"{"audio_path":"/tmp/private.mp3"}"#) }
        let request = VoiceSynthesisRequest(sessionID: UUID().uuidString, requestID: UUID().uuidString, providerID: "hermes-edge", voiceID: "en-US-AriaNeural", text: "Hello")
        do { _ = try await client.synthesizeVoice(request); XCTFail("Do not treat filesystem JSON as playable audio") } catch {}
        let tooLong = VoiceSynthesisRequest(sessionID: request.sessionID, requestID: request.requestID, providerID: request.providerID, voiceID: request.voiceID, text: String(repeating: "👋", count: 2001))
        do { _ = try await client.synthesizeVoice(tooLong); XCTFail("UTF-16 limit must reject this text") } catch {}
        XCTAssertEqual(server.requests.count, 1)
    }
    func testKokoroAcceptsOnlyWAVAndProviderContentTypesCannotCross() async throws {
        for (provider, type, succeeds) in [
            ("kokoro-local", "audio/wav; charset=binary", true),
            ("kokoro-local", "audio/mpeg", false),
            ("hermes-edge", "audio/wav", false),
            ("unknown", "audio/wav", false)
        ] {
            let (client, server) = try make { _ in
                .response(status: 200, headers: ["Content-Type": type, "Cache-Control": "no-store"], chunks: [Data([1, 2, 3])])
            }
            let request = VoiceSynthesisRequest(sessionID: UUID().uuidString, requestID: UUID().uuidString, providerID: provider, voiceID: "af_heart", text: "Hello")
            do {
                let data = try await client.synthesizeVoice(request)
                XCTAssertTrue(succeeds); XCTAssertEqual(data, Data([1, 2, 3]))
            } catch { XCTAssertFalse(succeeds) }
            XCTAssertEqual(server.requests.count, provider == "unknown" ? 0 : 1)
        }
    }
    func testKokoroRejectsEmptyAndOversizedAudio() async throws {
        for body in [Data(), Data(repeating: 0, count: 10 * 1024 * 1024 + 1)] {
            let (client, _) = try make { _ in
                .response(status: 200, headers: ["Content-Type": "audio/wav", "Cache-Control": "no-store"], chunks: [body])
            }
            let request = VoiceSynthesisRequest(sessionID: UUID().uuidString, requestID: UUID().uuidString, providerID: "kokoro-local", voiceID: "af_heart", text: "Hello")
            do { _ = try await client.synthesizeVoice(request); XCTFail("Audio must be nonempty and bounded") } catch {}
        }
    }
    func testProviderMetadataDecodesAvailabilityAndCloudDisclosure() async throws {
        let (client, _) = try make { _ in .json(200, #"{"providers":[{"id":"hermes-edge","name":"Hermes · Microsoft Edge","available":true,"cloud":true,"disclosure":"Reply text is sent to Microsoft","defaultVoiceID":"en-US-AriaNeural","voices":[{"id":"en-US-AriaNeural","name":"Aria","language":"en-US"}],"maxCharacters":4000,"maxAudioBytes":10485760}]}"#) }
        let catalog = try await client.voiceProviders()
        XCTAssertEqual(catalog.providers.first?.defaultVoiceID, "en-US-AriaNeural")
        XCTAssertEqual(catalog.providers.first?.available, true); XCTAssertEqual(catalog.providers.first?.cloud, true)
    }
}
