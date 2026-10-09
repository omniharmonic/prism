import CryptoKit
import Foundation
import Security

/// Which registered client and custom-scheme redirect the device flow uses.
///
/// The server (`apps/server/src/auth/device.ts`) knows ONE client id today,
/// `prism-native`, and `DEVICE_REDIRECT_URIS` defaults to `prism://auth/callback`.
/// `docs/omni-module.md` lists `omni://auth/callback` + an `omni-native` client id as
/// "not built yet", so ``prismNative`` is the default and ``omniNative`` is a seam.
public struct DeviceAuthConfiguration: Sendable, Equatable {
    public var clientID: String
    /// The custom-scheme redirect handed to `ASWebAuthenticationSession` (iOS path).
    public var redirectURI: String
    /// Its scheme, for `ASWebAuthenticationSession(callbackURLScheme:)`.
    public var callbackScheme: String

    public init(clientID: String, redirectURI: String, callbackScheme: String) {
        self.clientID = clientID
        self.redirectURI = redirectURI
        self.callbackScheme = callbackScheme
    }

    /// Works against today's server.
    public static let prismNative = DeviceAuthConfiguration(clientID: "prism-native", redirectURI: "prism://auth/callback", callbackScheme: "prism")
    /// TODO(omni): usable only once the server registers `omni-native` and
    /// `omni://auth/callback` (docs/omni-module.md § Not built yet).
    public static let omniNative = DeviceAuthConfiguration(clientID: "omni-native", redirectURI: "omni://auth/callback", callbackScheme: "omni")
}

/// One sign-in attempt's secrets. The verifier leaves the process only in the token
/// POST; the challenge and state only in the authorize URL. Never logged.
public struct PKCESession: Sendable, CustomStringConvertible, CustomDebugStringConvertible {
    public let verifier: String
    public let challenge: String
    public let state: String

    public init() throws {
        let verifier = try PKCE.randomToken()
        self.verifier = verifier
        self.challenge = PKCE.challengeS256(verifier)
        self.state = try PKCE.randomToken()
    }

    /// For tests and vectors.
    public init(verifier: String, state: String) {
        self.verifier = verifier
        self.challenge = PKCE.challengeS256(verifier)
        self.state = state
    }

    public var description: String { "PKCESession(<redacted>)" }
    public var debugDescription: String { description }
}

/// What the authorization server sent back to the redirect URI.
public enum CallbackOutcome: Equatable, Sendable {
    /// `code` with a matching `state`.
    case code(String)
    /// `error=…` with a matching `state` (e.g. the person pressed Deny). Sanitised.
    case denied(String)
    /// Missing or different `state`: not ours (or forged). Ignore it.
    case stateMismatch
    /// Our state, but neither a usable `code` nor an `error`.
    case malformed
}

/// PKCE (RFC 7636, S256 only) and the pure pieces of the device sign-in flow
/// (docs/native-auth.md). Ported from `apps/client/src-tauri/src/pkce.rs`.
public enum PKCE {
    /// 32 random bytes, base64url without padding (43 characters).
    public static func randomToken() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        guard status == errSecSuccess else { throw DeviceAuthError.randomUnavailable }
        return base64URL(Data(bytes))
    }

    /// `BASE64URL(SHA256(ascii(verifier)))`.
    public static func challengeS256(_ verifier: String) -> String {
        base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
    }

    public static func base64URL(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    /// `GET {origin}/auth/device/authorize?…` for the system browser. The verifier is
    /// never part of it.
    public static func authorizeURL(origin: ServerOrigin, configuration: DeviceAuthConfiguration, redirectURI: String, session: PKCESession, label: String) throws -> URL {
        try origin.url(path: "/auth/device/authorize", query: [
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "client_id", value: configuration.clientID),
            URLQueryItem(name: "redirect_uri", value: redirectURI),
            URLQueryItem(name: "code_challenge", value: session.challenge),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
            URLQueryItem(name: "state", value: session.state),
            URLQueryItem(name: "label", value: deviceLabel(label)),
        ])
    }

    /// The consent-page label: printable, at most 80 characters (the server's limit).
    public static func deviceLabel(_ raw: String) -> String {
        let cleaned = String(String.UnicodeScalarView(raw.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) }))
            .trimmingCharacters(in: .whitespaces)
        return String(cleaned.prefix(80))
    }

    /// Constant-time string equality (for `state`).
    public static func constantTimeEquals(_ a: String, _ b: String) -> Bool {
        let x = Array(a.utf8), y = Array(b.utf8)
        guard x.count == y.count else { return false }
        var acc: UInt8 = 0
        for i in 0..<x.count { acc |= x[i] ^ y[i] }
        return acc == 0
    }

    /// Parse the redirect's query string and check `state`. First occurrence of a
    /// parameter wins.
    public static func parseCallbackQuery(_ query: String, expectedState: String) -> CallbackOutcome {
        var code: String?, state: String?, error: String?
        for (k, v) in FormEncoding.decode(query) {
            switch k {
            case "code" where code == nil: code = v
            case "state" where state == nil: state = v
            case "error" where error == nil: error = v
            default: break
            }
        }
        guard let state, !expectedState.isEmpty, constantTimeEquals(state, expectedState) else { return .stateMismatch }
        if let error { return .denied(sanitizeError(error)) }
        guard let code, !code.isEmpty, code.utf8.count <= 512 else { return .malformed }
        return .code(code)
    }

    /// The authorization code from the URL a redirect delivered. The URL must be EXACTLY
    /// the registered redirect (scheme, host, path) plus a query carrying our `state`;
    /// anything else is refused, never half-trusted.
    public static func codeFromRedirect(_ returned: String, redirectURI: String, expectedState: String) throws -> String {
        let base: Substring, query: Substring
        if let q = returned.firstIndex(of: "?") {
            base = returned[..<q]
            query = returned[returned.index(after: q)...]
        } else {
            base = Substring(returned)
            query = ""
        }
        guard base == redirectURI, !returned.contains("#") else { throw DeviceAuthError.redirectMismatch }
        switch parseCallbackQuery(String(query), expectedState: expectedState) {
        case .code(let c): return c
        case .denied(let e): throw DeviceAuthError.denied(e)
        case .stateMismatch: throw DeviceAuthError.stateMismatch
        case .malformed: throw DeviceAuthError.malformedCallback
        }
    }

    /// Keep server-supplied error codes printable and short before showing them.
    static func sanitizeError(_ e: String) -> String {
        String(e.unicodeScalars.filter { $0.isASCII && (CharacterSet.alphanumerics.contains($0) || $0 == "_" || $0 == "-") }.prefix(64).map(Character.init))
    }
}
