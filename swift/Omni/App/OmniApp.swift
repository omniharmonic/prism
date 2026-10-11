import OmniCore
import OmniUI
import SwiftUI

/// The Omni app. A thin shell: every screen lives in the OmniUI library and every rule in
/// OmniCore (both in this folder's Swift package), so they build and test without Xcode.
@main
struct OmniApp: App {
    #if os(macOS)
    @NSApplicationDelegateAdaptor(OmniNotificationDelegate.self) private var notificationDelegate
    #else
    @UIApplicationDelegateAdaptor(OmniNotificationDelegate.self) private var notificationDelegate
    #endif
    #if os(macOS)
    @State private var app: AppModel

    init() {
        let model = OmniAppFactory.liveModel(developmentBuild: OmniApp.isDevelopmentBuild)
        _app = State(initialValue: model)
        // Wake readiness belongs to the running app, independent of window and
        // synthesized menu-label lifecycle callbacks. Bind the same State model.
        MacWakeListener.shared.bind(app: model)
    }
    #else
    @State private var app = OmniAppFactory.liveModel(developmentBuild: OmniApp.isDevelopmentBuild)
    #endif

    /// DEBUG builds default to the laptop dev gateway and use the login keychain on macOS.
    private static var isDevelopmentBuild: Bool {
        #if DEBUG
        true
        #else
        false
        #endif
    }

    var body: some Scene {
        #if os(macOS)
        Window("Omni", id: "main") {
            RootView(app: app)
                .frame(minWidth: 760, minHeight: 500)
                .modifier(MacVoiceShortcutSetup())
        }
        .defaultSize(width: 1040, height: 700)
        .commands { OmniCommands(app: app) }

        MenuBarExtra {
            MacVoiceMenu()
        } label: {
            Image(systemName: "waveform")
                .accessibilityLabel("Omni Voice")
                .modifier(MacVoiceShortcutSetup())
        }

        Settings {
            SettingsView(app: app)
                .modifier(PrivacyLockCover())
        }
        #else
        WindowGroup {
            RootView(app: app)
        }
        .commands { OmniCommands(app: app) }
        #endif
    }
}
