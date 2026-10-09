import Foundation

/// How a sign-out ended. The token is forgotten locally in every case.
public enum SignOutResult: Sendable, Equatable {
    /// The server confirmed the revoke.
    case revoked
    /// There was no token to revoke.
    case notSignedIn
    /// The token was forgotten locally but the server did not confirm the revoke (it stays
    /// listed in Prism → Account → Devices until it expires or is revoked there).
    case forgottenLocally(reason: String)
}

/// Device sign-in (RFC 8252 + PKCE S256) exactly as docs/native-auth.md specifies, and
/// sign-out (revoke + forget). UI-free: the browser leg is a ``RedirectFlow``.
///
/// Every sign-in mints a device on the server, so nothing here starts one by itself —
/// call ``signIn(using:label:)`` only for a person's press. One attempt at a time.
public actor DeviceSignIn {
    public nonisolated let origin: ServerOrigin
    public nonisolated let configuration: DeviceAuthConfiguration
    private nonisolated let tokenStore: any TokenStore
    private nonisolated let client: DeviceAuthClient
    private var inProgress = false

    public init(origin: ServerOrigin, configuration: DeviceAuthConfiguration = .prismNative, tokenStore: any TokenStore, session: URLSession = PrismURLSession.make()) {
        self.origin = origin
        self.configuration = configuration
        self.tokenStore = tokenStore
        self.client = DeviceAuthClient(origin: origin, configuration: configuration, session: session)
    }

    /// Is a token stored for this origin? (Says nothing about whether it is still alive.)
    public nonisolated var hasToken: Bool { ((try? tokenStore.token(for: origin)) ?? nil) != nil }

    /// Run the whole flow and store the token. Returns the credential's metadata (its
    /// description is redacted; the token is already in the store).
    @discardableResult
    public func signIn(using flow: any RedirectFlow, label: String) async throws -> DeviceCredential {
        guard !inProgress else { throw DeviceAuthError.alreadyInProgress }
        inProgress = true
        defer { inProgress = false }

        let pkce = try PKCESession()
        let attempt = try await flow.start()
        let redirectURI = attempt.redirectURI
        let url: URL
        do {
            url = try PKCE.authorizeURL(origin: origin, configuration: configuration, redirectURI: redirectURI, session: pkce, label: label)
        } catch {
            throw DeviceAuthError.flowUnavailable("invalid server address")
        }
        let code = try await attempt.waitForCode(authorizeURL: url, expectedState: pkce.state)
        let credential = try await client.exchange(code: code, verifier: pkce.verifier, redirectURI: redirectURI)
        do {
            try tokenStore.setToken(credential.accessToken, for: origin)
        } catch {
            // Don't leave a live, unstored device token behind on the server.
            try? await client.revoke(token: credential.accessToken)
            throw DeviceAuthError.tokenStore(Self.describe(error))
        }
        return credential
    }

    /// Revoke the token on the server, then forget it. The token is forgotten even when
    /// the server cannot be reached.
    @discardableResult
    public func signOut() async -> SignOutResult {
        let token: String?
        do { token = try tokenStore.token(for: origin) } catch {
            try? tokenStore.removeToken(for: origin)
            return .forgottenLocally(reason: Self.describe(error))
        }
        guard let token else { return .notSignedIn }
        var failure: String?
        do { try await client.revoke(token: token) } catch { failure = (error as? DeviceAuthError)?.errorDescription ?? "revoke failed" }
        do { try tokenStore.removeToken(for: origin) } catch { failure = failure ?? Self.describe(error) }
        return failure.map { .forgottenLocally(reason: $0) } ?? .revoked
    }

    /// Ask the server whether the stored token is still good (`GET /auth/me`).
    public func liveness() async -> TokenLiveness {
        guard let token = (try? tokenStore.token(for: origin)) ?? nil else { return .dead }
        return await client.liveness(of: token)
    }

    private static func describe(_ error: any Error) -> String {
        if case TokenStoreError.keychain(let status) = error { return "status \(status)" }
        return "storage error"
    }
}
