import OmniCore
import SwiftUI

/// Settings (⌘, on the Mac): the server, and sign out.
public struct SettingsView: View {
    private let app: AppModel
    @State private var confirmingSignOut = false

    public init(app: AppModel) {
        self.app = app
    }

    public var body: some View {
        Form {
            Section("Server") {
                LabeledContent("Address") {
                    Text(app.origin?.value ?? "Not set").textSelection(.enabled)
                }
                LabeledContent("Status") {
                    Text(status)
                }
                Button("Change Server…") { Task { await app.changeServer() } }
                    .accessibilityHint(app.phase == .signedIn ? "Signs out first" : "Goes back to the server screen")
            }
            Section("Account") {
                Button("Sign Out", role: .destructive) { confirmingSignOut = true }
                    .disabled(app.phase != .signedIn)
                    .accessibilityHint("Revokes this device on the server and forgets its sign-in")
            }
            Section {
                Text("Omni \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"). Models are chosen on the server, not here.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .confirmationDialog("Sign out of Omni on this device?", isPresented: $confirmingSignOut) {
            Button("Sign Out", role: .destructive) { Task { await app.signOut() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The device is revoked on the server. The server address is kept.")
        }
        #if os(macOS)
        .frame(width: 460)
        .fixedSize(horizontal: false, vertical: true)
        #endif
    }

    private var status: String {
        switch app.phase {
        case .signedIn: return "Signed in"
        case .signingIn: return "Signing in…"
        case .signedOut: return "Signed out"
        case .connecting: return "Connecting…"
        case .unreachable: return "Can't connect"
        case .needsServer: return "No server yet"
        }
    }
}

/// The Mac menu commands: ⌘N new thread, ⌘F search, ⌘. stop, ⌘R refresh. (⌘, is the
/// Settings scene's own.)
public struct OmniCommands: Commands {
    private let app: AppModel

    public init(app: AppModel) {
        self.app = app
    }

    public var body: some Commands {
        CommandGroup(replacing: .newItem) {
            Button("New Thread") { app.session?.requestNewThread() }
                .keyboardShortcut("n", modifiers: .command)
                .disabled(app.session == nil)
        }
        CommandGroup(after: .textEditing) {
            Button("Search Threads") { app.session?.requestSearch() }
                .keyboardShortcut("f", modifiers: .command)
                .disabled(app.session == nil)
        }
        CommandMenu("Thread") {
            Button("Stop") { Task { await app.session?.stopCurrentTurn() } }
                .keyboardShortcut(".", modifiers: .command)
                .disabled(!(app.session?.canStopCurrentTurn ?? false))
            Button("Refresh") {
                Task {
                    await app.session?.threads.refresh()
                    await app.session?.approvals.refresh()
                }
            }
            .keyboardShortcut("r", modifiers: .command)
            .disabled(app.session == nil)
        }
    }
}
