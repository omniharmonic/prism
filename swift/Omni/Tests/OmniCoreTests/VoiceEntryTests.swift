import XCTest
@testable import OmniCore

@MainActor final class VoiceEntryTests: XCTestCase {
    func testOpeningVoiceDoesNotRecordOrCreateAndTextEntryResetsIt() {
        let service = FakeService(); let session = SessionModel(service: service, sleep: noSleep) {}
        let audio = VoiceConversationTests.Audio(); let voice = VoiceConversation(audio: audio)
        session.conversationAudio = audio; session.conversationVoice = voice
        session.requestNewVoice()
        XCTAssertEqual(session.destination, .newThread)
        XCTAssertTrue(session.newThreadUsesVoice)
        XCTAssertEqual(audio.starts, 0); XCTAssertEqual(service.createdPrompts, [])
        session.requestNewThread(); XCTAssertFalse(session.newThreadUsesVoice)
    }
    func testFirstVoiceSendKeepsControllerAndBindsOnlyCreatedThreadThenSessionStopCancels() async {
        let service = FakeService(); let session = SessionModel(service: service, sleep: noSleep) {}
        let audio = VoiceConversationTests.Audio(); let voice = VoiceConversation(audio: audio)
        session.conversationAudio = audio; session.conversationVoice = voice
        session.requestNewVoice(); await voice.start()
        service.created(.success(Fixture.decode(["thread": Fixture.threadJSON("voice-new", state: "working"), "turnId": "turn1"])))
        await voice.finish { text in await session.startVoiceThread(prompt: text, voice: voice) }
        XCTAssertEqual(service.createdPrompts, ["What is next?"])
        XCTAssertEqual(service.createdSources, ["voice"])
        XCTAssertEqual(session.destination, .thread("voice-new")); XCTAssertEqual(session.voiceThreadID, "voice-new")
        XCTAssertFalse(session.newThreadUsesVoice); XCTAssertTrue(session.conversationVoice === voice)
        XCTAssertEqual(voice.state, .answering)
        XCTAssertFalse(session.cancelVoice(voice, threadID: nil), "The old new-voice view cannot cancel its transferred controller")
        XCTAssertEqual(voice.state, .answering)
        XCTAssertTrue(session.ownsVoice(voice, threadID: "voice-new"))
        XCTAssertFalse(session.ownsVoice(voice, threadID: "unrelated"))
        session.showVoice(in: "another")
        XCTAssertEqual(voice.state, .off); XCTAssertEqual(session.voiceThreadID, "another")
        session.stop(); XCTAssertNil(session.conversationVoice); XCTAssertNil(session.conversationAudio)
    }
    func testLockedOrCancelledPreparationCannotCreateVoiceThread() async {
        let service = FakeService(); let session = SessionModel(service: service, sleep: noSleep) {}
        let audio = VoiceConversationTests.Audio(); let voice = VoiceConversation(audio: audio)
        session.conversationAudio = audio; session.conversationVoice = voice
        session.requestNewVoice(); voice.setPrivacyLocked(true); await voice.start()
        await voice.finish { text in await session.startVoiceThread(prompt: text, voice: voice) }
        XCTAssertEqual(audio.starts, 0); XCTAssertEqual(service.createdPrompts, [])
        XCTAssertNil(session.voiceThreadID)
    }
    func testFinishedCreatedTurnReplaysOnceWithoutGenericHistory() async {
        let service = FakeService(); let session = SessionModel(service: service, sleep: noSleep) {}
        let audio = VoiceConversationTests.Audio(); let voice = VoiceConversation(audio: audio)
        session.requestNewVoice(); session.claimVoice(audio: audio, voice: voice, threadID: nil)
        service.created(.success(Fixture.decode(["thread": Fixture.threadJSON("t1", state: "done"), "turnId": "turn1"])))
        await voice.start()
        await voice.finish { await session.startVoiceThread(prompt: $0, voice: voice) }
        service.details(.success(Fixture.detail(lastSeq: 3)), .success(Fixture.detail(lastSeq: 3)))
        service.streams([.success(Fixture.event(1, turn: "older", .text(blockId: "old", text: "Never read old history."))), .success(Fixture.event(2, turn: "turn1", .text(blockId: "answer", text: "First answer."))), .success(Fixture.event(3, turn: "turn1", .result(ok: true, durationMs: 1, errorCode: nil)))])
        let model = session.threadModel(for: "t1")
        await model.open()
        await eventually { !model.completedVoiceTimeline.isEmpty }
        voice.consume(model.takeCompletedVoiceTimeline(), running: false)
        XCTAssertEqual(audio.speech, ["First answer."])
        voice.cancel(); await voice.start(); await voice.finish { _ in true }
        voice.consume(model.takeCompletedVoiceTimeline(), running: false)
        XCTAssertEqual(audio.speech, ["First answer."], "Second voice turn cannot replay the first reply")
        model.close()
    }

    func testLateCreationCannotTakeOverCancelledOrNewVoiceEntry() async {
        let service = FakeService(); let session = SessionModel(service: service, sleep: noSleep) {}
        let audio = VoiceConversationTests.Audio(); let voice = VoiceConversation(audio: audio)
        session.requestNewVoice(); session.claimVoice(audio: audio, voice: voice, threadID: nil)
        actor Gate { var continuation: CheckedContinuation<Void, Never>?; var waiting = false
            func wait() async { waiting = true; await withCheckedContinuation { continuation = $0 } }
            func release() { continuation?.resume() }
        }
        let gate = Gate(); service.createGate = { await gate.wait() }
        service.created(.success(Fixture.decode(["thread": Fixture.threadJSON("late"), "turnId": "turn1"])))
        let task = Task { await session.startVoiceThread(prompt: "Hello", voice: voice) }
        while !(await gate.waiting) { await Task.yield() }
        session.closeNewVoice(); session.requestNewVoice()
        await gate.release()
        let handedOff = await task.value
        XCTAssertFalse(handedOff); XCTAssertEqual(session.destination, .newThread)
        XCTAssertNil(session.voiceThreadID); XCTAssertTrue(session.newThreadUsesVoice)
    }

    func testTextEntryAndCloseCancelActiveCaptureBeforeDroppingOwnership() async {
        let session = SessionModel(service: FakeService(), sleep: noSleep) {}
        let audio = VoiceConversationTests.Audio(); let voice = VoiceConversation(audio: audio)
        session.requestNewVoice(); session.claimVoice(audio: audio, voice: voice, threadID: nil)
        await voice.start(); XCTAssertEqual(voice.state, .listening)
        session.requestNewThread(); XCTAssertEqual(voice.state, .off)
        session.requestNewVoice(); session.claimVoice(audio: audio, voice: voice, threadID: nil)
        await voice.start(); session.closeNewVoice(); XCTAssertEqual(voice.state, .off)
    }

}
