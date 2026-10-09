import Foundation
import PrismAuth
import os

/// What the stub answers for one request.
public enum StubAnswer: Sendable {
    /// A response whose body is delivered in the given chunks.
    case response(status: Int, headers: [String: String] = [:], chunks: [Data])
    /// Announce a redirect to the loading system (as a real server's 3xx would).
    case redirect(status: Int, to: String)
    case failure(URLError.Code)

    public static func json(_ status: Int, _ body: String, headers: [String: String] = [:]) -> StubAnswer {
        var h = headers
        h["Content-Type"] = "application/json"
        return .response(status: status, headers: h, chunks: [Data(body.utf8)])
    }

    public static func sse(_ chunks: [String]) -> StubAnswer {
        .response(status: 200, headers: ["Content-Type": "text/event-stream"], chunks: chunks.map { Data($0.utf8) })
    }
}

/// One request as the stub saw it.
public struct SeenRequest: Sendable {
    public let method: String
    public let url: URL
    public let headers: [String: String]
    public let body: Data

    public func header(_ name: String) -> String? {
        headers.first { $0.key.lowercased() == name.lowercased() }?.value
    }
    public var bodyString: String { String(decoding: body, as: UTF8.self) }
    public var path: String { url.path }
    public var query: [String: String] {
        Dictionary((URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []).map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { a, _ in a })
    }
}

/// A fake server: no socket is ever opened. Every `StubServer` owns its own session, and
/// requests are routed to it by a private header the stub strips before recording — so
/// tests never share state and never reach the network.
public final class StubServer: Sendable {
    public typealias Handler = @Sendable (SeenRequest) -> StubAnswer

    private struct State {
        var handler: Handler
        var seen: [SeenRequest] = []
    }
    private let state: OSAllocatedUnfairLock<State>
    private let id = UUID().uuidString
    public let session: URLSession

    public init(_ handler: @escaping Handler = { _ in .json(404, #"{"error":"not_found"}"#) }) {
        state = OSAllocatedUnfairLock(initialState: State(handler: handler))
        let id = self.id
        session = PrismURLSession.make(requestTimeout: 5) { config in
            config.protocolClasses = [StubURLProtocol.self]
            config.httpAdditionalHeaders = [StubURLProtocol.routeHeader: id]
        }
        StubURLProtocol.register(id, self)
    }

    /// A NAIVE session on the same fake server that follows redirects like a default
    /// `URLSession` — the control that proves the redirect tests have teeth.
    public func makeRedirectFollowingSession() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubURLProtocol.self]
        config.httpAdditionalHeaders = [StubURLProtocol.routeHeader: id]
        return URLSession(configuration: config)
    }

    public func setHandler(_ handler: @escaping Handler) { state.withLock { $0.handler = handler } }

    /// Every request received, in order (any host).
    public var requests: [SeenRequest] { state.withLock { $0.seen } }

    fileprivate func handle(_ r: SeenRequest) -> StubAnswer {
        let handler = state.withLock { s -> Handler in
            s.seen.append(r)
            return s.handler
        }
        return handler(r)
    }
}

final class StubURLProtocol: URLProtocol, @unchecked Sendable {
    static let routeHeader = "X-Stub-Route"
    /// Strong references: a stub server lives as long as the test process, so a client whose
    /// test dropped the `StubServer` value still reaches it (never the network).
    private static let servers = OSAllocatedUnfairLock<[String: StubServer]>(initialState: [:])

    static func register(_ id: String, _ server: StubServer) { servers.withLock { $0[id] = server } }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        guard let url = request.url, let client else { return }
        var headers = request.allHTTPHeaderFields ?? [:]
        let route = headers.removeValue(forKey: Self.routeHeader)
        let server = route.flatMap { id in Self.servers.withLock { $0[id] } }
        guard let server else {
            client.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
            return
        }
        var body = request.httpBody ?? Data()
        if let stream = request.httpBodyStream {
            stream.open()
            var buf = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let n = stream.read(&buf, maxLength: buf.count)
                if n <= 0 { break }
                body.append(buf, count: n)
            }
            stream.close()
        }
        let seen = SeenRequest(method: request.httpMethod ?? "GET", url: url, headers: headers, body: body)
        switch server.handle(seen) {
        case .failure(let code):
            client.urlProtocol(self, didFailWithError: URLError(code))
        case .redirect(let status, let to):
            let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Location": to])!
            var next = URLRequest(url: URL(string: to)!)
            // What a naive client would do: carry the credential along.
            next.allHTTPHeaderFields = request.allHTTPHeaderFields
            client.urlProtocol(self, wasRedirectedTo: next, redirectResponse: response)
            // Per URLProtocol's contract the redirect response is then delivered as the answer
            // when the client declines to follow.
            client.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client.urlProtocolDidFinishLoading(self)
        case .response(let status, let headers, let chunks):
            let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
            client.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            for chunk in chunks { client.urlProtocol(self, didLoad: chunk) }
            client.urlProtocolDidFinishLoading(self)
        }
    }
}

public enum TestTokens {
    /// A token-SHAPED placeholder (`pd_` + 43 base64url characters). Not a credential.
    public static let device = "pd_" + String(repeating: "A", count: 43)
    public static let other = "pd_" + String(repeating: "B", count: 43)
}
