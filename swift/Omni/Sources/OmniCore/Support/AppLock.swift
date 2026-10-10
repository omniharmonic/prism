import PrismAuth

public typealias AppLock = PrismAuth.AppLock

/// One lock for every Omni scene. The reusable implementation lives in PrismKit.
@MainActor public enum PrivacyLock {
    public static let shared = AppLock(preferenceKey: "omni.app-lock.enabled", displayName: "Omni")
}
