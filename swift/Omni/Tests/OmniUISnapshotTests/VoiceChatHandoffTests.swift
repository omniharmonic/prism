import OmniCore
@testable import OmniUI
import XCTest

@MainActor final class VoiceChatHandoffTests: XCTestCase {
    private final class Audio: ConversationAudio {
        var starts = 0
        func start() async throws { starts += 1 }
        func finish() async throws -> String { "Synthetic first voice turn" }
        func cancel() {}
        func speak(_ text: String) {}
        func waitForPlayback() async {}
        func silence() {}
    }
    func testMainChatResolvesCreationBeforeObserverWithoutRestartAndRetainsAfterEnd() async {
        let service = SampleService()
        service.createdVoiceThreadID = "main-voice"
        service.addThread("main-voice", "Synthetic voice", state: "working")
        let session = SessionModel(service: service) {}
        defer { session.stop() }
        session.requestNewVoice()
        let audio = Audio()
        let active = VoiceConversation(audio: audio)
        // The policy does not touch either audio adapter or the retained controller.
        session.claimVoice(audio: audio, voice: active, threadID: nil)
        await active.start()
        var handoff = VoiceChatHandoff()
        handoff.begin()
        XCTAssertNil(handoff.contentThreadID(session: session))
        XCTAssertEqual(handoff.destination(for: .newThread, session: session), .newThread)
        await active.finish { await session.startVoiceThread(prompt: $0, voice: active) }
        XCTAssertEqual(handoff.contentThreadID(session: session), "main-voice")
        XCTAssertNil(handoff.threadID, "The creation render resolves without observer mutation")
        XCTAssertEqual(handoff.destination(for: .newThread, session: session), .thread("main-voice"))
        XCTAssertTrue(handoff.adopt(session: session))
        XCTAssertTrue(active.isSessionActive)
        XCTAssertEqual(audio.starts, 1, "Navigation cannot restart capture")
        active.cancel()
        XCTAssertEqual(handoff.contentThreadID(session: session), "main-voice", "End stays in the actual chat")
        XCTAssertEqual(handoff.destination(for: nil, session: session), nil, "Back returns to the Threads list")
        handoff.reset()
        XCTAssertNil(handoff.contentThreadID(session: session))
        XCTAssertFalse(handoff.isPresented)
    }
    func testExternalNavigationAndFreshVoiceCannotReusePreviousThread() async {
        let service = SampleService()
        service.createdVoiceThreadID = "main-voice"
        service.addThread("main-voice", "Synthetic voice", state: "working")
        let session = SessionModel(service: service) {}
        defer { session.stop() }
        session.requestNewVoice()
        let audio = Audio()
        let active = VoiceConversation(audio: audio)
        session.claimVoice(audio: audio, voice: active, threadID: nil)
        await active.start()
        var handoff = VoiceChatHandoff(); handoff.begin()
        await active.finish { await session.startVoiceThread(prompt: $0, voice: active) }
        XCTAssertTrue(handoff.adopt(session: session))
        session.openExternal(.thread("main-voice"))
        XCTAssertTrue(handoff.keepsEntry(for: .thread("main-voice"), session: session), "A same-chat notification preserves the mounted voice owner")
        XCTAssertEqual(audio.starts, 1)
        session.openExternal(.thread("unrelated"))
        XCTAssertNil(handoff.contentThreadID(session: session), "External navigation cannot render a retained old chat before its observer resets")
        XCTAssertFalse(handoff.adopt(session: session))
        handoff.reset() // The production external-navigation observer resets before opening.
        XCTAssertEqual(handoff.destination(for: .thread("unrelated"), session: session), .thread("unrelated"))
        XCTAssertNil(handoff.contentThreadID(session: session))
        active.cancel()
        handoff.begin()
        session.requestNewVoice(); handoff.begin()
        XCTAssertNil(handoff.contentThreadID(session: session))
        XCTAssertEqual(handoff.destination(for: .newThread, session: session), .newThread)
        handoff.reset(); session.requestNewThread()
        XCTAssertFalse(handoff.isPresented, "Text composition uses its ordinary sheet")
    }
}
