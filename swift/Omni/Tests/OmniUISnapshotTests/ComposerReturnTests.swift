import XCTest
@testable import OmniUI

final class ComposerReturnTests: XCTestCase {
    func testReturnSendsAndShiftReturnInsertsWithoutSending() {
        XCTAssertEqual(ComposerReturnBehavior.action(replacement: "\n", shift: false, composing: false, canSend: true), .send)
        XCTAssertEqual(ComposerReturnBehavior.action(replacement: "\n", shift: true, composing: false, canSend: true), .insert)
        XCTAssertEqual(ComposerReturnBehavior.action(replacement: "\n", shift: false, composing: false, canSend: false), .consume)
    }
    func testPastedMultilineAndIMECompositionAreNeverSubmitted() {
        XCTAssertEqual(ComposerReturnBehavior.action(replacement: "one\ntwo", shift: false, composing: false, canSend: true), .insert)
        XCTAssertEqual(ComposerReturnBehavior.action(replacement: "\n", shift: false, composing: true, canSend: true), .insert)
        XCTAssertEqual(ComposerReturnBehavior.action(replacement: "text", shift: false, composing: false, canSend: true), .insert)
    }
}

#if os(macOS)
import AppKit
import SwiftUI

extension ComposerReturnTests {
    @MainActor func testNativeMacDelegateSendsReturnButLeavesLineBreakPasteAndCompositionToEditor() {
        let focus = FocusState<Bool>()
        var sends = 0
        let editor = ReturnSendingTextView(text: .constant("draft"), focused: focus.projectedValue,
            label: "Message", canSend: true, onSend: { sends += 1 })
        let delegate = editor.makeCoordinator()
        let view = NSTextView()
        view.delegate = delegate
        XCTAssertTrue(delegate.textView(view, doCommandBy: #selector(NSResponder.insertNewline(_:))))
        XCTAssertEqual(sends, 1)
        XCTAssertFalse(delegate.textView(view, doCommandBy: #selector(NSResponder.insertLineBreak(_:))))
        view.insertText("one\ntwo")
        XCTAssertEqual(sends, 1, "Pasted multiline text must not send")
        view.setMarkedText("候", selectedRange: NSRange(location: 0, length: 1), replacementRange: NSRange(location: NSNotFound, length: 0))
        XCTAssertTrue(view.hasMarkedText())
        XCTAssertFalse(delegate.textView(view, doCommandBy: #selector(NSResponder.insertNewline(_:))))
        XCTAssertEqual(sends, 1, "Return must first commit marked input")
    }
}
#endif
