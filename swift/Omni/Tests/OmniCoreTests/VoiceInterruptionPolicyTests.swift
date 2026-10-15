import Foundation
import XCTest
@testable import OmniCore

final class VoiceInterruptionPolicyTests: XCTestCase {
    private func frame(_ time: Double, speech: Bool = true, captured: Double = 100, duration: Double = 0.256) -> VoiceActivityFrame {
        VoiceActivityFrame(audioTime: time, capturedAt: captured, duration: duration, isSpeech: speech)
    }
    func testQuickPreservesTwoFrameThresholdAndSustainedRequiresThree() {
        var quick = VoiceInterruptionPolicy()
        var sustained = VoiceInterruptionPolicy(responsiveness: .sustained)
        XCTAssertFalse(quick.accept(frame(0.256), now: 100))
        XCTAssertTrue(quick.accept(frame(0.512), now: 100))
        XCTAssertFalse(sustained.accept(frame(0.256), now: 100))
        XCTAssertFalse(sustained.accept(frame(0.512), now: 100))
        XCTAssertTrue(sustained.accept(frame(0.768), now: 100))
    }
    func testEchoSettlingIgnoresSpeechAtTheStartOfEachReply() {
        // Echo leaks while the canceller adapts: continuous detector speech from the
        // first frame cannot interrupt until a run begins after settling.
        var quick = VoiceInterruptionPolicy(responsiveness: .quick, settlingSeconds: VoiceInterruptionPolicy.echoSettlingSeconds)
        for index in 1...3 { XCTAssertFalse(quick.accept(frame(Double(index) * 0.256), now: 100)) }
        XCTAssertTrue(quick.ignoredSpeechWhileSettling)
        XCTAssertFalse(quick.accept(frame(1.024), now: 100))
        XCTAssertTrue(quick.accept(frame(1.280), now: 100), "Quick interrupts two frames after settling")
        var sustained = VoiceInterruptionPolicy(responsiveness: .sustained, settlingSeconds: VoiceInterruptionPolicy.echoSettlingSeconds)
        for index in 1...5 { XCTAssertFalse(sustained.accept(frame(Double(index) * 0.256), now: 100)) }
        XCTAssertTrue(sustained.accept(frame(1.536), now: 100), "Sustained interrupts three frames after settling")
    }
    func testSettlingIsMeasuredFromTheFirstMonitoredFrameAndNotReopenedByReset() {
        var policy = VoiceInterruptionPolicy(responsiveness: .quick, settlingSeconds: 1)
        XCTAssertFalse(policy.accept(frame(10.256, speech: false), now: 100))
        XCTAssertFalse(policy.ignoredSpeechWhileSettling)
        policy.reset()
        XCTAssertFalse(policy.accept(frame(11.264), now: 100))
        XCTAssertTrue(policy.accept(frame(11.520), now: 100), "A mid-reply discontinuity must not restart settling")
    }
    func testSilentSettlingDoesNotRecordIgnoredSpeech() {
        var policy = VoiceInterruptionPolicy(settlingSeconds: 1)
        for index in 1...3 { XCTAssertFalse(policy.accept(frame(Double(index) * 0.256, speech: false), now: 100)) }
        XCTAssertFalse(policy.ignoredSpeechWhileSettling)
    }
    func testSilenceAndExplicitResetBreakSpeechRuns() {
        var policy = VoiceInterruptionPolicy(responsiveness: .sustained)
        for index in 1...8 {
            XCTAssertFalse(policy.accept(frame(Double(index) * 0.256, speech: index % 3 != 0), now: 100))
        }
        policy.reset()
        XCTAssertEqual(policy.speechDuration, 0)
        XCTAssertFalse(policy.accept(frame(10), now: 100))
    }
    func testInvalidEvidenceBreaksRuns() {
        let invalid = [frame(0.512, captured: 99), frame(0.512, captured: 101),
                       frame(.nan), frame(0.512, captured: .infinity),
                       frame(0.512, duration: .nan), frame(0.512, duration: 0),
                       frame(0.512, duration: 0.5), frame(0.256), frame(0.1), frame(1.024)]
        for bad in invalid {
            var policy = VoiceInterruptionPolicy()
            XCTAssertFalse(policy.accept(frame(0.256), now: 100))
            XCTAssertFalse(policy.accept(bad, now: 100))
            XCTAssertEqual(policy.speechDuration, 0)
            XCTAssertFalse(policy.accept(frame(2), now: 100))
        }
    }
    func testNonfiniteClockIsRejected() {
        var policy = VoiceInterruptionPolicy()
        XCTAssertFalse(policy.accept(frame(0.256), now: .nan))
        XCTAssertEqual(policy.speechDuration, 0)
    }
    func testResponsivenessPersistenceAndUnknownValueFallback() async {
        await MainActor.run {
            let suite = "VoiceInterruptionPolicyTests.\(UUID().uuidString)"
            let defaults = UserDefaults(suiteName: suite)!
            defer { defaults.removePersistentDomain(forName: suite) }
            let preferences = VoiceTurnPreferences(defaults: defaults)
            XCTAssertEqual(preferences.interruptionResponsiveness, .quick)
            preferences.interruptionResponsiveness = .sustained
            XCTAssertEqual(VoiceTurnPreferences(defaults: defaults).interruptionResponsiveness, .sustained)
            defaults.set("unknown", forKey: "omni.voice.interruptionResponsiveness")
            XCTAssertEqual(VoiceTurnPreferences(defaults: defaults).interruptionResponsiveness, .quick)
        }
    }
}
