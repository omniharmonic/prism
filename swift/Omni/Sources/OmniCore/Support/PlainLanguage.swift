import Foundation
import OmniClient
import PrismAuth
import PrismTransport

/// Errors in words a person can act on. Never a URL, a token or a server's raw text.
public enum PlainLanguage {
    /// Is this the "you are signed out" signal? (The token is confirmed dead, or none is stored.)
    public static func isSignedOut(_ error: any Error) -> Bool {
        guard let e = error as? PrismError else { return false }
        return e == .signedOut || e == .notSignedIn
    }

    /// May the request have reached the server? Then a retry must reuse its `Idempotency-Key`.
    public static func outcomeIsUnknown(_ error: any Error) -> Bool {
        guard let e = error as? PrismError else { return !(error is OmniError) && !(error is CancellationError) }
        switch e {
        case .outcomeUnknown, .unauthorized, .decoding: return true
        default: return false
        }
    }

    public static func message(for error: any Error) -> String {
        if let e = error as? PrismError { return message(for: e) }
        if let e = error as? OmniError {
            switch e {
            case .localDigestMismatch: return "This draft doesn't match what the server would send. Nothing was sent."
            case .executorNotReady(let code, _): return executorNotReady(code)
            }
        }
        if let e = error as? DeviceAuthError { return e.errorDescription ?? "Sign-in failed." }
        if error is CancellationError { return "Cancelled." }
        return "Something went wrong. Try again."
    }

    public static func message(for error: PrismError) -> String {
        switch error {
        case .invalidRequest: return "That request couldn't be made."
        case .notSignedIn, .signedOut: return "You're signed out. Sign in again."
        case .unauthorized: return "The server didn't accept this sign-in just now. Try again."
        case .forbidden(let f):
            if f.code == "human_origin_required" { return "Only a person can do this, from a signed-in device." }
            return "This account isn't allowed to use Omni on this server. Omni is for the server's owner."
        case .conflict(let f):
            switch f.code {
            case "digest_mismatch": return "The draft changed on the server. Review the latest version."
            case "already_decided": return "This was already decided."
            case "in_progress": return "This is already being sent."
            default: return "Omni is still working on the last message."
            }
        case .rejected(let f):
            switch (f.status, f.code) {
            case (404, _): return "The server couldn't find that. It may have been removed."
            case (410, _): return "This draft expired."
            case (429, _): return "Too many connections are open. Try again in a moment."
            case (400, "hermes_rejected"): return "The agent refused that message."
            default: return "The server refused that request."
            }
        case .redirectRefused: return "The server tried to send this somewhere else. Check the server address."
        case .unreachable: return "Can't reach the server. Check that it's running and that this Mac is on the right network."
        case .outcomeUnknown(let u):
            switch u.code {
            case "hermes_unavailable", "hermes_timeout": return "The server is up, but it can't reach the agent right now."
            case "hermes_auth", "hermes_not_configured": return "The server isn't set up to talk to the agent."
            default: return "The server didn't answer clearly, so it's not known whether this went through."
            }
        case .decoding: return "The server answered in a way this version of Omni doesn't understand."
        case .tokenStore: return "The Keychain refused. Unlock your keychain and try again."
        }
    }

    /// A turn's `result.errorCode`, in words. `nil` for a turn that worked.
    public static func turnFailure(_ code: String?) -> String {
        switch code {
        case "cancelled": return "Stopped."
        case "auth", "hermes_auth": return "The agent couldn't sign in to its model. Check the model settings on the server."
        case "usage_limit": return "The model's usage limit was reached. Try again later."
        case "budget": return "Today's spending limit was reached."
        case "timeout", "hermes_timeout": return "The agent took too long and was stopped."
        case "iteration_limit": return "The agent stopped after too many steps."
        case "stream_ended", "hermes_unavailable": return "The connection to the agent was lost before it finished."
        case "hermes_not_configured": return "The server isn't set up to talk to the agent."
        case "interrupted": return "The server restarted while the agent was working."
        default: return "The agent couldn't finish that."
        }
    }

    public static func executorNotReady(_ code: String) -> String {
        code == "executor_disabled"
            ? "Sending is switched off on this server — nothing was sent."
            : "This server can't send this kind of thing yet — nothing was sent."
    }

    public static func message(for error: ServerOriginError) -> String {
        switch error {
        case .empty: return "Enter the server address."
        case .notAURL: return "That isn't a web address. It should look like https://prism.example.com."
        case .invalidHost: return "That address has a host name Omni can't use."
        case .unsupportedScheme: return "The address must start with https://."
        case .insecureScheme: return "Use https://. Plain http:// only works for a server on this Mac (127.0.0.1)."
        case .hasUserInfo: return "Leave the user name and password out of the address."
        case .hasQueryOrFragment, .hasPath: return "Use just the server's address, with nothing after the host name."
        case .forbiddenPort: return "That port is the vault, not the Prism Server."
        }
    }

    public static func message(for probe: ServerProbeResult) -> String? {
        switch probe {
        case .ready: return nil
        case .omniOff: return "This server answered, but Omni isn't turned on there."
        case .unexpected: return "Something answered at that address, but it doesn't look like a Prism Server."
        case .unreachable: return "Can't reach the server. Check that it's running and that this device is on the right network."
        }
    }

    public static func signOut(_ result: SignOutResult) -> String {
        switch result {
        case .revoked, .notSignedIn: return "Signed out."
        case .forgottenLocally: return "Signed out here. The server couldn't confirm it, so this device may still be listed in Prism → Account → Devices."
        }
    }
}
