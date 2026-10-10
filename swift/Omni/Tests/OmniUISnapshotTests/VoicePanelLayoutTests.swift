#if os(macOS)
import AppKit
import OmniCore
@testable import OmniUI
import SwiftUI
import XCTest

@MainActor final class VoicePanelLayoutTests: XCTestCase {
    private final class SilentAudio: ConversationAudio {
        func start() async throws {}
        func finish() async throws -> String { "A thought kept as a draft." }
        func cancel() {}
        func speak(_ text: String) {}
        func waitForPlayback() async {}
        func silence() {}
    }
    func testListeningControlsAtNarrowWidthAndLargeText() async throws {
        NSApplication.shared.setActivationPolicy(.prohibited)
        for (name, size) in [("voice-listening-narrow", DynamicTypeSize.large), ("voice-listening-accessibility", DynamicTypeSize.accessibility3)] {
            let session = SessionModel(service: SampleService()) {}
            session.requestNewVoice()
            let audio = SilentAudio()
            let voice = VoiceConversation(audio: audio)
            session.claimVoice(audio: audio, voice: voice, threadID: nil)
            await voice.start()
            XCTAssertEqual(voice.state, .listening)
            var walk = Walk(variant: .init(folder: name, size: CGSize(width: 320, height: 844), dark: false), root: MacSnapshotTests.outputRoot)
            try await walk.draw("listening", settle: .milliseconds(100), ConversationVoiceControl(session: session, expanded: .constant(true))
                .dynamicTypeSize(size).padding(.top, 20).frame(maxHeight: .infinity, alignment: .top))
            XCTAssertEqual(walk.count, 1)
            voice.cancel()
        }
    }
    func testVoiceSettingsPhoneWidthAndLargeText() async throws {
        NSApplication.shared.setActivationPolicy(.prohibited)
        for (name, width, size) in [("voice-settings-phone", CGFloat(390), DynamicTypeSize.large), ("voice-settings-accessibility", CGFloat(390), DynamicTypeSize.accessibility3), ("voice-settings-mac", CGFloat(620), DynamicTypeSize.large)] {
            var walk = Walk(variant: .init(folder: name, size: CGSize(width: width, height: 844), dark: false), root: MacSnapshotTests.outputRoot)
            try await walk.draw("settings", settle: .milliseconds(700), ConversationVoiceSettings(device: ConversationDevice()).dynamicTypeSize(size))
            XCTAssertEqual(walk.count, 1)
            let image = try XCTUnwrap(NSBitmapImageRep(data: Data(contentsOf: MacSnapshotTests.outputRoot.appendingPathComponent("\(name)/01-settings.png"))))
            var colors = Set<String>()
            for y in stride(from: 0, to: image.pixelsHigh, by: 20) {
                for x in stride(from: 0, to: image.pixelsWide, by: 20) {
                    if let color = image.colorAt(x: x, y: y) { colors.insert(color.description) }
                }
            }
            XCTAssertGreaterThan(colors.count, 20, "Settings snapshot must contain rendered content")
        }
    }
    func testVoicePanelPhoneWidthAndWideLayouts() async throws {
        NSApplication.shared.setActivationPolicy(.prohibited)
        let variants: [(String, CGFloat, DynamicTypeSize)] = [("voice-phone-width",390,.large),("voice-phone-accessibility",390,.accessibility3),("voice-wide",1040,.large)]
        for (name,width,size) in variants {
            let session = SessionModel(service: SampleService()) {}
            session.requestNewVoice()
            var walk = Walk(variant: .init(folder:name,size:CGSize(width:width,height:844),dark:false), root:MacSnapshotTests.outputRoot)
            try await walk.draw("voice",settle:.milliseconds(100), ConversationVoiceControl(session:session,expanded:.constant(true))
                .dynamicTypeSize(size).padding(.top,80).frame(maxHeight:.infinity,alignment:.top))
            XCTAssertEqual(walk.count,1)
        }
    }
}
#endif
