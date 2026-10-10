import XCTest
import OmniClient
@testable import OmniCore

@MainActor final class ReplySpeechProviderTests: XCTestCase {
    actor Service: HermesSpeechService {
        var requests: [VoiceSynthesisRequest] = []
        var cancelled: [(String, String)] = []
        var gate: CheckedContinuation<Data, Error>?
        var hold = false
        func voiceProviders() async throws -> VoiceProviderCatalog { throw CancellationError() }
        func synthesizeVoice(_ request: VoiceSynthesisRequest) async throws -> Data {
            requests.append(request)
            if hold { return try await withCheckedThrowingContinuation { gate = $0 } }
            return Data([1, 2, 3])
        }
        func cancelVoiceSynthesis(sessionID: String, requestID: String) async throws {
            cancelled.append((sessionID, requestID)); gate?.resume(throwing: CancellationError()); gate = nil
        }
        func setHold() { hold = true }
        func waiting() -> Bool { gate != nil }
    }
    func testProviderUsesExactTextAndSessionWithoutPrivateFilePaths() async throws {
        let service = Service(); let sessionID = UUID().uuidString
        let provider = HermesEdgeReplySpeechProvider(service: service, sessionID: sessionID, voiceID: "en-US-AriaNeural")
        let result = try await provider.render("Hello, Benjamin. The estimate is $3.14.")
        if case .encodedAudio(let data) = result { XCTAssertEqual(data, Data([1, 2, 3])) } else { XCTFail("Expected generated audio") }
        let request = await service.requests.first!
        XCTAssertEqual(request.text, "Hello, Benjamin. The estimate is $3.14.")
        XCTAssertEqual(request.sessionID, sessionID); XCTAssertNotNil(UUID(uuidString: request.requestID))
        XCTAssertEqual(request.providerID, "hermes-edge"); XCTAssertEqual(request.voiceID, "en-US-AriaNeural")
    }
    func testCancellationCancelsExactRemoteRequestAndCannotDeliverAudio() async {
        let service = Service(); await service.setHold()
        let sessionID = UUID().uuidString
        let provider = HermesEdgeReplySpeechProvider(service: service, sessionID: sessionID, voiceID: "en-US-AriaNeural")
        let task = Task { try await provider.render("A pending reply.") }
        for _ in 0..<1000 { if await service.waiting() { break }; await Task.yield() }
        let waiting = await service.waiting(); XCTAssertTrue(waiting)
        task.cancel()
        do { _ = try await task.value; XCTFail("Cancelled speech must not return audio") } catch {}
        let requests = await service.requests; let cancelled = await service.cancelled
        XCTAssertEqual(cancelled.count, 1); XCTAssertEqual(cancelled.first?.0, sessionID)
        XCTAssertEqual(cancelled.first?.1, requests.first?.requestID)
    }
    func testBoundedPassagesPreserveAllUnicodeAndPunctuationExactly() {
        let text = String(repeating: "Benjamin, is $3.14 correct? 👨‍👩‍👧‍👦 Take your time.\n", count: 200)
        let chunks = ReplySpeechPassages.split(text)
        XCTAssertGreaterThan(chunks.count, 1)
        XCTAssertEqual(chunks.joined(), text)
        XCTAssertTrue(chunks.allSatisfy { !$0.isEmpty && $0.utf16.count <= 4000 })
        XCTAssertEqual(ReplySpeechPassages.split("short"), ["short"])
    }
    func testMigrationPrefersHermesButPreservesExplicitAppleAndDownloadedVoice() {
        let name = "ReplySpeechPreferencesTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        defaults.set("downloaded-premium", forKey: "omni.speech.voice")
        let preferences = ReplySpeechPreferences(defaults: defaults)
        XCTAssertEqual(preferences.provider, .hermesEdge)
        preferences.provider = .apple
        XCTAssertEqual(ReplySpeechPreferences(defaults: defaults).provider, .apple)
        XCTAssertEqual(defaults.string(forKey: "omni.speech.voice"), "downloaded-premium")
        preferences.edgeVoiceID = "en-US-AriaNeural"
        XCTAssertEqual(ReplySpeechPreferences(defaults: defaults).edgeVoiceID, "en-US-AriaNeural")
    }
}
