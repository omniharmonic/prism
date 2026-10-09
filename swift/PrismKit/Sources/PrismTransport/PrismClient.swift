import Foundation
import PrismAuth
import PrismModels
import os

public struct PrismRequest: Sendable {
    public var method: String
    /// Absolute path on the configured origin (`/api/omni/threads`). Never a full URL.
    public var path: String
    public var query: [URLQueryItem]
    public var headers: [String: String]
    /// A JSON body. A body-less non-GET is sent as `{}` (the server requires a JSON
    /// content type on every mutation).
    public var body: Data?
    public var idempotencyKey: IdempotencyKey?
    public var timeout: TimeInterval?

    public init(method: String = "GET", path: String, query: [URLQueryItem] = [], headers: [String: String] = [:], body: Data? = nil, idempotencyKey: IdempotencyKey? = nil, timeout: TimeInterval? = nil) {
        self.method = method.uppercased()
        self.path = path
        self.query = query
        self.headers = headers
        self.body = body
        self.idempotencyKey = idempotencyKey
        self.timeout = timeout
    }

    public static func get(_ path: String, query: [URLQueryItem] = []) -> PrismRequest {
        PrismRequest(path: path, query: query)
    }

    public static func json<B: Encodable>(_ method: String, _ path: String, body: B, idempotencyKey: IdempotencyKey? = nil) throws -> PrismRequest {
        PrismRequest(method: method, path: path, body: try PrismJSON.encoder().encode(body), idempotencyKey: idempotencyKey)
    }
}

public struct PrismResponse: Sendable {
    public let status: Int
    private let headers: [String: String]
    public let body: Data

    public init(status: Int, headers: [String: String], body: Data) {
        self.status = status
        self.headers = Dictionary(headers.map { ($0.key.lowercased(), $0.value) }, uniquingKeysWith: { a, _ in a })
        self.body = body
    }

    /// Case-insensitive header lookup.
    public func header(_ name: String) -> String? { headers[name.lowercased()] }

    public var isSuccess: Bool { (200..<300).contains(status) }

    /// `Idempotent-Replayed: true` — the server answered a stored outcome for this key.
    public var isIdempotentReplay: Bool { header("Idempotent-Replayed")?.lowercased() == "true" }

    public func decode<T: Decodable>(_ type: T.Type = T.self) throws -> T {
        do { return try PrismJSON.decoder().decode(T.self, from: body) } catch { throw PrismError.decoding(PrismJSON.describe(error)) }
    }
}

/// One finished request, for a diagnostics list. It carries NO secret and no content: never
/// a token, a header, a query string or a body — only what a server log line would show.
public struct RequestRecord: Sendable, Equatable, Identifiable {
    public let id: UUID
    public let at: Date
    public let method: String
    /// The path only (`/api/omni/threads/omni_…`); the query is dropped (it can hold search text).
    public let path: String
    /// The HTTP status, when an answer arrived.
    public let status: Int?
    /// The server's `error` code from a non-2xx JSON body (`not_found`, `hermes_unavailable`, …).
    public let serverCode: String?
    /// Why no answer arrived (`timed out`, `connection refused`, …) — never a URL.
    public let failure: String?
    public let durationMs: Int
    /// A streaming GET (`text/event-stream`): the record is made when it connects (or fails to).
    public let isStream: Bool

    public init(id: UUID = UUID(), at: Date = Date(), method: String, path: String, status: Int?, serverCode: String? = nil, failure: String? = nil, durationMs: Int = 0, isStream: Bool = false) {
        self.id = id
        self.at = at
        self.method = method
        self.path = path
        self.status = status
        self.serverCode = serverCode
        self.failure = failure
        self.durationMs = durationMs
        self.isStream = isStream
    }

    /// Did the request fail (no answer, or a status of 400 and up)?
    public var isFailure: Bool { status.map { $0 >= 400 } ?? true }
}

