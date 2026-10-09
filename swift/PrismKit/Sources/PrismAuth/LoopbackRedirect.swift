#if canImport(Network)
import Foundation
import Network
import os

/// RFC 8252 §7.3 loopback redirect for the desktop: a one-shot HTTP listener on
/// `127.0.0.1:<ephemeral port>` that accepts exactly `GET /callback?code=…&state=…`
/// carrying this attempt's `state`. Ported from `apps/client/src-tauri/src/loopback.rs`.
///
/// Anything else (another path, method, or state) gets an error page and the listener
/// keeps waiting — a stray local request can neither complete nor abort a sign-in.
public struct LoopbackRedirectFlow: RedirectFlow {
    /// Opens the authorize URL in the system browser. Returns false when it could not.
    public typealias OpenURL = @Sendable (URL) async -> Bool

    private let timeout: Duration
    private let openURL: OpenURL

    /// - Parameters:
    ///   - timeout: enough for a password or magic-link login (the code itself lives 5 min).
    ///   - openURL: e.g. `{ await NSWorkspace.shared.open($0) }`; injected so the flow has no UI dependency.
    public init(timeout: Duration = .seconds(600), openURL: @escaping OpenURL) {
        self.timeout = timeout
        self.openURL = openURL
    }

    public func start() async throws -> any RedirectFlowSession {
        let listener = try await LoopbackRedirectListener.bind()
        return Session(listener: listener, timeout: timeout, openURL: openURL)
    }

    private struct Session: RedirectFlowSession {
        let listener: LoopbackRedirectListener
        let timeout: Duration
        let openURL: OpenURL
        var redirectURI: String { listener.redirectURI }

        func waitForCode(authorizeURL: URL, expectedState: String) async throws -> String {
            async let code = listener.waitForCode(expectedState: expectedState, timeout: timeout)
            if !(await openURL(authorizeURL)) {
                listener.cancel(with: DeviceAuthError.flowUnavailable("could not open the browser"))
            }
            return try await code
        }
    }
}

public final class LoopbackRedirectListener: Sendable {
    public static let callbackPath = "/callback"
    static let maxRequestBytes = 8 * 1024
    static let perConnection: DispatchTimeInterval = .seconds(2)
    static let maxConcurrent = 8

    private struct State {
        var expectedState: String?
        var open = 0
        var finished = false
    }

    private let listener: NWListener
    private let queue = DispatchQueue(label: "prismkit.loopback-redirect")
    private let state = OSAllocatedUnfairLock<State>(initialState: State())
    private let result = ResumeOnce<String>()
    public let port: UInt16

    public var redirectURI: String { "http://127.0.0.1:\(port)\(Self.callbackPath)" }

    private init(listener: NWListener, port: UInt16) {
        self.listener = listener
        self.port = port
    }

    /// Bind `127.0.0.1` on an ephemeral port (never a wildcard address).
    public static func bind() async throws -> LoopbackRedirectListener {
        let params = NWParameters.tcp
        params.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
        params.allowLocalEndpointReuse = false
        params.acceptLocalOnly = true
        let nw: NWListener
        do { nw = try NWListener(using: params) } catch { throw DeviceAuthError.flowUnavailable("could not open the sign-in listener") }
        let ready = ResumeOnce<UInt16>()
        let queue = DispatchQueue(label: "prismkit.loopback-redirect.bind")
        nw.stateUpdateHandler = { s in
            switch s {
            case .ready:
                if let p = nw.port?.rawValue, p >= 1024 { ready.resume(.success(p)) } else { ready.resume(.failure(DeviceAuthError.flowUnavailable("unexpected listener port"))) }
            case .failed, .cancelled:
                ready.resume(.failure(DeviceAuthError.flowUnavailable("could not open the sign-in listener")))
            default: break
            }
        }
        // Connections are only served once the owner object exists.
        // Weak: the listener must not keep its owner alive (the owner cancels it on deinit).
        let holder = OSAllocatedUnfairLock<WeakOwner>(initialState: WeakOwner())
        nw.newConnectionHandler = { conn in
            if let owner = holder.withLock({ $0.owner }) { owner.accept(conn) } else { conn.cancel() }
        }
        nw.start(queue: queue)
        let port: UInt16
        do {
            port = try await withCheckedThrowingContinuation { ready.set($0) }
        } catch {
            nw.cancel()
            throw error
        }
        let owner = LoopbackRedirectListener(listener: nw, port: port)
        holder.withLock { $0.owner = owner }
        return owner
    }

    private struct WeakOwner: @unchecked Sendable {
        weak var owner: LoopbackRedirectListener?
    }

    deinit { listener.cancel() }

