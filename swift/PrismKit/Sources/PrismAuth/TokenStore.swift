import Foundation
import Security
import os

/// Where the device token (`pd_…`) lives, one per server origin. Implementations must
/// never log, print or include the token in an error.
public protocol TokenStore: Sendable {
    func token(for origin: ServerOrigin) throws -> String?
    func setToken(_ token: String, for origin: ServerOrigin) throws
    func removeToken(for origin: ServerOrigin) throws
}

public enum TokenStoreError: Error, Equatable, Sendable {
    /// A Security.framework status (e.g. -34018 = missing entitlement). Never the secret.
    case keychain(status: Int32)
    case notUTF8
}

/// A process-memory store for tests and previews. Nothing is persisted.
public final class InMemoryTokenStore: TokenStore {
    private let tokens = OSAllocatedUnfairLock<[ServerOrigin: String]>(initialState: [:])

    public init() {}

    public func token(for origin: ServerOrigin) throws -> String? { tokens.withLock { $0[origin] } }
    public func setToken(_ token: String, for origin: ServerOrigin) throws { tokens.withLock { $0[origin] = token } }
    public func removeToken(for origin: ServerOrigin) throws { tokens.withLock { $0[origin] = nil } }
}

/// The Keychain store. One generic-password item per server origin:
/// `service` = the app's identifier, `account` = the origin. The item is
/// non-synchronizable (never iCloud Keychain) and
/// `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`: it never leaves this device and is
/// readable after the first unlock since boot (so a launch from a push works while the
/// device is locked). No biometric ACL: the app lock is a UI concern.
/// Ported from `apps/client/src-tauri/src/secure_store.rs`.
///
/// macOS: the this-device-only class only exists in the data-protection keychain, which
/// needs a signed app with an application identifier (an unsigned binary gets -34018).
/// Pass `useDataProtectionKeychain: false` to fall back to the login keychain in such a
/// development build — the caller's explicit choice, never a silent fallback.
public struct KeychainTokenStore: TokenStore {
    public let service: String
    public let accessGroup: String?
    public let useDataProtectionKeychain: Bool

    public init(service: String, accessGroup: String? = nil, useDataProtectionKeychain: Bool = true) {
        self.service = service
        self.accessGroup = accessGroup
        self.useDataProtectionKeychain = useDataProtectionKeychain
    }

    private func baseQuery(_ origin: ServerOrigin) -> [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: origin.value,
            kSecAttrSynchronizable as String: false,
        ]
        if useDataProtectionKeychain { q[kSecUseDataProtectionKeychain as String] = true }
        if let accessGroup { q[kSecAttrAccessGroup as String] = accessGroup }
        return q
    }

    public func token(for origin: ServerOrigin) throws -> String? {
        var q = baseQuery(origin)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw TokenStoreError.keychain(status: status) }
        guard let data = out as? Data, let s = String(data: data, encoding: .utf8) else { throw TokenStoreError.notUTF8 }
        return s
    }

    public func setToken(_ token: String, for origin: ServerOrigin) throws {
        // Replace rather than update: never a stale duplicate, always the current attributes.
        try removeToken(for: origin)
        var q = baseQuery(origin)
        q[kSecValueData as String] = Data(token.utf8)
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        q[kSecAttrLabel as String] = "Prism device token"
        q[kSecAttrDescription as String] = "Sign-in for \(origin.value) (revocable in Prism → Account → Devices)"
        let status = SecItemAdd(q as CFDictionary, nil)
        guard status == errSecSuccess else { throw TokenStoreError.keychain(status: status) }
    }

    public func removeToken(for origin: ServerOrigin) throws {
        let status = SecItemDelete(baseQuery(origin) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw TokenStoreError.keychain(status: status) }
    }
}
