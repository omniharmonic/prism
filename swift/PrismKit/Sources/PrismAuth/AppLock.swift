import Foundation
import LocalAuthentication
import Observation

/// A reusable, device-local privacy lock. It does not replace the server credential or
/// send confirmation. The system may use biometrics or the device password/passcode.
@MainActor @Observable
public final class AppLock {
    public private(set) var enabled: Bool
    public private(set) var locked: Bool
    public private(set) var busy = false
    public private(set) var message: String?
    private var generation: UInt64 = 0
    private let displayName: String
    private let preferenceKey: String
    private let authentication: (@MainActor (String) async -> Bool)?

    public init(preferenceKey: String, displayName: String = "App", authentication: (@MainActor (String) async -> Bool)? = nil) {
        self.displayName = displayName
        self.authentication = authentication
        self.preferenceKey = preferenceKey
        let saved = UserDefaults.standard.bool(forKey: preferenceKey)
        enabled = saved
        locked = saved
    }

    public var available: Bool {
        LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: nil)
    }

    /// Called when the app leaves the foreground. Its content is covered before the next
    /// active scene, and external navigation remains queued until authentication succeeds.
    public func lock() {
        generation &+= 1
        if enabled { locked = true; message = nil }
    }

    public func unlock() async {
        guard enabled, locked else { return }
        let requestGeneration = generation
        if await authenticate(reason: "Unlock \(displayName) to see your conversations."), generation == requestGeneration { locked = false }
    }

    public func setEnabled(_ value: Bool) async {
        guard value != enabled else { return }
        let requestGeneration = generation
        guard await authenticate(reason: value ? "Turn on the \(displayName) privacy lock." : "Turn off the \(displayName) privacy lock."), generation == requestGeneration else { return }
        enabled = value
        locked = false
        UserDefaults.standard.set(value, forKey: preferenceKey)
    }

    private func authenticate(reason: String) async -> Bool {
        guard !busy else { return false }
        busy = true
        message = nil
        defer { busy = false }
        if let authentication {
            let accepted = await authentication(reason)
            if !accepted { message = "Authentication was not completed. Try again when you're ready." }
            return accepted
        }
        let context = LAContext()
        context.localizedCancelTitle = "Cancel"
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: nil) else {
            message = "Set up a device passcode or password to use the privacy lock."
            return false
        }
        do { return try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) }
        catch {
            message = "Authentication was not completed. Try again when you're ready."
            return false
        }
    }
}
