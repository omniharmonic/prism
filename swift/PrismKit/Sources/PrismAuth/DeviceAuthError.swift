import Foundation

/// Everything that can go wrong during device sign-in / sign-out. No case ever carries a
/// token, code or verifier.
public enum DeviceAuthError: Error, Equatable, Sendable {
    /// The system random source failed.
    case randomUnavailable
    /// The redirect came back to another address than the one this attempt registered.
    case redirectMismatch
    /// The redirect's `state` is missing or not this attempt's.
    case stateMismatch
    /// The server answered `error=<code>` (e.g. `access_denied` when the person pressed Deny).
    case denied(String)
    /// Our state, but no usable code.
    case malformedCallback
    /// The token endpoint answered an OAuth error (`invalid_grant`, `invalid_request`, …).
    case server(code: String, description: String?, status: Int)
    /// The token endpoint answered a non-2xx without an OAuth error body.
    case http(status: Int)
    /// A 2xx that is not `{access_token: "pd_…", token_type: "Bearer"}`.
    case unexpectedTokenResponse
    case unexpectedTokenType
    case unexpectedTokenFormat
    /// The server tried to redirect an auth call; never followed.
    case redirectRefused(status: Int)
    /// The server could not be reached (sanitised reason, no URL).
    case unreachable(String)
    case cancelled
    case timedOut
    /// The loopback listener / browser session could not start.
    case flowUnavailable(String)
    /// A sign-in is already running on this object.
    case alreadyInProgress
    /// The Keychain refused (OSStatus only).
    case tokenStore(String)
}

extension DeviceAuthError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .randomUnavailable: return "Secure randomness is unavailable."
        case .redirectMismatch: return "The sign-in response came back to an unexpected address."
        case .stateMismatch: return "The sign-in response didn't match this attempt; try again."
        case .denied(let e): return e == "access_denied" ? "Sign-in was denied in the browser." : "Sign-in failed (\(e))."
        case .malformedCallback: return "The sign-in response was malformed."
        case .server(let code, let desc, _): return desc.map { "Sign-in failed: \(code) (\($0))" } ?? "Sign-in failed: \(code)"
        case .http(let status): return "Sign-in failed: HTTP \(status)"
        case .unexpectedTokenResponse: return "Unexpected token response."
        case .unexpectedTokenType: return "Unexpected token type."
        case .unexpectedTokenFormat: return "The server returned an unexpected token format."
        case .redirectRefused(let status): return "The server answered a redirect (HTTP \(status)); it was not followed."
        case .unreachable(let why): return "Could not reach the server: \(why)"
        case .cancelled: return "Sign-in was cancelled."
        case .timedOut: return "Sign-in timed out; please try again."
        case .flowUnavailable(let why): return "Sign-in could not start: \(why)"
        case .alreadyInProgress: return "A sign-in is already in progress."
        case .tokenStore(let why): return "Keychain: \(why)"
        }
    }
}
