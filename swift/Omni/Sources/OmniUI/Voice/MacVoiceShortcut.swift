#if os(macOS)
import AppKit
import Carbon
import Observation
import OmniCore
import SwiftUI

/// Carbon registers only this chord; it does not monitor ordinary keystrokes or need
/// Accessibility permission. Registration failure is visible in the menu.
@MainActor @Observable public final class MacVoiceShortcut {
    public static let shared = MacVoiceShortcut()
    public private(set) var available = false
    private var hotKey: EventHotKeyRef?
    private var handler: EventHandlerRef?
    private var open: (() -> Void)?

    public func configure(open: @escaping () -> Void) {
        self.open = open
        guard handler == nil else { return }
        var event = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let installed = InstallEventHandler(GetApplicationEventTarget(), { _, _, _ in
            Task { @MainActor in MacVoiceShortcut.shared.activate() }
            return noErr
        }, 1, &event, nil, &handler)
        guard installed == noErr else { return }
        let id = EventHotKeyID(signature: 0x4F4D4E49, id: 1)
        available = RegisterEventHotKey(UInt32(kVK_Space), UInt32(cmdKey | optionKey | controlKey), id,
                                       GetApplicationEventTarget(), 0, &hotKey) == noErr
    }

    public func activate() {
        open?()
        NSApplication.shared.activate()
        VoiceActivationCoordinator.shared.request()
    }
}

public struct MacVoiceMenu: View {
    @Environment(\.openWindow) private var openWindow
    public init() {}
    public var body: some View {
        Button("Talk to Omni") { MacVoiceShortcut.shared.activate() }
        Text(MacVoiceShortcut.shared.available ? "Global shortcut: ⌃⌥⌘Space" : "Global shortcut unavailable — use Talk to Omni")
        Divider()
        Toggle("Experimental Hey Omni", isOn: Binding(get: { MacWakeListener.shared.enabled }, set: { MacWakeListener.shared.enabled = $0 }))
        Text(MacWakeListener.shared.status)
        Text("Local speech recognition. No ambient upload or recording. Energy and false wakes need evaluation.")
        Button("Open Omni") { openWindow(id: "main"); NSApplication.shared.activate() }
        Divider()
        Button("Quit Omni") { NSApplication.shared.terminate(nil) }
    }
}

public struct MacVoiceShortcutSetup: ViewModifier {
    @Environment(\.openWindow) private var openWindow
    public init() {}
    public func body(content: Content) -> some View {
        content.onAppear {
            MacVoiceShortcut.shared.configure { openWindow(id: "main") }
        }
    }
}
#endif
