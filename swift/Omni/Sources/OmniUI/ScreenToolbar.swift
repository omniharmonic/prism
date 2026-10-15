import OmniCore
import SwiftUI

/// The bar every top-level screen shares (Today, Needs you, Threads, Recurring), in its
/// trailing corner: Voice, then New Chat — the primary action, last, where the eye ends.
/// Inside a thread, `ThreadView` puts its own Voice (voice in *this* thread) beside the same
/// New Chat.
///
/// It sits on the content, not the sidebar, so on an iPad or a Mac it stays when the sidebar
/// is put away. Settings is not here: on an iPhone it is the leading item of each tab's first
/// screen (`SettingsToolbarButton`); on an iPad it is in the sidebar's bar; on the Mac it is
/// Omni → Settings (⌘,). Refresh is pull-to-refresh on iPhone and iPad; the Mac, which has
/// none, keeps a Refresh button (and ⌘R).
struct ScreenActions: ViewModifier {
    let session: SessionModel

    func body(content: Content) -> some View {
        content.toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                VoiceToolbarButton { session.requestNewVoice() }
                    .accessibilityIdentifier("voice.new")
                NewChatButton(session: session)
            }
        }
    }
}

extension View {
    /// Voice and New Chat in the bar (see `ScreenActions`).
    func screenActions(_ session: SessionModel) -> some View { modifier(ScreenActions(session: session)) }
}

/// "New Chat": the new-chat composer, from wherever the person is (⌘N on the Mac).
struct NewChatButton: View {
    let session: SessionModel

    var body: some View {
        Button {
            session.requestNewThread()
        } label: {
            Label("New Chat", systemImage: "square.and.pencil")
        }
        .help("New chat (⌘N)")
        .accessibilityLabel("New Chat")
        .accessibilityIdentifier("thread.new")
    }
}

struct VoiceToolbarButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Label("Voice", systemImage: "waveform")
        }
        .help("Talk to Omni")
        .accessibilityLabel("Voice")
        .accessibilityHint("Starts a voice conversation")
    }
}

#if os(macOS)
/// Refresh, on the Mac only: iPhone and iPad pull the list down instead.
struct MacRefreshButton: ToolbarContent {
    let refreshing: Bool
    let action: () -> Void

    var body: some ToolbarContent {
        ToolbarItem {
            if refreshing {
                ProgressView().controlSize(.small).accessibilityLabel("Refreshing")
            } else {
                Button(action: action) { Label("Refresh", systemImage: "arrow.clockwise") }
                    .help("Refresh (⌘R)")
            }
        }
    }
}
#endif

#if os(iOS)
/// Settings, as the leading item of an iPhone tab's first screen.
struct SettingsToolbarButton: ToolbarContent {
    @Binding var isPresented: Bool

    var body: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) {
            Button {
                isPresented = true
            } label: {
                Label("Settings", systemImage: "gearshape")
            }
            .accessibilityIdentifier("settings.open")
        }
    }
}
#endif
