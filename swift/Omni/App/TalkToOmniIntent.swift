import AppIntents
import OmniCore
#if os(macOS)
import AppKit
#endif

/// Lives in the app target so Xcode extracts its App Shortcuts metadata.
struct TalkToOmniIntent: AppIntent {
    static let title: LocalizedStringResource = "Talk to Omni"
    static let description = IntentDescription("Open Omni Voice and listen once you are signed in, unlocked and ready. An active conversation stays open without restarting it.")
    static var supportedModes: IntentModes { .foreground }
    static var authenticationPolicy: IntentAuthenticationPolicy { .requiresAuthentication }

    @MainActor func perform() async throws -> some IntentResult {
        #if os(macOS)
        NSApplication.shared.activate()
        #endif
        VoiceActivationCoordinator.shared.request()
        return .result()
    }
}

struct OmniAppShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: TalkToOmniIntent(),
            phrases: ["Talk to \(.applicationName)", "Start voice with \(.applicationName)"],
            shortTitle: "Talk to Omni",
            systemImageName: "waveform"
        )
    }
}
