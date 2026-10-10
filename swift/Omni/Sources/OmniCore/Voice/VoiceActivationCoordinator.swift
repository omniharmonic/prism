import Foundation

/// A foreground shortcut is a short-lived invitation to listen, never a durable launch flag.
/// Readiness comes from the mounted root and navigation views, not from intent execution.
@MainActor public final class VoiceActivationCoordinator {
    public static let shared = VoiceActivationCoordinator()
    public private(set) var pendingID: UUID?
    private var deadline: Date?
    private var expiry: Task<Void, Never>?
    private weak var routedSession: SessionModel?
    private let now: () -> Date
    private let lifetime: TimeInterval
    private struct Scene {
        weak var app: AppModel?
        weak var navigation: SessionModel?
        var active: Bool
        var locked: Bool
    }
    private var scenes: [UUID: Scene] = [:]

    public init(lifetime: TimeInterval = 60, now: @escaping () -> Date = Date.init) {
        self.lifetime = lifetime; self.now = now
    }

    /// Coalesce presses while launch, authentication, navigation or permission is pending.
    public func request() {
        expireIfNeeded()
        if let pendingID, let routedSession, routedSession.pendingVoiceActivationID != pendingID { cancel() }
        guard pendingID == nil else { return }
        let id = UUID()
        pendingID = id; deadline = now().addingTimeInterval(lifetime)
        expiry = Task { [weak self, lifetime] in
            try? await Task.sleep(for: .seconds(lifetime))
            guard !Task.isCancelled, self?.pendingID == id else { return }
            self?.cancel()
        }
        deliver()
    }

    public func updateScene(_ id: UUID, app: AppModel, active: Bool, locked: Bool) {
        let navigation = scenes[id]?.navigation
        scenes[id] = Scene(app: app, navigation: navigation, active: active, locked: locked)
        // Before routing, allow foreground launch and the browser sign-in/unlock flow.
        // After routing, lock or loss of foreground revokes the microphone invitation.
        if let routedSession, navigation === routedSession, (!active || locked || app.session !== routedSession) { cancel() }
        deliver()
    }

    public func navigationAppeared(_ session: SessionModel, sceneID: UUID) {
        if scenes[sceneID] == nil {
            scenes[sceneID] = Scene(app: nil, navigation: session, active: false, locked: true)
        } else { scenes[sceneID]?.navigation = session }
        deliver()
    }

    public func navigationDisappeared(_ session: SessionModel, sceneID: UUID) {
        if scenes[sceneID]?.navigation === session { scenes[sceneID]?.navigation = nil }
        if routedSession === session { cancel() }
    }

    public func removeScene(_ id: UUID) {
        if let routedSession, scenes[id]?.navigation === routedSession { cancel() }
        scenes[id] = nil
    }

    /// Only the matching, mounted voice view may consume the invitation, exactly once.
    public func consume(session: SessionModel, sceneID: UUID?, threadID: String?) -> Bool {
        expireIfNeeded()
        guard let id = pendingID, routedSession === session,
              let sceneID, let scene = scenes[sceneID], scene.active, !scene.locked,
              scene.app?.phase == .signedIn, scene.app?.session === session,
              scene.navigation === session,
              session.consumeVoiceActivation(id, threadID: threadID) else { return false }
        complete()
        return true
    }

    public func cancel() {
        if let id = pendingID { routedSession?.cancelVoiceActivation(id) }
        complete()
    }

    public func expireIfNeeded() {
        if let deadline, now() >= deadline { cancel() }
    }

    private func complete() {
        expiry?.cancel(); expiry = nil; pendingID = nil; deadline = nil; routedSession = nil
    }

    private func deliver() {
        expireIfNeeded()
        guard let id = pendingID else { return }
        if let routedSession {
            if routedSession.pendingVoiceActivationID != id { cancel() }
            return
        }
        guard let scene = scenes.values.first(where: {
            $0.active && !$0.locked && $0.app?.phase == .signedIn && $0.navigation != nil && $0.app?.session === $0.navigation
        }), let session = scene.navigation else { return }
        routedSession = session
        if !session.routeVoiceActivation(id) { complete() }
    }
}
