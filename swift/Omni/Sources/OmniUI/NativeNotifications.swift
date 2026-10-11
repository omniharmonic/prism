import Foundation
import Observation
import OmniCore
import UserNotifications
#if os(iOS)
import UIKit
#elseif os(macOS)
import AppKit
#endif

/// Permission is requested only by the Settings action. Existing opt-in can reconnect
/// after sign-in; a device credential revoke also removes registration on the server.
@MainActor @Observable
public final class NativeNotifications: NSObject, UNUserNotificationCenterDelegate {
    public static let shared = NativeNotifications()
    public private(set) var status = "Notifications are off."
    public enum Preview: String, CaseIterable, Identifiable {
        case generic, title, titlePreview = "title_preview"
        public var id: String { rawValue }
        public var label: String {
            switch self {
            case .generic: "Generic update"
            case .title: "Thread title"
            case .titlePreview: "Thread title and short reply preview"
            }
        }
    }
    public private(set) var preview = Preview(rawValue: UserDefaults.standard.string(forKey: "omni.notifications.preview") ?? "generic") ?? .generic
    public private(set) var busy = false
    public private(set) var enabled = UserDefaults.standard.bool(forKey: "omni.notifications.enabled")
    @ObservationIgnored private weak var app: AppModel?
    @ObservationIgnored private var token: String?
    @ObservationIgnored private let registrationQueue = PushRegistrationQueue()
    @ObservationIgnored private var navigation = ExternalNavigationQueue()
    @ObservationIgnored private weak var readySession: SessionModel?

    private override init() { super.init() }

    public func attach(_ app: AppModel) {
        self.app = app
        UNUserNotificationCenter.current().delegate = self
    }

    public func enable() async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        guard PushEnvironment.signed() != nil else {
            status = "This build does not have the signed push capability."
            return
        }
        do {
            let granted = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound])
            guard granted else {
                status = "Notifications are denied. You can allow them in system Settings."
                return
            }
            enabled = true
            UserDefaults.standard.set(true, forKey: "omni.notifications.enabled")
            await reconnect()
        } catch { status = "Could not request notification permission. Try again." }
    }

    public func disable() async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            _ = try await registrationQueue.run { [self] in
                try await app?.unregisterPush()
                enabled = false
                UserDefaults.standard.set(false, forKey: "omni.notifications.enabled")
                token = nil
                return true
            }
            #if os(iOS)
            UIApplication.shared.unregisterForRemoteNotifications()
            #elseif os(macOS)
            NSApplication.shared.unregisterForRemoteNotifications()
            #endif
            status = "Notifications are off."
        } catch { status = "Could not remove registration. Try again while connected." }
    }

    public func reconnect() async {
        guard enabled, app?.phase == .signedIn else { return }
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        guard settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional else {
            status = "Notifications are denied. You can allow them in system Settings."
            return
        }
        guard PushEnvironment.signed() != nil else { status = "This build does not have the signed push capability."; return }
        status = "Connecting notifications…"
        #if os(iOS)
        UIApplication.shared.registerForRemoteNotifications()
        #elseif os(macOS)
        NSApplication.shared.registerForRemoteNotifications()
        #endif
        if let token { await register(token) }
    }

    public func receivedToken(_ data: Data) {
        let value = data.map { String(format: "%02x", $0) }.joined()
        token = value
        Task { await register(value) }
    }

    public func registrationFailed() { status = "Push registration failed. Try again while connected." }

    private func register(_ token: String) async {
        guard enabled, let app, app.phase == .signedIn, let environment = PushEnvironment.signed() else { return }
        do {
            let deliveryEnabled = try await registrationQueue.run { [self] in
                // Read preference when this write reaches the front of the queue,
                // after any earlier explicit save has committed locally.
                guard enabled, app.phase == .signedIn else { return false }
                return try await app.registerPush(token: token, environment: environment, preview: preview.rawValue)
            }
            if enabled { status = deliveryEnabled ? "Notifications are on." : "Registration saved. Server notifications are off." }
        } catch { status = "Could not connect notifications. Try again while connected." }
    }

    public func setPreview(_ value: Preview) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        if enabled {
            guard let token, let app, app.phase == .signedIn, let environment = PushEnvironment.signed() else {
                status = "Reconnect notifications before changing the preview."
                return
            }
            do {
                let deliveryEnabled = try await registrationQueue.run { [self] in
                    let result = try await app.registerPush(token: token, environment: environment, preview: value.rawValue)
                    // Commit before the queue releases the next reconnect write.
                    preview = value
                    UserDefaults.standard.set(value.rawValue, forKey: "omni.notifications.preview")
                    return result
                }
                status = deliveryEnabled ? "Notifications are on." : "Preview saved. Server notifications are off."
            } catch {
                status = "Could not save the preview. Try again while connected."
                return
            }
        }
        if !enabled {
            preview = value
            UserDefaults.standard.set(value.rawValue, forKey: "omni.notifications.preview")
            status = "Preview saved. Notifications are off."
        }
    }

    public func open(_ url: URL) {
        guard navigation.receive(url) else { return }
        deliverPending()
    }

    public func navigationAppeared(_ session: SessionModel) {
        readySession = session
        deliverPending()
    }

    public func navigationDisappeared(_ session: SessionModel) {
        if readySession === session { readySession = nil }
    }

    public func deliverPending() {
        guard let app, let session = app.session,
              let destination = navigation.take(signedIn: app.phase == .signedIn,
                unlocked: !PrivacyLock.shared.locked, navigationReady: readySession === session) else { return }
        session.openExternal(destination)
    }

    nonisolated public func userNotificationCenter(_ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping @Sendable () -> Void) {
        let value = response.notification.request.content.userInfo["url"] as? String
        Task { @MainActor in
            completeResponse(value, completion: completionHandler)
        }
    }

    func completeResponse(_ value: String?, completion: @MainActor () -> Void) {
        if let value, let url = URL(string: value) { open(url) }
        // UIKit performs snapshot/restoration work from this completion.
        // Complete exactly once on main, without waiting for auth or network.
        completion()
    }
}
