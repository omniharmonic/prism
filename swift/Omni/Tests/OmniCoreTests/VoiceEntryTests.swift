import XCTest
import PrismTransport
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

    func testEveryCompletedTurnPreservesAnAtomicVoiceReceiptIncludingEmptyReply() async {
        let service = FakeService(); let session = SessionModel(service: service, sleep: noSleep) {}
        service.details(.success(Fixture.detail(lastSeq: 0)))
        service.starts(.success(.started(turnId: "one")), .success(.started(turnId: "two")))
        service.streams(
            [.success(Fixture.event(1, turn: "one", .text(blockId: "a", text: "First."))), .success(Fixture.event(2, turn: "one", .result(ok: true, durationMs: 1, errorCode: nil)))],
            [.success(Fixture.event(3, turn: "two", .result(ok: true, durationMs: 1, errorCode: nil)))]
        )
        let model = session.threadModel(for: "t1"); await model.open()
        model.draft = "one"; let first = await model.send(); XCTAssertTrue(first)
        await eventually { model.completedVoiceTurnID == "one" }
        XCTAssertFalse(model.takeCompletedVoiceTimeline().isEmpty)
        XCTAssertNil(model.completedVoiceTurnID)
        model.draft = "two"; let second = await model.send(); XCTAssertTrue(second)
        await eventually { model.completedVoiceTurnID == "two" }
        XCTAssertTrue(model.takeCompletedVoiceTimeline().isEmpty)
        XCTAssertNil(model.completedVoiceTurnID); model.close()
    }
    func testVoiceSendAcceptanceDoesNotConfuseAlreadyRunningOrRejectedWithSent() async {
        for rejected in [false, true] {
            let service = FakeService(); let session = SessionModel(service: service, sleep: noSleep) {}
            service.details(.success(Fixture.detail()))
            if rejected { service.starts(.failure(PrismError.rejected(Fixture.failure(400, "hermes_rejected")))) }
            else { service.starts(.success(.alreadyRunning(turnId: "old"))); _ = service.manualStream() }
            let model = session.threadModel(for: "t1"); await model.open()
            model.draft = "new words"
            let accepted = await model.send()
            XCTAssertFalse(accepted); XCTAssertEqual(model.draft, "new words")
            model.close()
        }
    }

    func testRetainedPanelBindingAdoptsFirstCreatedVoiceAndCannotStealCompletion() async {
        let service = FakeService(); let session = SessionModel(service: service, sleep: noSleep) {}
        // This binding represents State already initialized before the first creation.
        let staleAudio = VoiceConversationTests.Audio()
        let staleVoice = VoiceConversation(audio: staleAudio)
        let retainedPanel = VoiceControlBinding(audio: staleAudio, voice: staleVoice)
        let audio = VoiceConversationTests.Audio(); audio.holdPlayback = true
        let voice = VoiceConversation(audio: audio)
        session.requestNewVoice()
        XCTAssertTrue(session.claimVoice(audio: audio, voice: voice, threadID: nil))
        await voice.start()
        service.created(.success(Fixture.decode(["thread": Fixture.threadJSON("t1", state: "done"), "turnId": "turn1"])))
        await voice.finish { await session.startVoiceThread(prompt: $0, voice: voice) }
        service.details(.success(Fixture.detail(lastSeq: 2)))
        service.streams([.success(Fixture.event(1, turn: "turn1", .text(blockId: "answer", text: "First answer."))), .success(Fixture.event(2, turn: "turn1", .result(ok: true, durationMs: 1, errorCode: nil)))])
        let model = session.threadModel(for: "t1"); await model.open()
        await eventually { model.completedVoiceTurnID == "turn1" }
        // An unadopted control may observe completion first. The receipt stays intact.
        retainedPanel.consume(session: session, model: model)
        XCTAssertEqual(model.completedVoiceTurnID, "turn1")
        XCTAssertTrue(staleAudio.speech.isEmpty)
        XCTAssertTrue(retainedPanel.reconcile(session: session, threadID: "t1"))
        XCTAssertTrue(retainedPanel.voice === voice)
        XCTAssertTrue(retainedPanel.audio === audio)
        voice.canAutomaticallyListen = { session.ownsVoice(retainedPanel.voice, threadID: model.threadID) && !model.isRunning }
        retainedPanel.consume(session: session, model: model)
        XCTAssertNil(model.completedVoiceTurnID)
        XCTAssertEqual(audio.speech, ["First answer."])
        await eventually { audio.playbackGate != nil }
        XCTAssertEqual(voice.state, .speaking)
        XCTAssertEqual(audio.starts, 1)
        retainedPanel.consume(session: session, model: model)
        XCTAssertEqual(audio.speech, ["First answer."], "Repeated observation must not replay the receipt")
        audio.holdPlayback = false; audio.playbackGate?.resume(); audio.playbackGate = nil
        await eventually { voice.state == .listening }
        XCTAssertEqual(audio.starts, 2)
        XCTAssertEqual(staleAudio.starts, 0)
        session.cancelVoice(voice, threadID: "t1")
        XCTAssertEqual(voice.state, .off)
        XCTAssertFalse(retainedPanel.reconcile(session: session, threadID: "t1"))
        XCTAssertEqual(voice.state, .off, "Reconciliation cannot restart an ended session")
        model.close(); session.stop()
    }

}
