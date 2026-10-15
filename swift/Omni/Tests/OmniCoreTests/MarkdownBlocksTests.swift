import Foundation
@testable import OmniCore
import XCTest

final class MarkdownBlocksTests: XCTestCase {
    private func words(_ block: MarkdownBlock) -> String { String(block.text.characters) }

    func testHeadingsParagraphsAndRules() {
        let blocks = MarkdownBlocks.parse("# Title\n\nFirst paragraph.\n\n---\n\n#### Small")
        XCTAssertEqual(blocks.map(\.kind), [.heading(1), .paragraph, .rule, .heading(4)])
        XCTAssertEqual(words(blocks[0]), "Title")
        XCTAssertEqual(words(blocks[1]), "First paragraph.")
        XCTAssertEqual(blocks[2].plainText, "")
    }

    func testInlineStylingInsideBlocks() throws {
        let blocks = MarkdownBlocks.parse("## A **bold** heading\n\nSome *italic*, `code`, ~~gone~~ and [a link](https://example.com/a).")
        XCTAssertEqual(words(blocks[0]), "A bold heading")
        XCTAssertTrue(blocks[0].text.runs.contains { $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true })
        let paragraph = blocks[1].text
        XCTAssertEqual(String(paragraph.characters), "Some italic, code, gone and a link.")
        XCTAssertTrue(paragraph.runs.contains { $0.inlinePresentationIntent?.contains(.emphasized) == true })
        XCTAssertTrue(paragraph.runs.contains { $0.inlinePresentationIntent?.contains(.code) == true })
        XCTAssertTrue(paragraph.runs.contains { $0.inlinePresentationIntent?.contains(.strikethrough) == true })
        let link = try XCTUnwrap(paragraph.runs.first { $0.link != nil })
        XCTAssertEqual(link.link, URL(string: "https://example.com/a"))
        XCTAssertEqual(String(paragraph[link.range].characters), "a link")
        // The block structure is not left on the text (it is drawn, not inherited).
        XCTAssertFalse(paragraph.runs.contains { $0.presentationIntent != nil })
    }

    func testLineBreaksInAParagraphAreKept() {
        let blocks = MarkdownBlocks.parse("Dana Lee\n12 Harbour Road\nPort Town")
        XCTAssertEqual(blocks.count, 1)
        XCTAssertEqual(words(blocks[0]), "Dana Lee\n12 Harbour Road\nPort Town")
    }

    func testBulletAndNumberedListsWithNesting() {
        let blocks = MarkdownBlocks.parse("- one\n- two\n  - two a\n  - two b\n- three\n\n3. third\n4. fourth")
        XCTAssertEqual(blocks.map(words), ["one", "two", "two a", "two b", "three", "third", "fourth"])
        XCTAssertEqual(blocks.map(\.marker), [.bullet, .bullet, .bullet, .bullet, .bullet, .number(3), .number(4)])
        XCTAssertEqual(blocks.map(\.listDepth), [1, 1, 2, 2, 1, 1, 1])
        XCTAssertEqual(blocks[5].plainText, "3. third")
        XCTAssertEqual(Set(blocks[0...4].map(\.list)).count, 1, "one bullet list, nested items included")
        XCTAssertNotEqual(blocks[4].list, blocks[5].list, "the numbered list is another list")
        XCTAssertNil(MarkdownBlocks.parse("Not a list.")[0].list)
        XCTAssertEqual(blocks[0].plainText, "• one")
    }

    func testAListItemsLaterBlocksKeepTheIndentButNoMarker() {
        let blocks = MarkdownBlocks.parse("1. First\n\n   More about the first.\n\n   ```\n   code\n   ```\n2. Second")
        XCTAssertEqual(blocks.map(\.kind), [.paragraph, .paragraph, .code(language: nil), .paragraph])
        XCTAssertEqual(blocks.map(\.marker), [.number(1), nil, nil, .number(2)])
        XCTAssertEqual(blocks.map(\.listDepth), [1, 1, 1, 1])
    }

    func testQuotes() {
        let blocks = MarkdownBlocks.parse("> Quoted *words*\n> on two lines\n\nAfter.")
        XCTAssertEqual(blocks.count, 2)
        XCTAssertEqual(blocks[0].quoteDepth, 1)
        XCTAssertEqual(words(blocks[0]), "Quoted words\non two lines")
        XCTAssertEqual(blocks[1].quoteDepth, 0)
    }

    func testFencedCodeKeepsItsTextAndLanguage() {
        let blocks = MarkdownBlocks.parse("Before\n\n```swift\nlet x = 1\n\n  print(**x**)\n```\nAfter")
        XCTAssertEqual(blocks.map(\.kind), [.paragraph, .code(language: "swift"), .paragraph])
        XCTAssertEqual(words(blocks[1]), "let x = 1\n\n  print(**x**)")
    }

    func testAnUnclosedFenceWhileStreamingIsStillCode() {
        let blocks = MarkdownBlocks.parse("Here:\n\n```py\nprint(1)\npri")
        XCTAssertEqual(blocks.map(\.kind), [.paragraph, .code(language: "py")])
        XCTAssertEqual(words(blocks[1]), "print(1)\npri")
    }

    func testHalfWrittenInlineMarkupIsShownAsWritten() {
        let blocks = MarkdownBlocks.parse("The answer is **Nov")
        XCTAssertEqual(blocks.map(words), ["The answer is **Nov"])
    }

    func testTables() {
        let blocks = MarkdownBlocks.parse("| Supplier | Weeks |\n| --- | --- |\n| Harbour | **2** |\n| North | 5 |\n\nDone.")
        XCTAssertEqual(blocks.map(\.kind), [.table, .paragraph])
        XCTAssertEqual(blocks[0].rows.map { $0.map { String($0.characters) } }, [["Supplier", "Weeks"], ["Harbour", "2"], ["North", "5"]])
        XCTAssertEqual(blocks[0].plainText, "Supplier, Weeks\nHarbour, 2\nNorth, 5")
    }

    func testBareURLsBecomeLinksButNotInCode() throws {
        let blocks = MarkdownBlocks.parse("See https://example.com/x for it, not `https://example.com/code`.")
        let links = blocks[0].text.runs.compactMap(\.link)
        XCTAssertEqual(links, [URL(string: "https://example.com/x")!])
    }

    func testUserTextIsInlineOnly() {
        let text = MarkdownBlocks.inline("# not a heading\n- not a list with **bold** and https://example.com")
        XCTAssertEqual(String(text.characters), "# not a heading\n- not a list with bold and https://example.com")
        XCTAssertTrue(text.runs.contains { $0.link == URL(string: "https://example.com") })
    }

    func testPlainTextForVoiceOver() {
        XCTAssertEqual(MarkdownBlocks.plainText("## Plan\n\n1. Ask\n2. Book\n\n---\n\n> Note"), "Plan\n1. Ask\n2. Book\nNote")
    }

    func testEmptyAndCached() {
        XCTAssertEqual(MarkdownBlocks.parse(""), [])
        let text = "- cached \(UUID().uuidString)"
        XCTAssertEqual(MarkdownBlocks.cached(text), MarkdownBlocks.parse(text))
        XCTAssertEqual(MarkdownBlocks.cached(text), MarkdownBlocks.parse(text))
    }
}