/// The HTTP client bound to ONE server origin (the Swift twin of
/// `apps/web/src/transport.ts` in native mode).
///
/// - Every URL is built from the configured ``ServerOrigin`` + a path; a full URL is
///   never accepted.
/// - `Authorization: Bearer pd_…` is attached only after re-checking the final URL is on
///   that origin. No cookies are ever sent or stored.
/// - Redirects are never followed (``PrismError/redirectRefused(status:)``).
/// - One 401 is a suspicion: the same token is asked `GET /auth/me` once (concurrent
///   401s share the question). Only a 401 there forgets the token and runs the
///   signed-out handler. Nothing here ever starts a sign-in.
public final class PrismClient: Sendable {
    public typealias SignedOutHandler = @Sendable () async -> Void
    /// Told about every finished request (see ``RequestRecord``). Called on an arbitrary thread.
    public typealias RequestObserver = @Sendable (RequestRecord) -> Void

    public let origin: ServerOrigin
    /// `X-Prism-Vault`, when the account has more than one vault.
    public let vault: String?
    private let tokenStore: any TokenStore
    private let session: URLSession
    private let auth: DeviceAuthClient
    private let userAgent: String
    private let onSignedOut: SignedOutHandler?
    private let onRequest: RequestObserver?
    private let guardian = LivenessGuard()
    /// Responses larger than this are refused (`decoding`).
    public let maxResponseBytes: Int

    public init(
        origin: ServerOrigin,
        tokenStore: any TokenStore,
        session: URLSession = PrismURLSession.make(),
        vault: String? = nil,
        userAgent: String = "PrismKit/1",
        maxResponseBytes: Int = 32 * 1024 * 1024,
        onSignedOut: SignedOutHandler? = nil,
        onRequest: RequestObserver? = nil
    ) {
        self.origin = origin
        self.tokenStore = tokenStore
        self.session = session
        self.vault = vault
        self.userAgent = userAgent
        self.maxResponseBytes = maxResponseBytes
        self.onSignedOut = onSignedOut
        self.onRequest = onRequest
        self.auth = DeviceAuthClient(origin: origin, session: session)
    }

    // MARK: Calls

    /// Send and require a 2xx; any other status throws the matching ``PrismError``.
    public func send(_ request: PrismRequest) async throws -> PrismResponse {
        let response = try await sendRaw(request)
        guard response.isSuccess else { throw Self.error(for: response) }
        return response
    }

    /// Send and decode a 2xx JSON body.
    public func send<T: Decodable>(_ request: PrismRequest, as type: T.Type = T.self) async throws -> T {
        try await send(request).decode(T.self)
    }

    /// Send and return whatever status the server gave (for routes whose 4xx/5xx bodies
    /// are part of the contract). Still throws for: no token, a transport failure, a
    /// redirect, and 401 (after the `/auth/me` check).
    public func sendRaw(_ request: PrismRequest) async throws -> PrismResponse {
        let (urlRequest, token) = try buildRequest(request, accept: "application/json")
        let started = Date()
        let data: Data, resp: URLResponse
        do {
            (data, resp) = try await session.data(for: urlRequest)
        } catch {
            let mapped = Self.transportError(error)
            if !(mapped is CancellationError) { record(request, started: started, status: nil, body: nil, failure: Self.failureWord(mapped), stream: false) }
            throw mapped
        }
        guard let http = resp as? HTTPURLResponse else { throw PrismError.decoding("not an HTTP response") }
        record(request, started: started, status: http.statusCode, body: data, failure: nil, stream: false)
        guard data.count <= maxResponseBytes else { throw PrismError.decoding("response too large") }
        try await screen(status: http.statusCode, token: token)
        return PrismResponse(status: http.statusCode, headers: Self.headers(of: http), body: data)
    }

