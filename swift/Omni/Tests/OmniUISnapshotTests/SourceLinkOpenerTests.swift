import XCTest
@testable import OmniUI
import OmniCore

/// The crash of 2026-10-15: LaunchServices answers `OpenURLAction` on its own queue. The completion
/// must not be main-actor isolated, and the browser fallback must still run on the main actor.
@MainActor
final class SourceLinkOpenerTests: XCTestCase {
    private let link = PrismSourceLink(web: "https://prism.example.com/page/n1", noteID: "n1")!

    func testARefusedNativeOpenCompletedOffTheMainQueueFallsBackToTheBrowserOnTheMainActor() async {
        XCTAssertNotNil(link.native)
        let fellBack = expectation(description: "browser fallback")
        SourceLinkOpener.open(link, attempt: { _, done in
            DispatchQueue.global().async { done(false) }   // what LaunchServices does
        }, fallback: { url in
            XCTAssertTrue(Thread.isMainThread)
            XCTAssertEqual(url, self.link.web)
            fellBack.fulfill()
        })
        await fulfillment(of: [fellBack], timeout: 5)
    }

    func testAnAcceptedNativeOpenDoesNotAlsoOpenTheBrowser() async {
        let answered = expectation(description: "answered")
        SourceLinkOpener.open(link, attempt: { _, done in
            DispatchQueue.global().async { done(true); answered.fulfill() }
        }, fallback: { _ in XCTFail("the browser must not open when Prism took the link") })
        await fulfillment(of: [answered], timeout: 5)
        await Task.yield()
    }

    func testALinkWithoutANativeFormOpensTheBrowserAtOnce() {
        let plain = PrismSourceLink(web: "https://example.com/x", noteID: nil)!
        var opened: URL?
        SourceLinkOpener.open(plain, attempt: { _, _ in XCTFail("no native attempt") }, fallback: { opened = $0 })
        XCTAssertEqual(opened, plain.web)
    }
}
