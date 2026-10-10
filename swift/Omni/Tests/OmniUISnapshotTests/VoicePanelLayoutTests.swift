#if os(macOS)
import AppKit
import OmniCore
@testable import OmniUI
import SwiftUI
import XCTest

@MainActor final class VoicePanelLayoutTests: XCTestCase {
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
