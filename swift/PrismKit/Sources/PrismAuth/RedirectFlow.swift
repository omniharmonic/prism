import Foundation

/// The platform leg of sign-in: get the browser to the authorize URL and the redirect
/// back. Everything else (PKCE, the token exchange, storage) is shared and UI-free, so
/// the core is tested with a fake flow.
///
/// - macOS: ``LoopbackRedirectFlow`` (RFC 8252 §7.3 loopback redirect + system browser).
/// - iOS: ``WebAuthenticationSessionFlow`` (`ASWebAuthenticationSession`).
public protocol RedirectFlow: Sendable {
    /// Prepare one attempt (bind the listener, …) and say which redirect URI it uses.
    func start() async throws -> any RedirectFlowSession
}

public protocol RedirectFlowSession: Sendable {
    /// Goes into the authorize URL and, unchanged, into the token POST.
    var redirectURI: String { get }
    /// Show `authorizeURL`, wait for the redirect, validate it (exact redirect + `state`)
    /// and return the authorization code. Honours task cancellation.
    func waitForCode(authorizeURL: URL, expectedState: String) async throws -> String
}

#if canImport(AuthenticationServices)
import AuthenticationServices

/// `ASWebAuthenticationSession` with the custom-scheme redirect. The session hands the
/// redirect straight back to this app; no URL type has to be registered, so no other
/// app's scheme handler is involved. Non-ephemeral by default: it shares the browser's
/// cookies, which the magic-link login needs (docs/native-auth.md).
public struct WebAuthenticationSessionFlow: RedirectFlow {
    public typealias AnchorProvider = @MainActor @Sendable () -> ASPresentationAnchor

    private let configuration: DeviceAuthConfiguration
    private let prefersEphemeralSession: Bool
    private let anchor: AnchorProvider

    public init(configuration: DeviceAuthConfiguration = .prismNative, prefersEphemeralSession: Bool = false, anchor: @escaping AnchorProvider) {
        self.configuration = configuration
        self.prefersEphemeralSession = prefersEphemeralSession
        self.anchor = anchor
    }

    public func start() async throws -> any RedirectFlowSession {
        Session(configuration: configuration, prefersEphemeralSession: prefersEphemeralSession, anchor: anchor)
    }

    private struct Session: RedirectFlowSession {
        let configuration: DeviceAuthConfiguration
        let prefersEphemeralSession: Bool
        let anchor: AnchorProvider
        var redirectURI: String { configuration.redirectURI }

        func waitForCode(authorizeURL: URL, expectedState: String) async throws -> String {
            let runner = await WebAuthRunner(anchor: anchor)
            let returned = try await runner.run(url: authorizeURL, scheme: configuration.callbackScheme, ephemeral: prefersEphemeralSession)
            return try PKCE.codeFromRedirect(returned.absoluteString, redirectURI: redirectURI, expectedState: expectedState)
        }
    }
}

@MainActor
private final class WebAuthRunner: NSObject, ASWebAuthenticationPresentationContextProviding {
    private let anchor: WebAuthenticationSessionFlow.AnchorProvider
    private var session: ASWebAuthenticationSession?

    init(anchor: @escaping WebAuthenticationSessionFlow.AnchorProvider) {
        self.anchor = anchor
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor { anchor() }

    func run(url: URL, scheme: String, ephemeral: Bool) async throws -> URL {
        let once = ResumeOnce<URL>()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (cont: CheckedContinuation<URL, any Error>) in
                once.set(cont)
                let s = ASWebAuthenticationSession(url: url, callbackURLScheme: scheme) { callback, error in
                    if let callback {
                        once.resume(.success(callback))
                    } else if let e = error as? ASWebAuthenticationSessionError, e.code == .canceledLogin {
                        once.resume(.failure(DeviceAuthError.cancelled))
                    } else {
                        once.resume(.failure(DeviceAuthError.flowUnavailable("the sign-in sheet failed")))
                    }
                }
                s.presentationContextProvider = self
                s.prefersEphemeralWebBrowserSession = ephemeral
                self.session = s
                if !s.start() {
                    once.resume(.failure(DeviceAuthError.flowUnavailable("the sign-in sheet could not be shown")))
                }
            }
        } onCancel: {
            once.resume(.failure(DeviceAuthError.cancelled))
            Task { @MainActor in self.session?.cancel() }
        }
    }
}
#endif

/// Resumes a continuation at most once, from any thread.
final class ResumeOnce<T: Sendable>: Sendable {
    private struct State {
        var continuation: CheckedContinuation<T, any Error>?
        var pending: Result<T, any Error>?
        var done = false
    }
    private let state = OSAllocatedUnfairLock<State>(initialState: State())

    func set(_ c: CheckedContinuation<T, any Error>) {
        let early: Result<T, any Error>? = state.withLock { s in
            if let p = s.pending {
                s.pending = nil
                return p
            }
            s.continuation = c
            return nil
        }
        if let early { c.resume(with: early) }
    }

    func resume(_ r: Result<T, any Error>) {
        let c: CheckedContinuation<T, any Error>? = state.withLock { s in
            guard !s.done else { return nil }
            s.done = true
            if let c = s.continuation {
                s.continuation = nil
                return c
            }
            s.pending = r
            return nil
        }
        c?.resume(with: r)
    }
}

import os
