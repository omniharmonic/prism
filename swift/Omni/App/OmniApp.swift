import OmniCore
import OmniUI
import SwiftUI

/// The Omni app. A thin shell: every screen lives in the OmniUI library and every rule in
/// OmniCore (both in this folder's Swift package), so they build and test without Xcode.
@main
struct OmniApp: App {
    @State private var app = OmniAppFactory.liveModel(developmentBuild: OmniApp.isDevelopmentBuild)

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
        }
        .defaultSize(width: 1040, height: 700)
        .commands { OmniCommands(app: app) }

        Settings {
            SettingsView(app: app)
        }
        #else
        WindowGroup {
            RootView(app: app)
        }
        .commands { OmniCommands(app: app) }
        #endif
    }
}