    /// Open a streaming GET (`text/event-stream`) and yield the body as it arrives, in
    /// line-sized chunks. A non-200 answer throws the same errors as ``send(_:)`` before
    /// the first chunk. Cancelling the consuming task closes the connection.
    public func openStream(_ request: PrismRequest, idleTimeout: TimeInterval = 90) async throws -> AsyncThrowingStream<Data, any Error> {
        var req = request
        req.timeout = idleTimeout
        let (urlRequest, token) = try buildRequest(req, accept: "text/event-stream")
        let started = Date()
        let bytes: URLSession.AsyncBytes, resp: URLResponse
        do {
            (bytes, resp) = try await session.bytes(for: urlRequest)
        } catch {
            let mapped = Self.transportError(error)
            if !(mapped is CancellationError) { record(request, started: started, status: nil, body: nil, failure: Self.failureWord(mapped), stream: true) }
            throw mapped
        }
        guard let http = resp as? HTTPURLResponse else { throw PrismError.decoding("not an HTTP response") }
        if http.statusCode == 200 { record(request, started: started, status: 200, body: nil, failure: nil, stream: true) }
        if http.statusCode != 200 {
            var body = Data()
            do {
                for try await b in bytes {
                    body.append(b)
                    if body.count >= 64 * 1024 { break }
                }
            } catch { /* the status is what matters */ }
            bytes.task.cancel()
            record(request, started: started, status: http.statusCode, body: body, failure: nil, stream: true)
            try await screen(status: http.statusCode, token: token)
            throw Self.error(for: PrismResponse(status: http.statusCode, headers: Self.headers(of: http), body: body))
        }
        return AsyncThrowingStream { continuation in
            let pump = Task {
                var buffer = Data()
                do {
                    for try await byte in bytes {
                        buffer.append(byte)
                        if byte == 0x0A || buffer.count >= 16 * 1024 {
                            continuation.yield(buffer)
                            buffer = Data()
                        }
                    }
                    if !buffer.isEmpty { continuation.yield(buffer) }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: Task.isCancelled ? CancellationError() : Self.transportError(error))
                }
            }
            continuation.onTermination = { _ in
                pump.cancel()
                bytes.task.cancel()
            }
        }
    }

    // MARK: Diagnostics

    /// Tell the observer about a finished request: method, path, status and the server's
    /// `error` code — nothing else leaves here.
    private func record(_ request: PrismRequest, started: Date, status: Int?, body: Data?, failure: String?, stream: Bool) {
        guard let onRequest else { return }
        var code: String?
        if let status, status >= 400, let body, body.count <= 64 * 1024,
           let obj = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any], let c = obj["error"] as? String {
            code = String(c.prefix(60))
        }
        onRequest(RequestRecord(method: request.method, path: request.path, status: status, serverCode: code, failure: failure, durationMs: max(0, Int(Date().timeIntervalSince(started) * 1000)), isStream: stream))
    }

    private static func failureWord(_ error: any Error) -> String {
        switch error as? PrismError {
        case .unreachable(let why): return why
        case .outcomeUnknown(let u): return u.reason
        default: return "network error"
        }
    }

    // MARK: Request building

    private func buildRequest(_ r: PrismRequest, accept: String) throws -> (URLRequest, String) {
        let url: URL
        do { url = try origin.url(path: r.path, query: r.query) } catch { throw PrismError.invalidRequest("path refused") }
        let token: String?
        do { token = try tokenStore.token(for: origin) } catch { throw PrismError.tokenStore(Self.describeStore(error)) }
        guard let token, !token.isEmpty else { throw PrismError.notSignedIn }

        var req = URLRequest(url: url)
        req.httpMethod = r.method
        req.httpShouldHandleCookies = false
        if let t = r.timeout { req.timeoutInterval = t }
        for (k, v) in r.headers {
            // A caller can never set the credential, the agent downgrade, or the body type.
            let lk = k.lowercased()
            if lk == "authorization" || lk == "cookie" || lk == "host" || lk == "content-type" || lk == "idempotency-key" { continue }
            req.setValue(v, forHTTPHeaderField: k)
        }
        req.setValue(accept, forHTTPHeaderField: "Accept")
        req.setValue(userAgent, forHTTPHeaderField: "User-Agent")
        if let vault { req.setValue(vault, forHTTPHeaderField: "X-Prism-Vault") }
        if r.method != "GET" && r.method != "HEAD" {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = r.body ?? Data("{}".utf8)
        }
        if let key = r.idempotencyKey { req.setValue(key.value, forHTTPHeaderField: "Idempotency-Key") }
        // The bearer goes ONLY to the configured origin (re-checked on the final URL).
        guard let final = req.url, origin.contains(final) else { throw PrismError.invalidRequest("off-origin URL refused") }
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        return (req, token)
    }

    // MARK: Status handling

    /// Redirects and 401s are handled the same way for every call.
    private func screen(status: Int, token: String) async throws {
        if (300..<400).contains(status) { throw PrismError.redirectRefused(status: status) }
        guard status == 401 else { return }
        // A 401 for a token that is no longer the current one is ignored.
        guard ((try? tokenStore.token(for: origin)) ?? nil) == token else { throw PrismError.unauthorized }
        let auth = self.auth
        let verdict = await guardian.check(token: token) { await auth.liveness(of: token) }
        guard verdict.liveness == .dead else { throw PrismError.unauthorized }
        if verdict.first {
            if ((try? tokenStore.token(for: origin)) ?? nil) == token { try? tokenStore.removeToken(for: origin) }
            await onSignedOut?()
        }
        throw PrismError.signedOut
    }

    /// Map a non-2xx response to its error.
    public static func error(for r: PrismResponse) -> PrismError {
        let obj = (try? JSONSerialization.jsonObject(with: r.body)) as? [String: Any]
        let code = (obj?["error"] as? String).map { String($0.prefix(100)) }
        let detail = (obj?["detail"] as? String).map { String($0.prefix(500)) }
        let failure = ServerFailure(status: r.status, code: code, detail: detail, body: r.body)
        switch r.status {
        case 300..<400: return .redirectRefused(status: r.status)
        case 401: return .unauthorized
        case 403: return .forbidden(failure)
        case 409: return .conflict(failure)
        case 500...: return .outcomeUnknown(OutcomeUnknown(status: r.status, code: code, reason: "HTTP \(r.status)", body: r.body))
        default: return .rejected(failure)
        }
    }

    static func transportError(_ error: any Error) -> any Error {
        if error is CancellationError { return error }
        if let p = error as? PrismError { return p }
        guard let e = error as? URLError else { return PrismError.outcomeUnknown(OutcomeUnknown(status: nil, code: nil, reason: "network error")) }
        switch e.code {
        case .cancelled:
            return CancellationError()
        case .cannotFindHost, .dnsLookupFailed, .cannotConnectToHost, .notConnectedToInternet, .secureConnectionFailed,
             .serverCertificateUntrusted, .serverCertificateHasBadDate, .serverCertificateHasUnknownRoot, .serverCertificateNotYetValid,
             .clientCertificateRejected, .clientCertificateRequired, .appTransportSecurityRequiresSecureConnection, .unsupportedURL, .badURL,
             .internationalRoamingOff, .dataNotAllowed:
            // The connection was never established: nothing was delivered.
            return PrismError.unreachable(prismSanitizedReason(e))
        default:
            // Timed out, connection lost, bad server response…: the request may have landed.
            return PrismError.outcomeUnknown(OutcomeUnknown(status: nil, code: nil, reason: prismSanitizedReason(e)))
        }
    }

    private static func headers(of http: HTTPURLResponse) -> [String: String] {
        var out: [String: String] = [:]
        for (k, v) in http.allHeaderFields {
            if let k = k as? String, let v = v as? String { out[k] = v }
        }
        return out
    }

    private static func describeStore(_ error: any Error) -> String {
        if case TokenStoreError.keychain(let status) = error { return "status \(status)" }
        return "storage error"
    }
}

/// One `/auth/me` question per suspect token, shared by concurrent 401s.
private actor LivenessGuard {
    private var inFlight: [String: Task<TokenLiveness, Never>] = [:]
    private var reportedDead: Set<String> = []

    func check(token: String, ask: @escaping @Sendable () async -> TokenLiveness) async -> (liveness: TokenLiveness, first: Bool) {
        if reportedDead.contains(token) { return (.dead, false) }
        let task: Task<TokenLiveness, Never>
        if let t = inFlight[token] {
            task = t
        } else {
            task = Task { await ask() }
            inFlight[token] = task
        }
        let result = await task.value
        inFlight[token] = nil
        guard result == .dead else { return (result, false) }
        let first = reportedDead.insert(token).inserted
        return (.dead, first)
    }
}
