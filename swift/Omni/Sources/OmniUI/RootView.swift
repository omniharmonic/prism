import OmniCore
import SwiftUI

/// The whole app: which of first-run, can't-reach, sign-in or the main window to show.
public struct RootView: View {
    @Bindable private var app: AppModel

    public init(app: AppModel) {
        self.app = app
    }

    public var body: some View {
        Group {
            switch app.phase {
            case .needsServer:
                ServerSetupView(app: app)
            case .connecting:
                StatusScreen(symbol: "network", title: "Looking for the server…", message: app.origin?.value) {
                    ProgressView().controlSize(.small).accessibilityLabel("Connecting")
                }
            case .unreachable(let message):
                StatusScreen(symbol: "wifi.exclamationmark", title: "Can't connect", message: message) {
                    Button("Try Again") { Task { await app.connect() } }
                        .keyboardShortcut(.defaultAction)
                        .accessibilityHint("Looks for the server again")
                    Button("Change Server…") { Task { await app.changeServer() } }
                    if let origin = app.origin {
                        Text(origin.value).font(.footnote).foregroundStyle(.secondary).textSelection(.enabled)
                            .accessibilityLabel("Server address: \(origin.value)")
                    }
                }
            case .signedOut(let notice):
                SignInView(app: app, notice: notice)
            case .signingIn:
                StatusScreen(symbol: "safari", title: "Finish signing in in your browser", message: "Approve this device there, then come back. Nothing else is needed here.") {
                    ProgressView().controlSize(.small).accessibilityLabel("Waiting for the browser")
                    Button("Cancel") { app.cancelSignIn() }
                        .keyboardShortcut(.cancelAction)
                        .accessibilityHint("Stops waiting for the browser")
                }
            case .signedIn:
                if let session = app.session {
                    MainView(app: app, session: session)
                }
            }
        }
        #if DEBUG
        .modifier(UITestCompactWidth())
        #endif
        .task { await app.start() }
        #if os(macOS)
        // Sign-in ends in the browser: bring Omni back to the front when it has worked, so
        // the last thing on screen is the app, signed in — not a browser tab.
        .onChange(of: app.phase) { old, new in
            if new == .signedIn, old == .signingIn || old == .signedOut(notice: nil) { NSApplication.shared.activate() }
        }
        #endif
    }
}

/// A centred icon, title, message and a few controls: every not-in-the-app-yet screen.
struct StatusScreen<Actions: View>: View {
    let symbol: String
    let title: String
    let message: String?
    @ViewBuilder var actions: Actions

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: symbol)
                .font(.system(size: 40, weight: .light))
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            Text(title).font(.title2.weight(.semibold)).multilineTextAlignment(.center)
            if let message {
                Text(message).foregroundStyle(.secondary).multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
            }
            actions
        }
        #if os(iOS)
        .controlSize(.large)
        #endif
        .frame(maxWidth: 420)
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// First run: which server?
struct ServerSetupView: View {
    @Bindable var app: AppModel
    @FocusState private var focused: Bool

    var body: some View {
        StatusScreen(symbol: "leaf", title: "Welcome to Omni", message: "Enter the address of your Prism Server. Omni talks only to that server.") {
            TextField("https://prism.example.com", text: $app.serverText)
                .textFieldStyle(.roundedBorder)
                .focused($focused)
                .autocorrectionDisabled()
                #if os(iOS)
                .textInputAutocapitalization(.never)
                .keyboardType(.URL)
                .textContentType(.URL)
                #endif
                .onSubmit { Task { await app.submitServer() } }
                .accessibilityLabel("Server address")
            if let error = app.serverError {
                Label(error, systemImage: "exclamationmark.triangle")
                    .font(.callout)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("server.error")
            }
            Button("Continue") { Task { await app.submitServer() } }
                .keyboardShortcut(.defaultAction)
                .buttonStyle(.borderedProminent)
                .accessibilityHint("Checks the server and goes to sign-in")
        }
        .onAppear { focused = true }
    }
}

struct SignInView: View {
    let app: AppModel
    let notice: String?

    var body: some View {
        StatusScreen(symbol: "person.badge.key", title: "Sign in to Omni", message: "Your browser opens so you can approve this device with your Prism account. Omni is for the server's owner.") {
            if let notice {
                Text(notice).font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
            }
            Button("Sign In") { app.signIn() }
                .keyboardShortcut(.defaultAction)
                .buttonStyle(.borderedProminent)
                .accessibilityHint("Opens your browser to approve this device")
            if let origin = app.origin {
                Text(origin.value).font(.footnote).foregroundStyle(.secondary).textSelection(.enabled)
                    .accessibilityLabel("Server address: \(origin.value)")
            }
            Button("Change Server…") { Task { await app.changeServer() } }
                .buttonStyle(.borderless)
        }
    }
}
