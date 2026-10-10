#if os(macOS)
import AppKit
import OmniCore
import Observation
@testable import OmniUI
import SwiftUI
import XCTest

@MainActor final class VoiceNavigationLifecycleTests: XCTestCase {
    private final class Audio: ConversationAudio {
        var starts = 0
        var speech: [String] = []
        var cancels = 0
        func start() async throws { starts += 1 }
        func finish() async throws -> String { "Hello Omni." }
        func cancel() { cancels += 1 }
        func speak(_ text: String) { speech.append(text) }
        func waitForPlayback() async {}
        func silence() {}
    }
    private struct Root: View {
        @Bindable var session: SessionModel
        var body: some View {
            DestinationView(session: session, destination: session.destination)
                .environment(\.scenePhase, .active)
        }
    }
    @Observable final class SceneState { var phase: ScenePhase = .active }
    private struct RetainedNewControl: View {
        let session: SessionModel
        @Bindable var scene: SceneState
        var body: some View {
            ConversationVoiceControl(session: session, expanded: .constant(true))
                .environment(\.scenePhase, scene.phase)
        }
    }
    func testLateSceneCallbackFromTransferredNewControlCannotCancelSession() async throws {
        let service = SampleService()
        service.createdVoiceThreadID = "transferred"
        service.addThread("transferred", "Synthetic handoff", state: "working")
        let session = SessionModel(service: service) {}
        session.requestNewVoice()
        let audio = Audio(), scene = SceneState()
        let active = VoiceConversation(audio: audio)
        session.claimVoice(audio: audio, voice: active, threadID: nil)
        await active.start()
        let window = NSWindow(contentRect: CGRect(x: -20000, y: -20000, width: 600, height: 700), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.alphaValue = 0; window.ignoresMouseEvents = true
        window.contentViewController = NSHostingController(rootView: RetainedNewControl(session: session, scene: scene))
        window.orderBack(nil)
        defer { window.contentViewController = nil; window.close(); session.stop() }
        try await Task.sleep(for: .milliseconds(100))
        await active.finish { await session.startVoiceThread(prompt: $0, voice: active) }
        XCTAssertEqual(active.state, .answering)
        let cancellations = audio.cancels
        scene.phase = .inactive
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(active.state, .answering)
        XCTAssertEqual(audio.cancels, cancellations)
    }
    func testMountedNewThreadHandoffNarratesFirstReplyAndContinues() async throws {
        NSApplication.shared.setActivationPolicy(.prohibited)
        let service = SampleService()
        service.completeStreamOnResult = true
        service.createdVoiceThreadID = "new-voice"
        let turn = "turn-new-voice"
        service.addThread("new-voice", "Voice test", state: "working", live: [
            SampleService.event(1, turn: turn, ["t": "text", "blockId": "reply", "text": "Hello back."]),
            SampleService.event(2, turn: turn, ["t": "result", "ok": true, "durationMs": 1]),
        ])
        let session = SessionModel(service: service) {}
        session.requestNewVoice()
        let audio = Audio()
        // Claim the exact audio used by this controller; no native microphone is opened.
        let active = VoiceConversation(audio: audio)
        session.claimVoice(audio: audio, voice: active, threadID: nil)
        await active.start()
        let window = NSWindow(contentRect: CGRect(x: -20000, y: -20000, width: 600, height: 700), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.alphaValue = 0; window.ignoresMouseEvents = true
        window.contentViewController = NSHostingController(rootView: Root(session: session))
        window.orderBack(nil)
        defer { window.contentViewController = nil; window.close(); active.cancel(); session.stop() }
        try await Task.sleep(for: .milliseconds(200))
        active.automaticFinish() // The mounted production control owns this callback and its send Task.
        for _ in 0..<100 where audio.speech.isEmpty || audio.starts < 2 {
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertEqual(session.destination, .thread("new-voice"))
        XCTAssertTrue(session.conversationVoice === active)
        XCTAssertEqual(audio.speech, ["Hello back."])
        XCTAssertEqual(audio.starts, 2, "The destination's mounted control must resume capture after the first reply")
        XCTAssertEqual(active.state, .listening)
        try await Task.sleep(for: .milliseconds(100))
        active.recordingLimitReached() // Mounted control uses the same draft-saving finish path as Pause.
        for _ in 0..<50 where active.state != .paused { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertEqual(active.state, .paused)
        XCTAssertEqual(session.threadModel(for: "new-voice").draft, "Hello Omni.", "Pause saves the next spoken turn without sending it")
        XCTAssertEqual(audio.speech, ["Hello back."])
    }
}
#endif
