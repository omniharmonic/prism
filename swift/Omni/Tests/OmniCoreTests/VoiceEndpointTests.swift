import XCTest
@testable import OmniCore

@MainActor final class VoiceEndpointTests: XCTestCase {
    struct Evidence {
        var time = 0.0
        mutating func frame(speech: Bool) -> VoiceActivityFrame {
            time += 0.256
            return VoiceActivityFrame(audioTime: time, capturedAt: 100 + time, duration: 0.256, isSpeech: speech)
        }
        mutating func accept(_ policy: inout VoiceEndpointPolicy, speech: Bool) -> VoiceEndpointPolicy.Decision {
            let next = frame(speech: speech)
            return policy.accept(next, now: next.capturedAt)
        }
    }
    func testInitialSilenceAndBriefNoiseNeverFinish() {
        var policy = VoiceEndpointPolicy(); var evidence = Evidence()
        for _ in 0..<100 { XCTAssertEqual(evidence.accept(&policy, speech: false), .none) }
        XCTAssertEqual(evidence.accept(&policy, speech: true), .none)
        for _ in 0..<100 { XCTAssertEqual(evidence.accept(&policy, speech: false), .none) }
    }
    func testGenerousFloorThenVisibleGraceAndOnlyOneCommit() {
        for pause in VoiceTurnPreferences.pauseChoices {
            var policy = VoiceEndpointPolicy(pauseSeconds: pause); var evidence = Evidence()
            _ = evidence.accept(&policy, speech: true); _ = evidence.accept(&policy, speech: true)
            let lastSpeech = evidence.time
            var countdown: [Int] = []; var sends = 0
            for _ in 0..<Int((pause + 5) / 0.256) {
                let decision = evidence.accept(&policy, speech: false)
                if evidence.time - lastSpeech < pause { XCTAssertEqual(decision, .none) }
                if case .countdown(let seconds) = decision { countdown.append(seconds) }
                if decision == .send { XCTAssertGreaterThanOrEqual(evidence.time - lastSpeech, pause + 3); sends += 1 }
            }
            XCTAssertTrue(countdown.contains(3)); XCTAssertTrue(countdown.contains(2)); XCTAssertTrue(countdown.contains(1))
            XCTAssertEqual(sends, 1)
        }
    }
    func testResumedSpeechCancelsGraceAndRequiresNewFullPause() {
        var policy = VoiceEndpointPolicy(pauseSeconds: 8); var evidence = Evidence()
        _ = evidence.accept(&policy, speech: true); _ = evidence.accept(&policy, speech: true)
        var decision = VoiceEndpointPolicy.Decision.none
        for _ in 0..<50 {
            decision = evidence.accept(&policy, speech: false)
            if decision == .countdown(2) { break }
        }
        XCTAssertEqual(decision, .countdown(2))
        XCTAssertEqual(evidence.accept(&policy, speech: true), .none)
        let resumed = evidence.time
        for _ in 0..<30 { XCTAssertEqual(evidence.accept(&policy, speech: false), .none) }
        XCTAssertLessThan(evidence.time - resumed, 8)
        policy.keepListening()
        for _ in 0..<30 { XCTAssertEqual(evidence.accept(&policy, speech: false), .none) }
    }
    func testStaleOrDiscontinuousDetectorEvidenceDisablesAutomaticCompletion() {
        for stale in [false, true] {
            var policy = VoiceEndpointPolicy(); var evidence = Evidence()
            _ = evidence.accept(&policy, speech: true); _ = evidence.accept(&policy, speech: true)
            let good = evidence.frame(speech: false)
            let frame = VoiceActivityFrame(audioTime: stale ? good.audioTime : good.audioTime + 2, capturedAt: good.capturedAt, duration: good.duration, isSpeech: false)
            XCTAssertEqual(policy.accept(frame, now: frame.capturedAt + (stale ? 2 : 0)), .unavailable)
            XCTAssertFalse(policy.healthy)
            XCTAssertEqual(evidence.accept(&policy, speech: false), .unavailable)
        }
    }
    func testPreferencesDefaultManualAndPersistExplicitOptIn() {
        let key = "VoiceEndpointTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: key)!
        defer { defaults.removePersistentDomain(forName: key) }
        let preferences = VoiceTurnPreferences(defaults: defaults)
        XCTAssertEqual(preferences.mode, .thinkAloud); XCTAssertEqual(preferences.pauseSeconds, 12)
        preferences.mode = .automatic; preferences.pauseSeconds = 20
        let restored = VoiceTurnPreferences(defaults: defaults)
        XCTAssertEqual(restored.mode, .automatic); XCTAssertEqual(restored.pauseSeconds, 20)
        preferences.pauseSeconds = 2
        XCTAssertEqual(preferences.pauseSeconds, 12)
    }
    func testManualModeDoesNotInstallDetectorOrAutoFinish() async {
        let audio = VoiceConversationTests.Audio(); let voice = VoiceConversation(audio: audio)
        var finished = 0; voice.automaticFinish = { finished += 1 }
        await voice.start()
        XCTAssertNil(audio.activity)
        XCTAssertEqual(finished, 0); XCTAssertNil(voice.endpointCountdown)
        voice.cancel()
    }
    func testPauseEndAndRestartRejectStaleActivityCallbacks() async {
        for end in [false, true] {
            let audio = VoiceConversationTests.Audio(); let voice = VoiceConversation(audio: audio)
            voice.configureEndpoint(mode: .automatic, pauseSeconds: 8)
            var finished = 0; voice.automaticFinish = { finished += 1 }
            await voice.start()
            let old = audio.activity!
            if end { voice.cancel() } else { voice.pause() }
            old(.unavailable("Late detector failure"))
            XCTAssertNil(voice.activityNotice)
            await voice.start()
            old(.frame(VoiceActivityFrame(audioTime: 20, capturedAt: ProcessInfo.processInfo.systemUptime, duration: 0.256, isSpeech: false)))
            XCTAssertNil(voice.endpointCountdown); XCTAssertEqual(finished, 0)
            audio.activity?(.unavailable("Detector unavailable. Use Send turn."))
            XCTAssertEqual(voice.state, .listening)
            XCTAssertNotNil(voice.activityNotice)
            voice.cancel()
        }
    }
    func testModeAndPauseStaySnapshotAcrossListeningAndAutomaticRelisten() async {
        let audio = VoiceConversationTests.Audio(); let voice = VoiceConversation(audio: audio)
        voice.configureEndpoint(mode: .automatic, pauseSeconds: 20)
        await voice.start()
        voice.configureEndpoint(mode: .thinkAloud, pauseSeconds: 8)
        XCTAssertEqual(voice.endpointMode, .automatic); XCTAssertEqual(voice.endpointPause, 20)
        voice.pause()
        voice.configureEndpoint(mode: .thinkAloud, pauseSeconds: 8)
        await voice.start()
        XCTAssertEqual(voice.endpointMode, .thinkAloud); XCTAssertEqual(voice.endpointPause, 8)
        XCTAssertNil(audio.activity)
        voice.cancel()
    }

}
