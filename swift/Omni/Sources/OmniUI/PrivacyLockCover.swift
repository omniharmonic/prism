import OmniCore
import SwiftUI

/// Covers every scene, including the Mac Settings window. The underlying content and
/// its accessibility tree are unavailable until the local device owner authenticates.
public struct PrivacyLockCover: ViewModifier {
    @Environment(\.scenePhase) private var phase
    public init() {}

    public func body(content: Content) -> some View {
        content
            .disabled(PrivacyLock.shared.locked)
            .accessibilityHidden(PrivacyLock.shared.locked)
            .overlay {
                if PrivacyLock.shared.locked {
                    StatusScreen(symbol: "lock", title: "Omni is locked", message: PrivacyLock.shared.message) {
                        Button("Unlock") {
                            Task {
                                await PrivacyLock.shared.unlock()
                                if !PrivacyLock.shared.locked { NativeNotifications.shared.deliverPending() }
                            }
                        }
                        .disabled(PrivacyLock.shared.busy)
                        .buttonStyle(.borderedProminent)
                        .keyboardShortcut(.defaultAction)
                    }
                    .background(.background)
                }
            }
            .overlay {
                if PrivacyLock.shared.enabled && phase != .active {
                    Color.clear.background(.background).accessibilityHidden(true)
                }
            }
            .onChange(of: phase) { _, phase in
                #if os(macOS)
                if phase != .active && !PrivacyLock.shared.busy { PrivacyLock.shared.lock() }
                #else
                if phase == .background { PrivacyLock.shared.lock() }
                #endif
            }
    }
}
