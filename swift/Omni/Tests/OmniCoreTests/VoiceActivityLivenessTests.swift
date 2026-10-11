import XCTest
@testable import OmniCore

@MainActor final class VoiceActivityLivenessTests: XCTestCase {
    /// A timed callback source uses the real Core watchdog Task and uptime clock.
    /// It does not poll the watchdog or manufacture future/stale capture times.
    private final class Audio: ConversationAudio {
        var receive: (@MainActor (VoiceActivityEvent) -> Void)?
        var pump: Task<Void, Never>?
        var starts = 0
        var delivered = 0
        var startup: Duration = .milliseconds(1100)
        var sourceAge = 0.0
        func configureActivity(enabled: Bool, receive: @escaping @MainActor (VoiceActivityEvent) -> Void) { self.receive = enabled ? receive : nil }
        func start() async throws {
            starts += 1
            pump?.cancel()
            pump = Task { [weak self] in
                guard let self else { return }
                do {
                    try await Task.sleep(for: self.startup)
                    var audioTime = 0.0
                    while !Task.isCancelled {
                        audioTime += 0.256
                        self.delivered += 1
                        self.receive?(.frame(VoiceActivityFrame(audioTime: audioTime,
                            capturedAt: ProcessInfo.processInfo.systemUptime - self.sourceAge,
                            duration: 0.256, isSpeech: false)))
                        try await Task.sleep(for: .milliseconds(256))
                    }
                } catch {}
            }
        }
        func finish() async throws -> String { pump?.cancel(); return "A synthetic first turn." }
        func cancel() { pump?.cancel(); pump = nil }
        func speak(_ text: String) {}
        func waitForPlayback() async {}
        func silence() {}
    }
    func testDelayedFirstResultAndSustainedCallbacksStayAutomaticAfterReplyRelisten() async throws {
        let audio = Audio()
        let active = VoiceConversation(audio: audio)
        active.configureEndpoint(mode: .automatic, pauseSeconds: 2)
        active.canAutomaticallyListen = { true }
        await active.start()
        try await Task.sleep(for: .milliseconds(1650))
        XCTAssertGreaterThanOrEqual(audio.delivered, 2)
        XCTAssertNil(active.activityNotice, "First VAD inference can arrive after the old 0.75-second startup timeout")
        await active.finish { _ in true }
        active.agentDidComplete([])
        await eventually { audio.starts == 2 }
        let before = audio.delivered
        try await Task.sleep(for: .milliseconds(2200))
        XCTAssertGreaterThanOrEqual(audio.delivered - before, 4)
        XCTAssertEqual(active.state, .listening)
        XCTAssertNil(active.activityNotice, "Automatic detection must remain enabled beyond reply drain and sustained fresh callbacks")
        active.cancel()
    }
    func testStartupGraceNeverAcceptsStaleSourceAudioOrSends() async throws {
        let audio = Audio()
        audio.sourceAge = 0.6
        let active = VoiceConversation(audio: audio)
        active.configureEndpoint(mode: .automatic, pauseSeconds: 2)
        var sends = 0
        active.automaticFinish = { sends += 1 }
        await active.start()
        try await Task.sleep(for: .milliseconds(1450))
        XCTAssertNotNil(active.activityNotice)
        XCTAssertEqual(sends, 0)
        XCTAssertEqual(active.state, .listening, "Keep explicit Send turn available when local evidence is stale")
        active.cancel()
    }
    func testLostHealthyHeartbeatAndMissingStartupRemainBounded() async throws {
        for noStartup in [false, true] {
            let audio = Audio()
            audio.startup = noStartup ? .seconds(10) : .milliseconds(20)
            let active = VoiceConversation(audio: audio)
            active.configureEndpoint(mode: .automatic, pauseSeconds: 2)
            await active.start()
            if !noStartup {
                try await Task.sleep(for: .milliseconds(100))
                XCTAssertGreaterThan(audio.delivered, 0)
                audio.pump?.cancel()
            }
            try await Task.sleep(for: noStartup ? .milliseconds(2300) : .milliseconds(1000))
            XCTAssertNotNil(active.activityNotice)
            XCTAssertEqual(active.state, .listening)
            active.cancel()
        }
    }
}
