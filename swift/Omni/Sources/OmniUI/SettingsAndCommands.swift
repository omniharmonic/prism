import OmniVoiceKit
import OmniCore
import SwiftUI

/// Settings (⌘, on the Mac): the server, and sign out.
public struct SettingsView: View {
    private let app: AppModel
    @State private var confirmingSignOut = false
    @State private var showingSpeechBench = false

    public init(app: AppModel) {
        self.app = app
    }

    public var body: some View {
        Form {
            Section {
                HStack(spacing: 12) {
                    Image("OmniLogo").resizable().frame(width: 48, height: 48).clipShape(RoundedRectangle(cornerRadius: 12)).accessibilityHidden(true)
                    Text("Omni").font(.title2.weight(.semibold))
                }
            }
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
                    // On the button, so the question appears beside it (an iPad shows it as a
                    // bubble pointing at what was pressed, not at the top of the sheet).
                    .confirmationDialog("Sign out of Omni on this device?", isPresented: $confirmingSignOut, titleVisibility: .visible) {
                        Button("Sign Out", role: .destructive) { Task { await app.signOut() } }
                        Button("Cancel", role: .cancel) {}
                    } message: {
                        Text("The device is revoked on the server. The server address is kept.")
                    }
            }
            if let skills = app.session?.skills {
                Section("Agent") { NavigationLink("Skills") { SkillsView(model: skills) } }
            }
            Section("Speech Benchmark") {
                Button("Open Local Speech Benchmark") { showingSpeechBench = true }
                Text("Record, correct and compare on-device engines. Nothing is sent to the agent.").font(.footnote)
            }
            Section("Privacy") {
                Toggle("Require Unlock", isOn: Binding(get: { PrivacyLock.shared.enabled }, set: { value in
                    Task { await PrivacyLock.shared.setEnabled(value) }
                }))
                .disabled(PrivacyLock.shared.busy || !PrivacyLock.shared.available)
                .accessibilityHint("Uses biometrics or your device passcode whenever Omni returns from the background")
                Text(PrivacyLock.shared.message ?? "The lock protects this device's screen. It does not sign you out.")
                    .foregroundStyle(Color.quietText)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Section("Notifications") {
                Text(NativeNotifications.shared.status)
                    .foregroundStyle(Color.quietText)
                    .fixedSize(horizontal: false, vertical: true)
                if NativeNotifications.shared.enabled {
                    Button("Reconnect Notifications") { Task { await NativeNotifications.shared.reconnect() } }
                    Button("Turn Off Notifications") { Task { await NativeNotifications.shared.disable() } }
                } else {
                    Button("Enable Notifications") { Task { await NativeNotifications.shared.enable() } }
                        .accessibilityHint("Asks permission for generic updates, never message content")
                }
            }
            .disabled(app.phase != .signedIn || NativeNotifications.shared.busy)
            if let log = app.diagnostics {
                DiagnosticsSection(log: log)
            }
            Section {
                Text("Omni \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"). Models are chosen on the server, not here.")
                    .font(.footnote)
                    .foregroundStyle(Color.quietText)
            }
        }
        .sheet(isPresented: $showingSpeechBench) {
            NavigationStack {
                STTBench().toolbar {
                    ToolbarItem(placement: .confirmationAction) { Button("Done") { showingSpeechBench = false } }
                }
            }
            .modifier(PrivacyLockCover())
        }
        .formStyle(.grouped)
        .tint(Color.omniAccent)
        #if os(macOS)
        .frame(width: app.diagnostics == nil ? 460 : 620)
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

/// Development builds only: the app's last requests — method, path, status and the server's
/// error code; never a token or a body — to copy and paste when something fails.
struct DiagnosticsSection: View {
    let log: DiagnosticsLog
    @State private var copied = false
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        Section {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 3) {
                        if log.entries.isEmpty {
                            Text("No requests yet.").foregroundStyle(Color.quietText)
                        }
                        ForEach(log.entries) { entry in
                            // Wrapped where it does not fit, never cut; it grows with the text size.
                            Text(entry.line)
                            .foregroundStyle(entry.isFailure ? AnyShapeStyle(Color.failureText) : AnyShapeStyle(.primary))
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .id(entry.id)
                        }
                    }
                    .font(.system(Self.lineStyle, design: .monospaced))
                    .textSelection(.enabled)
                    .padding(.vertical, 4)
                }
                .frame(height: 200)
                .onAppear { if let last = log.entries.last { proxy.scrollTo(last.id, anchor: .bottom) } }
                .onChange(of: log.entries.count) { if let last = log.entries.last { proxy.scrollTo(last.id, anchor: .bottom) } }
            }
            .accessibilityLabel("Recent requests")
            let row = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 10)) : AnyLayout(HStackLayout())
            row {
                Button(copied ? "Copied" : "Copy All") {
                    Self.copy(log.text)
                    copied = true
                    Task {
                        try? await Task.sleep(for: .seconds(2))
                        copied = false
                    }
                }
                .accessibilityHint("Copies the list so you can paste it")
                Button("Clear") { log.clear() }
                    .disabled(log.entries.isEmpty)
                if !typeSize.isAccessibilitySize { Spacer() }
                Text(log.failureCount == 0 ? "\(log.entries.count) lines" : "\(log.entries.count) lines, \(log.failureCount) failed")
                    .font(.footnote)
                    .foregroundStyle(Color.quietText)
                    .accessibilityIdentifier("diagnostics.count")
            }
            #if os(iOS)
            // Two buttons share this row: without their own style a tap anywhere in an iOS
            // list row presses every button in it — Copy All also cleared the list.
            .buttonStyle(.borderless)
            #endif
        } header: {
            Text("Diagnostics")
        } footer: {
            Text("Development builds only. The last \(log.capacity) requests this app made: time, method, path, status and the server's error code. No sign-in tokens and no message text. Kept in memory until the app quits.")
        }
    }

    private static var lineStyle: Font.TextStyle {
        #if os(iOS)
        .caption2
        #else
        .caption
        #endif
    }

    private static func copy(_ text: String) {
        #if os(macOS)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        #else
        UIPasteboard.general.string = text
        #endif
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
                .disabled(app.session == nil || PrivacyLock.shared.locked)
        }
        CommandGroup(after: .textEditing) {
            Button("Search Threads") { app.session?.requestSearch() }
                .keyboardShortcut("f", modifiers: .command)
                .disabled(app.session == nil || PrivacyLock.shared.locked)
        }
        CommandMenu("Thread") {
            Button("Stop") { Task { await app.session?.stopCurrentTurn() } }
                .keyboardShortcut(".", modifiers: .command)
                .disabled(PrivacyLock.shared.locked || !(app.session?.canStopCurrentTurn ?? false))
            Button("Refresh") {
                Task { await app.session?.refreshVisible() }
            }
            .keyboardShortcut("r", modifiers: .command)
            .disabled(app.session == nil || PrivacyLock.shared.locked)
        }
    }
}
