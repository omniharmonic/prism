#if os(macOS)
import AppKit
import Foundation
import OmniClient
@testable import OmniCore
@testable import OmniUI
import PrismTransport
import SwiftUI
import XCTest

private actor LayoutNudgeService: NudgeService {
    let item: OmniNudge
    init(_ item: OmniNudge) { self.item = item }
    func nudges(later: Bool) async throws -> [OmniNudge] { later ? [] : [item] }
    func nudgeSettings() async throws -> NudgeSettings { .init() }
    func saveNudgeSettings(_ settings: NudgeSettings) async throws -> NudgeSettings { settings }
    func actOnNudge(_ id: String, action: NudgeAction, until: Date?) async throws -> OmniNudge { item }
    func startNudge(_ id: String, action: NudgeStart, key: IdempotencyKey) async throws -> NudgeStarted { throw URLError(.unsupportedURL) }
}
@MainActor final class NudgeLayoutTests: XCTestCase {
    func testNarrowAndLargeTypeCard() async throws {
        NSApplication.shared.setActivationPolicy(.prohibited)
        let item = try JSONDecoder().decode(OmniNudge.self, from: Data("""
        {"id":"layout","updatedAt":1000,"candidate":{"sourceId":"source","sourcePath":"notes/source","kind":"reply-owed","title":"Confirm the next project meeting","summary":"Dana asked whether Friday’s meeting time works. Review the source before preparing your reply.","reasons":["Waiting 24 hours","Known collaborator"],"senderId":null,"deadline":null},"score":0.7,"surfaces":0,"snoozedUntil":null,"dismissed":false,"threadId":null,"sourceLink":"https://prism.example.com/page/source"}
        """.utf8))
        let center = NudgeCenter(service: LayoutNudgeService(item), sink: ErrorSink(onSignedOut: {}))
        let variants: [(String, CGFloat, DynamicTypeSize)] = [("nudge-narrow", 320, .large), ("nudge-xxxl", 360, .xxxLarge), ("nudge-accessibility", 360, .accessibility3)]
        for (name, width, type) in variants {
            var walk = Walk(variant: .init(folder: name, size: CGSize(width: width, height: 1000), dark: false), root: MacSnapshotTests.outputRoot)
            try await walk.draw("card", settle: .milliseconds(100), NudgeCardView(center: center, item: item).environment(\.dynamicTypeSize, type).padding().padding(.top,60).frame(maxHeight: .infinity, alignment: .top))
            XCTAssertEqual(walk.count, 1)
        }
    }
}
#endif