    /// Wait for the redirect carrying `expectedState`. Returns the authorization code.
    public func waitForCode(expectedState: String, timeout: Duration) async throws -> String {
        state.withLock { $0.expectedState = expectedState }
        let timer = Task { [weak self] in
            try? await Task.sleep(for: timeout)
            if !Task.isCancelled { self?.cancel(with: DeviceAuthError.timedOut) }
        }
        defer { timer.cancel() }
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { result.set($0) }
        } onCancel: {
            self.cancel(with: DeviceAuthError.cancelled)
        }
    }

    /// Stop listening; a pending ``waitForCode(expectedState:timeout:)`` throws `error`.
    public func cancel(with error: DeviceAuthError = .cancelled) {
        finish(.failure(error))
    }

    private func finish(_ r: Result<String, any Error>) {
        let first = state.withLock { s -> Bool in
            if s.finished { return false }
            s.finished = true
            return true
        }
        guard first else { return }
        result.resume(r)
        // Let the final page flush before the listener goes away.
        queue.asyncAfter(deadline: .now() + .milliseconds(200)) { [listener] in listener.cancel() }
    }

    private func accept(_ conn: NWConnection) {
        let admitted = state.withLock { s -> Bool in
            guard !s.finished, s.open < Self.maxConcurrent else { return false }
            s.open += 1
            return true
        }
        guard admitted else {
            conn.cancel()
            return
        }
        let closed = OSAllocatedUnfairLock(initialState: false)
        let close: @Sendable () -> Void = { [state] in
            let already = closed.withLock { c -> Bool in
                defer { c = true }
                return c
            }
            if !already {
                state.withLock { $0.open -= 1 }
                conn.cancel()
            }
        }
        conn.start(queue: queue)
        queue.asyncAfter(deadline: .now() + Self.perConnection) { close() }
        read(conn, buffer: Data(), close: close)
    }

    private func read(_ conn: NWConnection, buffer: Data, close: @escaping @Sendable () -> Void) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 2048) { [weak self] data, _, isComplete, error in
            guard let self else { return close() }
            var buf = buffer
            if let data { buf.append(data) }
            if buf.count > Self.maxRequestBytes { return close() }
            let headEnd = buf.range(of: Data("\r\n\r\n".utf8))
            if headEnd == nil && !isComplete && error == nil {
                return self.read(conn, buffer: buf, close: close)
            }
            guard !buf.isEmpty else { return close() }
            // Bytes, not Characters: "\r\n" is ONE Character in Swift.
            let lineEnd = buf.firstIndex(where: { $0 == 0x0D || $0 == 0x0A }) ?? buf.endIndex
            let line = String(decoding: buf[buf.startIndex..<lineEnd], as: UTF8.self)
            let expected = self.state.withLock { $0.expectedState }
            let (status, page, outcome) = Self.respond(to: line, expectedState: expected)
            let body = Data(page.utf8)
            let reason = status == 200 ? "OK" : status == 404 ? "Not Found" : "Bad Request"
            let head = "HTTP/1.1 \(status) \(reason)\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: \(body.count)\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Security-Policy: default-src 'none'; style-src 'unsafe-inline'\r\nConnection: close\r\n\r\n"
            conn.send(content: Data(head.utf8) + body, completion: .contentProcessed { _ in
                close()
                if let outcome { self.finish(outcome) }
            })
        }
    }

    enum Classified: Equatable {
        case notFound
        case ignored
        case done(CallbackOutcome)
    }

    /// Classify an HTTP request line. Only `GET /callback?…` over HTTP/1.x with OUR state
    /// can end the sign-in.
    static func classify(requestLine: String, expectedState: String?) -> Classified {
        let parts = requestLine.split(separator: " ", omittingEmptySubsequences: true)
        guard parts.count == 3, parts[0] == "GET", parts[2].hasPrefix("HTTP/1.") else { return .notFound }
        let target = parts[1]
        let path: Substring, query: Substring
        if let q = target.firstIndex(of: "?") {
            path = target[..<q]
            query = target[target.index(after: q)...]
        } else {
            path = target
            query = ""
        }
        guard path == callbackPath else { return .notFound }
        guard let expectedState else { return .ignored }
        let outcome = PKCE.parseCallbackQuery(String(query), expectedState: expectedState)
        return outcome == .stateMismatch ? .ignored : .done(outcome)
    }

    private static func respond(to line: String, expectedState: String?) -> (Int, String, Result<String, any Error>?) {
        switch classify(requestLine: line, expectedState: expectedState) {
        case .notFound: return (404, page("Not found", "Nothing to see here."), nil)
        case .ignored: return (400, page("Sign-in not completed", "This response didn't match the sign-in in progress. Return to the app and try again."), nil)
        case .done(.code(let code)): return (200, page("Signed in", "You can close this tab and return to the app."), .success(code))
        case .done(.denied(let e)): return (200, page("Sign-in denied", "You can close this tab."), .failure(DeviceAuthError.denied(e)))
        case .done(.malformed): return (400, page("Sign-in failed", "The response was malformed. Return to the app and try again."), .failure(DeviceAuthError.malformedCallback))
        case .done(.stateMismatch): return (400, page("Sign-in not completed", "Return to the app and try again."), nil)
        }
    }

    private static func page(_ heading: String, _ text: String) -> String {
        "<!doctype html><meta charset=utf-8><title>Sign in</title><style>body{font:15px -apple-system,system-ui,sans-serif;background:#0a0a0b;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}div{max-width:420px;text-align:center}h1{font-size:20px}</style><div><h1>\(heading)</h1><p>\(text)</p></div>"
    }
}
#endif

#if os(macOS) && canImport(AppKit)
import AppKit

extension LoopbackRedirectFlow {
    /// The usual macOS flow: open the authorize URL in the default browser.
    public static func systemBrowser(timeout: Duration = .seconds(600)) -> LoopbackRedirectFlow {
        LoopbackRedirectFlow(timeout: timeout) { url in
            await MainActor.run { NSWorkspace.shared.open(url) }
        }
    }
}
#endif
