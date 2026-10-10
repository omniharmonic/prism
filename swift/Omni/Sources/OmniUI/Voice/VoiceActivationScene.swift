import Foundation
import OmniCore
import SwiftUI

private struct VoiceActivationSceneKey: EnvironmentKey {
    static let defaultValue: UUID? = nil
}
extension EnvironmentValues {
    var voiceActivationSceneID: UUID? {
        get { self[VoiceActivationSceneKey.self] }
        set { self[VoiceActivationSceneKey.self] = newValue }
    }
}

/// Each root owns its readiness. A Settings window cannot start a microphone session.
struct VoiceActivationScene: ViewModifier {
    let app: AppModel
    @State private var id = UUID()
    @Environment(\.scenePhase) private var phase
    func body(content: Content) -> some View {
        content.environment(\.voiceActivationSceneID, id)
            .onAppear { update() }
            .onChange(of: phase) { update() }
            .onChange(of: app.phase) { update() }
            .onChange(of: PrivacyLock.shared.locked) { update() }
            .onDisappear { VoiceActivationCoordinator.shared.removeScene(id) }
    }
    private func update() {
        VoiceActivationCoordinator.shared.updateScene(id, app: app, active: phase == .active, locked: PrivacyLock.shared.locked)
    }
}
