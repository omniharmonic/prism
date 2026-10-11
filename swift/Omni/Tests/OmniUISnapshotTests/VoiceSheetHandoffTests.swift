import OmniCore
@testable import OmniUI
import XCTest

@MainActor final class VoiceSheetHandoffTests: XCTestCase {
    private final class Audio: ConversationAudio {
        func start() async throws {}
        func finish() async throws -> String { "Synthetic first voice turn" }
        func cancel() {}
        func speak(_ text: String) {}
        func waitForPlayback() async {}
        func silence() {}
    }
    func testIPhoneSheetKeepsVoiceThreadUntilDismissAndNeverRetainsTextCreation() async {
        let service = SampleService()
        service.createdVoiceThreadID = "sheet-voice"
        service.addThread("sheet-voice", "Synthetic voice", state: "working")
        let session = SessionModel(service: service) {}
        session.requestNewVoice()
        let audio = Audio()
        let active = VoiceConversation(audio: audio)
        session.claimVoice(audio: audio, voice: active, threadID: nil)
        await active.start()
        await active.finish { await session.startVoiceThread(prompt: $0, voice: active) }
        var handoff = VoiceSheetHandoff()
        XCTAssertTrue(handoff.retain(session: session, destination: session.destination, isPresented: true))
        XCTAssertEqual(handoff.threadID, "sheet-voice")
        XCTAssertTrue(active.isSessionActive)
        XCTAssertEqual(handoff.dismissed(destination: session.destination), .thread("sheet-voice"))
        XCTAssertNil(handoff.threadID)
        XCTAssertFalse(handoff.retain(session: session, destination: session.destination, isPresented: false))
        active.cancel()
        XCTAssertFalse(handoff.retain(session: session, destination: session.destination, isPresented: true), "Text creation or an ended voice session follows normal navigation")
        session.stop()
    }
    func testIPhoneSheetDismissCannotOverwriteInterveningNavigation() async {
        let service = SampleService()
        service.createdVoiceThreadID = "sheet-voice"
        service.addThread("sheet-voice", "Synthetic voice", state: "working")
        let session = SessionModel(service: service) {}
        session.requestNewVoice()
        let audio = Audio()
        let active = VoiceConversation(audio: audio)
        session.claimVoice(audio: audio, voice: active, threadID: nil)
        await active.start()
        await active.finish { await session.startVoiceThread(prompt: $0, voice: active) }
        var handoff = VoiceSheetHandoff()
        XCTAssertTrue(handoff.retain(session: session, destination: session.destination, isPresented: true))
        XCTAssertFalse(handoff.retain(session: session, destination: .thread("unrelated"), isPresented: true))
        XCTAssertNil(handoff.dismissed(destination: .thread("unrelated")))
        XCTAssertNil(handoff.threadID)
        session.stop()
    }
}
