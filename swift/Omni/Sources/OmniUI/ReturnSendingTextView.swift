#if os(iOS)
import SwiftUI
import UIKit

/// Software-keyboard Return submits; hardware Shift-Return remains a deliberate newline.
struct ReturnSendingTextView: UIViewRepresentable {
    @Binding var text: String
    @Binding var focused: Bool
    let label: String
    let canSend: Bool
    let onSend: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIView(context: Context) -> ReturnTextView {
        let view = ReturnTextView()
        view.delegate = context.coordinator
        view.backgroundColor = .clear
        view.font = .preferredFont(forTextStyle: .body)
        view.adjustsFontForContentSizeCategory = true
        view.returnKeyType = .send
        view.textContainerInset = UIEdgeInsets(top: 8, left: 0, bottom: 8, right: 0)
        view.accessibilityIdentifier = "composer"
        return view
    }
    func updateUIView(_ view: ReturnTextView, context: Context) {
        context.coordinator.parent = self
        if view.text != text { view.text = text }
        view.accessibilityLabel = label
        view.accessibilityHint = "Return sends. Shift-Return starts a new line."
        Task { @MainActor [weak view, weak coordinator = context.coordinator] in
            guard let view, let coordinator, view.window != nil else { return }
            if coordinator.parent.focused && !view.isFirstResponder { view.becomeFirstResponder() }
            else if !coordinator.parent.focused && view.isFirstResponder { view.resignFirstResponder() }
        }
    }
    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: ReturnSendingTextView
        init(_ parent: ReturnSendingTextView) { self.parent = parent }
        func textViewDidBeginEditing(_ view: UITextView) { parent.focused = true }
        func textViewDidEndEditing(_ view: UITextView) { parent.focused = false }
        func textViewDidChange(_ view: UITextView) { parent.text = view.text }
        func textView(_ view: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
            // Do not submit an IME composition or treat pasted multiline text as a send.
            switch ComposerReturnBehavior.action(replacement: text,
                shift: (view as? ReturnTextView)?.insertingLineBreak == true,
                composing: view.markedTextRange != nil || (view as? ReturnTextView)?.pasting == true, canSend: parent.canSend) {
            case .send: parent.onSend(); return false
            case .consume: return false
            case .insert: return true
            }
        }
    }
}

final class ReturnTextView: UITextView {
    private(set) var insertingLineBreak = false
    private(set) var pasting = false
    override func paste(_ sender: Any?) {
        pasting = true
        defer { pasting = false }
        super.paste(sender)
    }
    override var keyCommands: [UIKeyCommand]? {
        let newline = UIKeyCommand(input: "\r", modifierFlags: .shift, action: #selector(insertLineBreak))
        newline.wantsPriorityOverSystemBehavior = true
        return (super.keyCommands ?? []) + [newline]
    }
    @objc private func insertLineBreak() {
        insertingLineBreak = true
        defer { insertingLineBreak = false }
        insertText("\n")
    }
}
#elseif os(macOS)
import SwiftUI
import AppKit

struct ReturnSendingTextView: NSViewRepresentable {
    @Binding var text: String
    @Binding var focused: Bool
    let label: String
    let canSend: Bool
    let onSend: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeNSView(context: Context) -> NSScrollView {
        let scroll = ComposerScrollView()
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        let view = ComposerNSTextView()
        view.focusChanged = { [weak coordinator = context.coordinator] focused in
            guard let coordinator, coordinator.parent.focused != focused else { return }
            coordinator.parent.focused = focused
        }
        view.delegate = context.coordinator
        view.isRichText = false
        view.drawsBackground = false
        view.font = .preferredFont(forTextStyle: .body)
        view.textContainerInset = NSSize(width: 0, height: 0)
        view.isVerticallyResizable = true
        view.isHorizontallyResizable = false
        view.autoresizingMask = .width
        view.textContainer?.widthTracksTextView = true
        view.setAccessibilityIdentifier("composer")
        scroll.documentView = view
        return scroll
    }
    func updateNSView(_ scroll: NSScrollView, context: Context) {
        context.coordinator.parent = self
        guard let view = scroll.documentView as? NSTextView else { return }
        if view.string != text { view.string = text }
        view.setAccessibilityLabel(label)
        view.setAccessibilityHelp("Return sends. Shift-Return starts a new line.")
        Task { @MainActor [weak view, weak coordinator = context.coordinator] in
            guard let view, let coordinator, let window = view.window else { return }
            if coordinator.parent.focused, window.firstResponder !== view { window.makeFirstResponder(view) }
            else if !coordinator.parent.focused, window.firstResponder === view { window.makeFirstResponder(nil) }
        }
    }
    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: ReturnSendingTextView
        init(_ parent: ReturnSendingTextView) { self.parent = parent }
        func textDidChange(_ notification: Notification) {
            if let view = notification.object as? NSTextView { parent.text = view.string }
        }
        func textView(_ view: NSTextView, doCommandBy selector: Selector) -> Bool {
            guard selector == #selector(NSResponder.insertNewline(_:)) else { return false }
            switch ComposerReturnBehavior.action(replacement: "\n", shift: (view as? ComposerNSTextView)?.shiftReturn == true,
                composing: view.hasMarkedText(), canSend: parent.canSend) {
            case .send: parent.onSend(); return true
            case .consume: return true
            case .insert: return false
            }
        }
    }
}
/// Keep the editable document hittable even while its draft is empty.
final class ComposerScrollView: NSScrollView {
    override func layout() {
        super.layout()
        guard let editor = documentView as? NSTextView else { return }
        editor.minSize = NSSize(width: 0, height: contentSize.height)
        editor.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        let size = NSSize(width: contentSize.width, height: max(editor.frame.height, contentSize.height))
        if editor.frame.size != size { editor.setFrameSize(size) }
    }
}
/// Focus acquisition happens before editing; synchronize it at the responder boundary.
final class ComposerNSTextView: NSTextView {
    var focusChanged: ((Bool) -> Void)?
    private(set) var shiftReturn = false
    override func becomeFirstResponder() -> Bool {
        let accepted = super.becomeFirstResponder()
        if accepted { focusChanged?(true) }
        return accepted
    }
    override func resignFirstResponder() -> Bool {
        let accepted = super.resignFirstResponder()
        if accepted { focusChanged?(false) }
        return accepted
    }
    override func keyDown(with event: NSEvent) {
        shiftReturn = (event.keyCode == 36 || event.keyCode == 76) && event.modifierFlags.contains(.shift)
        defer { shiftReturn = false }
        super.keyDown(with: event)
    }
}
#endif
