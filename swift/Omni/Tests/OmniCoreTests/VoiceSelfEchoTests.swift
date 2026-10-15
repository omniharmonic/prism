import Foundation
import XCTest
@testable import OmniCore

/// The matcher, with echoes garbled the way on-device recognition garbles echo-cancelled
/// residue, and with genuine owner interruptions that reuse Omni's words.
final class VoiceSelfEchoMatcherTests: XCTestCase {
    private let reply = "I've drafted the email to Sarah about Thursday's budget review. It says the meeting moves to 3 PM in the small conference room. Should I send it to Sarah now, or would you like to change anything first?"

    func testGarbledEchoesAreRecognised() {
        let echoes = [
            "I've drafted the email to Sarah about Thursday's budget review",          // clean
            "i drafted the email to sara about thursdays budget review",               // dropped contraction, misspelt name
            "the meeting moves to three p m in the small conference room",              // number spoken as a word, split PM
            "it says the meeting moved to 3 in the small conference",                  // inflection, dropped words
            "should i send it to sarah now or would you like to change",               // cut off mid-sentence
            "drafted the e-mail to Sarah about the Thursday budget",                    // hyphenation, inserted article
            "meeting moves two three PM in this small conference room",                // substitution errors
            "Should I send it to Sarah? Now, or would you like…",                       // punctuation and ellipsis
        ]
        for echo in echoes {
            XCTAssertTrue(VoiceSelfEcho.isLikelyEcho(echo, of: reply), "Echo not recognised: \(echo)")
        }
    }

    func testGenuineInterruptionsAreKept() {
        let owner = [
            "stop",
            "wait",
            "no",
            "wait, actually send it to Sarah",                 // cue words plus Omni's phrase
            "stop reading the email to Sarah",                 // cue word, mostly Omni's words
            "actually send it to Sarah now",                   // starts with a cue the echo cannot contain
            "send it to Tom instead and copy Priya",
            "move the meeting to four and book the big room",
            "yes send it",
            "send it",                                         // short repeats are left to the loop breaker
            "to Sarah",
            "can you add the agenda from last week before sending",
            "hold on I need to check the budget numbers first",
        ]
        for words in owner {
            XCTAssertFalse(VoiceSelfEcho.isLikelyEcho(words, of: reply), "Owner speech discarded: \(words)")
        }
    }

    func testEchoFollowedByOwnerSpeechIsKept() {
        // One second of retained lead-in caught Omni, then the owner kept talking.
        XCTAssertFalse(VoiceSelfEcho.isLikelyEcho("should I send it to Sarah please change the subject line to budget update and attach the spreadsheet", of: reply))
    }

    func testThresholdBoundary() {
        // 7 of 10 words align: an echo. 6 of 10 do not.
        let reference = "alpha bravo charlie delta echo foxtrot golf hotel india juliet"
        XCTAssertTrue(VoiceSelfEcho.isLikelyEcho("alpha bravo charlie delta echo foxtrot golf kilo lima mike", of: reference))
        XCTAssertFalse(VoiceSelfEcho.isLikelyEcho("alpha bravo charlie delta echo foxtrot kilo lima mike november", of: reference))
    }

    func testNoReferenceOrShortTranscriptIsNeverEcho() {
        XCTAssertFalse(VoiceSelfEcho.isLikelyEcho("the meeting moves to three", of: ""))
        XCTAssertFalse(VoiceSelfEcho.isLikelyEcho("", of: reply))
        XCTAssertFalse(VoiceSelfEcho.isLikelyEcho("conference room", of: reply))
    }

    func testOrderMatters() {
        // The same words out of order are not a playback echo.
        XCTAssertFalse(VoiceSelfEcho.isLikelyEcho("room conference small the in PM 3 to moves meeting", of: reply))
    }

    func testNormalisationAndSimilarity() {
        XCTAssertEqual(VoiceSelfEcho.words("I've got FIVE e-mails, café!"), ["ive", "got", "5", "e", "mails", "cafe"])
        XCTAssertTrue(VoiceSelfEcho.similar("sarah", "sara"))
        XCTAssertTrue(VoiceSelfEcho.similar("moves", "moved"))
        XCTAssertTrue(VoiceSelfEcho.similar("conference", "conferance"))
        XCTAssertFalse(VoiceSelfEcho.similar("to", "too"))
        XCTAssertFalse(VoiceSelfEcho.similar("tom", "ton"))
        XCTAssertFalse(VoiceSelfEcho.similar("sarah", "priya"))
    }

