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
    public private(set) var busy = false
    public private(set) var enabled = UserDefaults.standard.bool(forKey: "omni.notifications.enabled")
    @ObservationIgnored private weak var app: AppModel?
    @ObservationIgnored private var token: String?
    @ObservationIgnored private var pendingURL: URL?

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
            try await app?.unregisterPush()
            enabled = false
            UserDefaults.standard.set(false, forKey: "omni.notifications.enabled")
            token = nil
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
            let deliveryEnabled = try await app.registerPush(token: token, environment: environment)
            status = deliveryEnabled ? "Notifications are on." : "Registration saved. Server notifications are off."
        } catch { status = "Could not connect notifications. Try again while connected." }
    }

    public func open(_ url: URL) {
        guard url.scheme == "omni", ["thread", "approval", "nudge"].contains(url.host),
              url.pathComponents.count == 2, !url.pathComponents[1].isEmpty else { return }
        pendingURL = url
        deliverPending()
    }

    public func deliverPending() {
        guard !PrivacyLock.shared.locked, let session = app?.session, let url = pendingURL else { return }
        pendingURL = nil
        session.openExternal(url.host == "thread" ? .thread(url.pathComponents[1]) : .needsYou)
    }

    nonisolated public func userNotificationCenter(_ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse) async {
        let value = response.notification.request.content.userInfo["url"] as? String
        if let value, let url = URL(string: value) { await open(url) }
    }
}
