import Foundation

/// What `POST /auth/device/token` returned. Its description never shows the token.
public struct DeviceCredential: Sendable, Equatable, CustomStringConvertible, CustomDebugStringConvertible {
    /// `pd_…` — goes straight into the ``TokenStore``.
    public let accessToken: String
    public let deviceID: String?
    /// Seconds (the 90-day sliding idle window).
    public let expiresIn: Int?

    public init(accessToken: String, deviceID: String?, expiresIn: Int?) {
        self.accessToken = accessToken
        self.deviceID = deviceID
        self.expiresIn = expiresIn
    }

    public var description: String { "DeviceCredential(deviceID: \(deviceID ?? "nil"), token: <redacted>)" }
    public var debugDescription: String { description }
}

/// The answer to "is this token still good?" (`GET /auth/me`).
public enum TokenLiveness: Sendable, Equatable {
    /// 200 + `authenticated: true`.
    case alive
    /// `/auth/me` itself answered 401: forget the token.
    case dead
    /// No answer, 5xx, a proxy page: nothing is concluded, nothing is forgotten.
    case unknown
}

/// The server calls of the device flow: redeem the code, revoke, and ask `/auth/me`.
/// Only ever talks to its origin; redirects are refused. Ported from `auth.rs`.
public struct DeviceAuthClient: Sendable {
    public let origin: ServerOrigin
    public let configuration: DeviceAuthConfiguration
    private let session: URLSession

    /// `session` must not follow redirects — use ``PrismURLSession/make(requestTimeout:configure:)``.
    public init(origin: ServerOrigin, configuration: DeviceAuthConfiguration = .prismNative, session: URLSession = PrismURLSession.make()) {
        self.origin = origin
        self.configuration = configuration
        self.session = session
    }

    /// Redeem an authorization code (PKCE) for a device token.
    public func exchange(code: String, verifier: String, redirectURI: String) async throws -> DeviceCredential {
        let (status, body) = try await postForm("/auth/device/token", [
            ("grant_type", "authorization_code"),
            ("code", code),
            ("code_verifier", verifier),
            ("redirect_uri", redirectURI),
            ("client_id", configuration.clientID),
        ])
        return try Self.parseTokenResponse(status: status, body: body)
    }

    /// Revoke a device token (sign out). The server answers 200 for any token (RFC 7009).
    public func revoke(token: String) async throws {
        let (status, _) = try await postForm("/auth/device/revoke", [("token", token)])
        guard (200..<300).contains(status) else { throw DeviceAuthError.http(status: status) }
    }

    /// Ask `/auth/me` about one token. Never throws: an unclear answer is `.unknown`.
    public func liveness(of token: String) async -> TokenLiveness {
        guard let url = try? origin.url(path: "/auth/me") else { return .unknown }
        var req = URLRequest(url: url)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        guard let (data, resp) = try? await session.data(for: req), let http = resp as? HTTPURLResponse else { return .unknown }
        if http.statusCode == 401 { return .dead }
        guard http.statusCode == 200, let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any], obj["authenticated"] as? Bool == true else { return .unknown }
        return .alive
    }

    private func postForm(_ path: String, _ pairs: [(String, String)]) async throws -> (Int, Data) {
        let url: URL
        do { url = try origin.url(path: path) } catch { throw DeviceAuthError.unreachable("invalid server address") }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.httpBody = Data(FormEncoding.encode(pairs).utf8)
        let data: Data, resp: URLResponse
        do {
            (data, resp) = try await session.data(for: req)
        } catch is CancellationError {
            throw DeviceAuthError.cancelled
        } catch let e as URLError where e.code == .cancelled {
            throw DeviceAuthError.cancelled
        } catch {
            throw DeviceAuthError.unreachable(prismSanitizedReason(error))
        }
        guard let http = resp as? HTTPURLResponse else { throw DeviceAuthError.unexpectedTokenResponse }
        if (300..<400).contains(http.statusCode) { throw DeviceAuthError.redirectRefused(status: http.statusCode) }
        return (http.statusCode, data)
    }

    private struct TokenOK: Decodable {
        let access_token: String
        let token_type: String
        let expires_in: Int?
        let device_id: String?
    }
    private struct OAuthFailure: Decodable {
        let error: String
        let error_description: String?
    }

    /// Interpret the token endpoint's response.
    public static func parseTokenResponse(status: Int, body: Data) throws -> DeviceCredential {
        if (200..<300).contains(status) {
            guard let ok = try? JSONDecoder().decode(TokenOK.self, from: body) else { throw DeviceAuthError.unexpectedTokenResponse }
            guard ok.token_type.lowercased() == "bearer" else { throw DeviceAuthError.unexpectedTokenType }
            let t = ok.access_token
            guard t.hasPrefix("pd_"), t.utf8.count >= 20, t.utf8.count <= 256,
                  t.utf8.allSatisfy({ ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x41 && $0 <= 0x5A) || ($0 >= 0x61 && $0 <= 0x7A) || $0 == 0x2D || $0 == 0x5F })
            else { throw DeviceAuthError.unexpectedTokenFormat }
            return DeviceCredential(accessToken: t, deviceID: ok.device_id, expiresIn: ok.expires_in)
        }
        guard let e = try? JSONDecoder().decode(OAuthFailure.self, from: body) else { throw DeviceAuthError.http(status: status) }
        let code = String(e.error.unicodeScalars.filter { $0.isASCII && (CharacterSet.alphanumerics.contains($0) || $0 == "_") }.prefix(64).map(Character.init))
        let desc = e.error_description.map { d in String(d.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) }.prefix(200).map(Character.init)) }
        throw DeviceAuthError.server(code: code, description: (desc?.isEmpty ?? true) ? nil : desc, status: status)
    }
}