    func testLongInputsStayBounded() {
        let long = Array(repeating: reply, count: 50).joined(separator: " ")
        let started = Date()
        XCTAssertTrue(VoiceSelfEcho.isLikelyEcho(long, of: long))
        XCTAssertLessThan(Date().timeIntervalSince(started), 2)
    }
}

final class VoiceSelfHearingBreakerTests: XCTestCase {
    func testTwoConsecutivePlaybackAdjacentTurnsHoldTheSecond() {
        var breaker = VoiceSelfHearingBreaker()
        XCTAssertFalse(breaker.automaticTurn(playbackAdjacent: true))
        XCTAssertTrue(breaker.automaticTurn(playbackAdjacent: true))
        XCTAssertEqual(breaker.consecutive, 0, "Holding starts a new count")
    }
    func testFreshOwnerSpeechOrTapResetsTheCount() {
        var breaker = VoiceSelfHearingBreaker()
        XCTAssertFalse(breaker.automaticTurn(playbackAdjacent: true))
        XCTAssertFalse(breaker.automaticTurn(playbackAdjacent: false))
        XCTAssertFalse(breaker.automaticTurn(playbackAdjacent: true))
        breaker.ownerActed()
        XCTAssertFalse(breaker.automaticTurn(playbackAdjacent: true))
        XCTAssertTrue(breaker.automaticTurn(playbackAdjacent: true))
    }
}

/// The conversation: echo discards, real interruptions, and the loop breaker.
@MainActor final class VoiceSelfEchoConversationTests: XCTestCase {
    final class Audio: ConversationAudio {
        var activity: (@MainActor (VoiceActivityEvent) -> Void)?
        var interruption: (@MainActor (VoiceInterruptionEvent) -> Void)?
        var starts = 0
        var recognized = ""
        var spokenText: [String] = []
        func configureActivity(enabled: Bool, receive: @escaping @MainActor (VoiceActivityEvent) -> Void) { activity = receive }
        func configureInterruption(enabled: Bool, receive: @escaping @MainActor (VoiceInterruptionEvent) -> Void) { interruption = enabled ? receive : nil }
        func start() async throws { starts += 1 }
        func finish() async throws -> String { recognized }
        func cancel() {}
        func speak(_ text: String) { spokenText.append(text) }
        func waitForPlayback() async {}
        func silence() {}
    }

    private let reply = "I've drafted the email to Sarah about Thursday's budget review. Should I send it to Sarah now?"
    private var audioTime = 0.0

    private func makeVoice(_ audio: Audio) -> VoiceConversation {
        let voice = VoiceConversation(audio: audio)
        voice.acousticInterruptionEnabled = true
        voice.configureEndpoint(mode: .automatic, pauseSeconds: 2)
        voice.canAutomaticallyListen = { true }
        return voice
    }
    /// Fresh detector frames, then the 2 s pause and 3 s countdown that end the turn.
    private func speakThenWait(_ voice: VoiceConversation, _ audio: Audio, speechFrames: Int) {
        for index in 0..<(speechFrames + 22) {
            audioTime += 0.256
            audio.activity?(.frame(VoiceActivityFrame(audioTime: audioTime, capturedAt: ProcessInfo.processInfo.systemUptime, duration: 0.256, isSpeech: index < speechFrames)))
        }
    }
    /// First owner turn (a tap) and Omni's reply playing.
    private func ownerTurnThenReply(_ voice: VoiceConversation, _ audio: Audio, sent: inout [String], replyID: String) async {
        audio.recognized = "Draft the email to Sarah"
        if voice.state == .listening { await voice.finish { sent.append($0); return true } }
        voice.consume([.streamingText(id: replyID, text: reply, isFinal: true)], running: false)
        XCTAssertEqual(voice.state, .answering)
    }
    private func interrupt(_ audio: Audio) {
        let now = ProcessInfo.processInfo.systemUptime
        audio.interruption?(.speechEvidence(VoiceActivityFrame(audioTime: audioTime, capturedAt: now, duration: 0.256, isSpeech: true)))
    }
    /// Runs the endpoint to its automatic send, as the UI does.
    private func automaticTurn(_ voice: VoiceConversation, _ audio: Audio, recognized: String, sent: inout [String]) async {
        var requested = 0
        voice.automaticFinish = { requested += 1 }
        speakThenWait(voice, audio, speechFrames: 3)
        XCTAssertEqual(requested, 1, "The endpoint should request an automatic send")
        audio.recognized = recognized
        await voice.finish { sent.append($0); return true }
    }

