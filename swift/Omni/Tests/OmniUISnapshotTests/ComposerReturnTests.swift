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
        var sends = 0
        let editor = ReturnSendingTextView(text: .constant("draft"), focused: .constant(false),
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

#if os(macOS)
extension ComposerReturnTests {
    @MainActor func testNativeMacResponderAndHardwareReturnInEmptyComposer() throws {
        _ = NSApplication.shared
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 360, height: 80), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let scroll = ComposerScrollView(frame: NSRect(x: 0, y: 0, width: 360, height: 80))
        let view = ComposerNSTextView()
        view.isRichText = false
        view.isVerticallyResizable = true
        view.isHorizontallyResizable = false
        view.textContainer?.widthTracksTextView = true
        scroll.documentView = view
        window.contentView = scroll
        scroll.layoutSubtreeIfNeeded()
        scroll.layout()
        XCTAssertGreaterThan(view.frame.height, 0)
        XCTAssertGreaterThan(view.frame.width, 0)
        var actualFocus = false
        view.focusChanged = { actualFocus = $0 }
        XCTAssertTrue(window.makeFirstResponder(view))
        XCTAssertTrue(actualFocus, "Click focus must be reported before the first text change")
        var sends = 0
        let editor = ReturnSendingTextView(text: .constant(""), focused: .constant(false), label: "Message", canSend: true, onSend: { sends += 1 })
        let delegate = editor.makeCoordinator()
        view.delegate = delegate
        view.insertText("first")
        let shifted = try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: .shift, timestamp: 0, windowNumber: window.windowNumber, context: nil, characters: "\r", charactersIgnoringModifiers: "\r", isARepeat: false, keyCode: 36))
        view.keyDown(with: shifted)
        view.insertText("second")
        XCTAssertTrue(view.string.contains("\n"))
        XCTAssertEqual(sends, 0)
        let plain = try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: window.windowNumber, context: nil, characters: "\r", charactersIgnoringModifiers: "\r", isARepeat: false, keyCode: 36))
        view.keyDown(with: plain)
        XCTAssertEqual(sends, 1)
        XCTAssertTrue(window.makeFirstResponder(nil))
        XCTAssertFalse(actualFocus)
        window.close()
    }
}
#endif
