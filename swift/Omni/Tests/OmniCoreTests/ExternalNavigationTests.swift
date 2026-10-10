import Foundation
@testable import OmniCore
import XCTest

final class ExternalNavigationTests: XCTestCase {
    func testColdTapWaitsForAuthenticationUnlockAndMountedNavigationThenConsumesOnce() {
        var queue = ExternalNavigationQueue()
        XCTAssertTrue(queue.receive(URL(string: "omni://thread/exact_conversation-42")!))
        XCTAssertNil(queue.take(signedIn: false, unlocked: true, navigationReady: false))
        XCTAssertNil(queue.take(signedIn: true, unlocked: false, navigationReady: true))
        XCTAssertNil(queue.take(signedIn: true, unlocked: true, navigationReady: false))
        XCTAssertEqual(queue.take(signedIn: true, unlocked: true, navigationReady: true), .thread("exact_conversation-42"))
        XCTAssertNil(queue.take(signedIn: true, unlocked: true, navigationReady: true))
    }
    func testInvalidLinkCannotReplacePendingConversationAndLatestValidTapWins() {
        var queue = ExternalNavigationQueue()
        XCTAssertTrue(queue.receive(URL(string: "omni://thread/first")!))
        for text in ["https://thread/other", "omni://thread/a/b", "omni://thread/a?token=secret", "omni://thread/a%2Fb", "omni://user@thread/a", "omni://auth/callback"] {
            XCTAssertFalse(queue.receive(URL(string: text)!))
        }
        XCTAssertEqual(queue.take(signedIn: true, unlocked: true, navigationReady: true), .thread("first"))
        XCTAssertTrue(queue.receive(URL(string: "omni://thread/second")!))
        XCTAssertTrue(queue.receive(URL(string: "omni://nudge/digest")!))
        XCTAssertEqual(queue.take(signedIn: true, unlocked: true, navigationReady: true), .needsYou)
    }
    func testPrismSourcePreservesServerVaultAndBrowserFallback() {
        let link = PrismSourceLink(web: "https://workspace.example/page/note_1", noteID: "note_1")!
        let native = URLComponents(url: link.native!, resolvingAgainstBaseURL: false)!
        XCTAssertEqual(native.host, "source")
        XCTAssertEqual(native.path, "/note_1")
        XCTAssertEqual(native.queryItems?.first(where: { $0.name == "server" })?.value, "https://workspace.example")
        XCTAssertEqual(native.queryItems?.first(where: { $0.name == "vault" })?.value, "primary")
        XCTAssertEqual(link.web.absoluteString, "https://workspace.example/page/note_1")
        XCTAssertNil(PrismSourceLink(web: "file:///secret", noteID: "note_1"))
        XCTAssertNil(PrismSourceLink(web: "https://user:password@example.test/page/id", noteID: "id"))
        XCTAssertNil(PrismSourceLink(web: "https://example.test/page/id", noteID: "../auth")?.native)
        XCTAssertNil(PrismSourceLink(web: "https://example.test/collab/id?t=capability", noteID: "id")?.native)
        XCTAssertNil(PrismSourceLink(web: "https://example.test/page/other", noteID: "id")?.native)
    }
}