    func testEchoDuringPlaybackIsDiscardedAndListeningResumes() async {
        let audio = Audio(); let voice = makeVoice(audio)
        var sent: [String] = []
        await voice.start()
        await ownerTurnThenReply(voice, audio, sent: &sent, replyID: "r1")
        interrupt(audio)
        XCTAssertEqual(voice.state, .listening)
        await automaticTurn(voice, audio, recognized: "i drafted the email to sara about thursdays budget", sent: &sent)
        XCTAssertEqual(sent, ["Draft the email to Sarah"], "Omni's own words must not be sent as the owner")
        XCTAssertEqual(voice.state, .listening)
        XCTAssertEqual(voice.transcript, "")
        XCTAssertEqual(voice.captureNotice, "Ignored audio that matched Omni's reply. Still listening.")
        XCTAssertFalse(voice.isPausedForSelfHearing)
        voice.cancel()
    }

    func testEchoDiscardWaitsForTapWhenListeningIsNotAllowed() async {
        let audio = Audio(); let voice = makeVoice(audio)
        var sent: [String] = []
        await voice.start()
        await ownerTurnThenReply(voice, audio, sent: &sent, replyID: "r1")
        voice.canAutomaticallyListen = { false }
        interrupt(audio)
        await automaticTurn(voice, audio, recognized: "should I send it to Sarah now", sent: &sent)
        XCTAssertEqual(sent.count, 1)
        XCTAssertEqual(voice.state, .paused)
        XCTAssertEqual(voice.captureNotice, "Ignored audio that matched Omni's reply. Resume when you're ready.")
        voice.cancel()
    }

    func testGenuineInterruptionIsSent() async {
        let audio = Audio(); let voice = makeVoice(audio)
        var sent: [String] = []
        await voice.start()
        await ownerTurnThenReply(voice, audio, sent: &sent, replyID: "r1")
        interrupt(audio)
        await automaticTurn(voice, audio, recognized: "wait, actually send it to Sarah", sent: &sent)
        XCTAssertEqual(sent, ["Draft the email to Sarah", "wait, actually send it to Sarah"])
        XCTAssertEqual(voice.state, .answering)
        voice.cancel()
    }

    func testManualSendIsNeverCheckedForEcho() async {
        let audio = Audio(); let voice = makeVoice(audio)
        var sent: [String] = []
        await voice.start()
        await ownerTurnThenReply(voice, audio, sent: &sent, replyID: "r1")
        interrupt(audio)
        audio.recognized = "should I send it to Sarah now"
        await voice.finish { sent.append($0); return true }   // Send turn tapped
        XCTAssertEqual(sent.last, "should I send it to Sarah now")
        voice.cancel()
    }

