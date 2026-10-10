import XCTest
@testable import OmniCore

@MainActor final class VoiceDraftContinuationTests: XCTestCase {
    func testSpokenPauseResumeAndSendPreservesPrefixExactlyOnceAcrossCycles() async {
        let audio = VoiceConversationTests.Audio(); let voice = VoiceConversation(audio: audio)
        var draft = ""
        var submitted: [String] = []
        XCTAssertFalse(voice.canStart(withDraft: "Unrelated typed draft"))
        audio.recognized = "First words"
        await voice.start()
        await voice.finish(submit: false, draftReason: .pause) { _ in
            draft = voice.draftAfterCapture(preserving: draft); return true
        }
        XCTAssertEqual(draft, "First words")
        XCTAssertTrue(voice.canStart(withDraft: draft), "The production Resume eligibility must permit the draft Pause just saved")
        await voice.start(continuingDraft: draft)
        XCTAssertEqual(draft, "First words", "Resume must not clear the composer")
        audio.recognized = "More words"
        await voice.finish(submit: false, draftReason: .pause) { _ in
            draft = voice.draftAfterCapture(preserving: draft); return true
        }
        XCTAssertEqual(draft, "First words More words")
        await voice.start(continuingDraft: draft)
        audio.recognized = "Final words"
        await voice.finish { _ in
            let text = voice.draftAfterCapture(preserving: draft)
            submitted.append(text); draft = ""; return true
        }
        XCTAssertEqual(submitted, ["First words More words Final words"])
        XCTAssertEqual(voice.state, .answering)
        voice.cancel()
    }
    func testEmptyPauseCanResumeAndAnEmptyResumedCaptureKeepsExistingDraft() async {
        let audio = VoiceConversationTests.Audio(); let voice = VoiceConversation(audio: audio)
        audio.recognized = ""
        await voice.start()
        await voice.finish(submit: false, draftReason: .pause) { _ in XCTFail("Empty Pause must not create a draft"); return false }
        XCTAssertTrue(voice.canStart(withDraft: ""))
        XCTAssertNil(voice.problem)
        await voice.start(continuingDraft: "Saved words")
        var draft = "Saved words"
        await voice.finish(submit: false, draftReason: .pause) { _ in
            draft = voice.draftAfterCapture(preserving: draft); return true
        }
        XCTAssertEqual(draft, "Saved words")
        XCTAssertEqual(voice.state, .paused)
        voice.cancel()
    }
    func testEditsWhilePausedAndDuringResumedCaptureArePreserved() async {
        let audio = VoiceConversationTests.Audio(); let voice = VoiceConversation(audio: audio)
        await voice.start(); voice.pause()
        var draft = "Edited before Resume"
        await voice.start(continuingDraft: draft)
        draft = "Edited while listening"
        audio.recognized = "additional spoken words"
        await voice.finish(submit: false, draftReason: .pause) { _ in
            draft = voice.draftAfterCapture(preserving: draft); return true
        }
        XCTAssertEqual(draft, "Edited while listening additional spoken words")
        XCTAssertFalse(draft.contains("Edited before Resume"))
        voice.cancel()
    }
    func testResumePreparationFailureAndCancellationKeepUnsentWords() async {
        let audio = VoiceConversationTests.Audio(); let voice = VoiceConversation(audio: audio)
        audio.failStart = true
        let draft = "Words already saved"
        await voice.start(continuingDraft: draft)
        XCTAssertEqual(voice.state, .paused)
        XCTAssertEqual(voice.transcript, draft)
        XCTAssertTrue(voice.canStart(withDraft: draft))
        voice.cancel()
        XCTAssertEqual(draft, "Words already saved")
        XCTAssertFalse(voice.canStart(withDraft: draft), "End must not let an unrelated new voice launch overwrite a composer draft")
    }
}
