import Foundation
import LocalAuthentication
import OmniClient
import PrismAuth
import PrismTransport

/// The real implementations behind the protocols in `Support/OmniService.swift`.
public enum OmniLive {
    /// The Keychain service name (also the app's bundle id).
    public static let keychainService = "com.benjaminlife.omni"

    /// Where the device token lives.
    ///
    /// - Parameter developmentBuild: a macOS build without a provisioned application
    ///   identifier (ad-hoc or "Sign to Run Locally") cannot use the data-protection
    ///   keychain (-34018), so a development build uses the login keychain instead. This is
    ///   the caller's explicit choice per PrismKit's `KeychainTokenStore`; a release build
    ///   passes false.
    public static func tokenStore(developmentBuild: Bool) -> any TokenStore {
        #if os(macOS)
        return KeychainTokenStore(service: keychainService, useDataProtectionKeychain: !developmentBuild)
        #else
        return KeychainTokenStore(service: keychainService)
        #endif
    }

    /// One `PrismClient` + `OmniClient` + `DeviceSignIn` per server origin, all on the
    /// `omni-native` client.
    public static func environmentFactory(tokenStore: any TokenStore, flow: any RedirectFlow, userAgent: String = "Omni/1") -> EnvironmentFactory {
        { origin, onSignedOut in
            let transport = PrismClient(origin: origin, tokenStore: tokenStore, userAgent: userAgent, onSignedOut: onSignedOut)
            let signIn = DeviceSignIn(origin: origin, configuration: .omniNative, tokenStore: tokenStore)
            return ServerEnvironment(
                service: LiveOmniService(client: OmniClient(transport: transport)),
                auth: DeviceSessionAuth(signIn: signIn, flow: flow)
            )
        }
    }
}

/// `DeviceSignIn` + the platform's browser leg.
public struct DeviceSessionAuth: SessionAuth {
    let signIn: DeviceSignIn
    let flow: any RedirectFlow

    public init(signIn: DeviceSignIn, flow: any RedirectFlow) {
        self.signIn = signIn
        self.flow = flow
    }

    public var hasToken: Bool { signIn.hasToken }

    public func signIn(label: String) async throws {
        try await signIn.signIn(using: flow, label: label)
    }

    public func signOut() async -> SignOutResult {
        await signIn.signOut()
    }
}

/// A credential-free look at `GET /api/omni/version`: an Omni server answers 401 to a
/// stranger, a Prism Server with Omni off answers 404.
public struct LiveServerProbe: ServerProbe {
    private let session: URLSession

    public init(session: URLSession = PrismURLSession.make(requestTimeout: 10)) {
        self.session = session
    }

    public func probe(_ origin: ServerOrigin) async -> ServerProbeResult {
        guard let url = try? origin.url(path: "/api/omni/version") else { return .unreachable("invalid address") }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        do {
            let (_, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else { return .unreachable("no answer") }
            switch http.statusCode {
            case 200, 401: return .ready
            case 404: return .omniOff
            case 500...599: return .unreachable("HTTP \(http.statusCode)")
            default: return .unexpected(status: http.statusCode)
            }
        } catch {
            return .unreachable(prismSanitizedReason(error))
        }
    }
}

/// The server address in `UserDefaults`. Not a secret.
public struct UserDefaultsSettings: SettingsStore {
    private let key: String

    public init(key: String = "omni.serverURL") {
        self.key = key
    }

    public func serverURL() -> String? {
        UserDefaults.standard.string(forKey: key)
    }

    public func setServerURL(_ value: String?) {
        if let value {
            UserDefaults.standard.set(value, forKey: key)
        } else {
            UserDefaults.standard.removeObject(forKey: key)
        }
    }
}

/// Touch ID / Face ID / the device passcode before a send (integration-contract.md § 6:
/// "Send requires Face ID / Touch ID at that moment").
public struct DeviceOwnerConfirmation: SendConfirmation {
    /// What to answer on a device with no passcode or password at all, where there is
    /// nothing to check against (a simulator, a fresh test Mac).
    private let allowWhenUnavailable: Bool

    public init(allowWhenUnavailable: Bool) {
        self.allowWhenUnavailable = allowWhenUnavailable
    }

    public func confirm(reason: String) async -> Bool {
        let context = LAContext()
        var unavailable: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &unavailable) else {
            return allowWhenUnavailable
        }
        return (try? await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)) ?? false
    }
}