    func testTwoConsecutivePlaybackAdjacentTurnsPauseVoice() async {
        let audio = Audio(); let voice = makeVoice(audio)
        var sent: [String] = []
        var drafts: [String] = []
        voice.saveRecoveredDraft = { drafts.append($0) }
        await voice.start()
        await ownerTurnThenReply(voice, audio, sent: &sent, replyID: "r1")
        // Short echoes slip past the text match ("send it"); each comes during playback.
        interrupt(audio)
        await automaticTurn(voice, audio, recognized: "send it", sent: &sent)
        XCTAssertEqual(sent.count, 2)
        XCTAssertEqual(voice.state, .answering)
        voice.consume([.streamingText(id: "r2", text: "Sending it now. Anything else?", isFinal: true)], running: false)
        interrupt(audio)
        await automaticTurn(voice, audio, recognized: "anything else", sent: &sent)
        XCTAssertEqual(sent.count, 2, "The second self-heard turn is held, not sent")
        XCTAssertEqual(voice.state, .paused)
        XCTAssertTrue(voice.isPausedForSelfHearing)
        XCTAssertEqual(voice.problem, VoiceConversation.selfHearingNotice)
        XCTAssertEqual(drafts, ["anything else"], "The held words stay available as an unsent draft")
        let startsBeforeTap = audio.starts
        // Nothing restarts listening on its own; Resume is required and clears the pause.
        await voice.start()
        XCTAssertEqual(audio.starts, startsBeforeTap + 1)
        XCTAssertFalse(voice.isPausedForSelfHearing)
        XCTAssertNil(voice.problem)
        voice.cancel()
    }

    func testSpeechAfterPlaybackWindowIsFreshAndResetsTheLoopCount() async {
        let audio = Audio(); let voice = makeVoice(audio)
        var sent: [String] = []
        await voice.start()
        await ownerTurnThenReply(voice, audio, sent: &sent, replyID: "r1")
        interrupt(audio)
        await automaticTurn(voice, audio, recognized: "send it", sent: &sent)   // adjacent: count 1
        XCTAssertEqual(sent.count, 2)
        // Playback drains; the owner speaks well after the echo window.
        voice.uptime = { ProcessInfo.processInfo.systemUptime - 10 }
        voice.agentDidComplete([.streamingText(id: "r2", text: "Sending it now. Anything else?", isFinal: true)])
        await waitForState(voice, .listening)
        voice.uptime = { ProcessInfo.processInfo.systemUptime }
        await automaticTurn(voice, audio, recognized: "anything else", sent: &sent)
        XCTAssertEqual(sent.count, 3, "Fresh owner speech is sent even if it repeats Omni's words")
        // Count was reset: one more adjacent turn is still allowed.
        voice.consume([.streamingText(id: "r3", text: "Done. Anything more?", isFinal: true)], running: false)
        interrupt(audio)
        await automaticTurn(voice, audio, recognized: "yes one more", sent: &sent)
        XCTAssertEqual(sent.count, 4)
        XCTAssertFalse(voice.isPausedForSelfHearing)
        voice.cancel()
    }

    func testEchoRightAfterPlaybackEndsIsDiscarded() async {
        let audio = Audio(); let voice = makeVoice(audio)
        var sent: [String] = []
        await voice.start()
        await ownerTurnThenReply(voice, audio, sent: &sent, replyID: "r1")
        // Playback drains, listening resumes, and the route's latency replays the reply tail.
        voice.agentDidComplete([.streamingText(id: "r1", text: reply, isFinal: true)])
        await waitForState(voice, .listening)
        await automaticTurn(voice, audio, recognized: "should i send it to sara now", sent: &sent)
        XCTAssertEqual(sent.count, 1)
        XCTAssertEqual(voice.captureNotice, "Ignored audio that matched Omni's reply. Still listening.")
        voice.cancel()
    }

    func testEchoRetriesAreBounded() async {
        let audio = Audio(); let voice = makeVoice(audio)
        var sent: [String] = []
        await voice.start()
        await ownerTurnThenReply(voice, audio, sent: &sent, replyID: "r1")
        voice.agentDidComplete([.streamingText(id: "r1", text: reply, isFinal: true)])
        await waitForState(voice, .listening)
        for _ in 0..<2 {
            await automaticTurn(voice, audio, recognized: "should i send it to sara now", sent: &sent)
            XCTAssertEqual(voice.state, .listening)
        }
        await automaticTurn(voice, audio, recognized: "should i send it to sara now", sent: &sent)
        XCTAssertEqual(voice.state, .paused)
        XCTAssertEqual(sent.count, 1)
        voice.cancel()
    }

    private func waitForState(_ voice: VoiceConversation, _ state: VoiceConversation.State) async {
        for _ in 0..<200 where voice.state != state { await Task.yield() }
        XCTAssertEqual(voice.state, state)
    }
}
