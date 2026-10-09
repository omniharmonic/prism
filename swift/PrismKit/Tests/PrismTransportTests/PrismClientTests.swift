import Foundation
import PrismAuth
import PrismModels
import PrismTestSupport
import PrismTransport
import XCTest

final class PrismClientTests: XCTestCase {
    let origin = try! ServerOrigin("https://prism.example.com")

    func makeClient(_ server: StubServer, token: String? = TestTokens.device, vault: String? = nil, onSignedOut: PrismClient.SignedOutHandler? = nil) throws -> (PrismClient, InMemoryTokenStore) {
        let store = InMemoryTokenStore()
        if let token { try store.setToken(token, for: origin) }
        return (PrismClient(origin: origin, tokenStore: store, session: server.session, vault: vault, onSignedOut: onSignedOut), store)
    }

    func assertThrows<T>(_ expected: PrismError, _ body: () async throws -> T, file: StaticString = #filePath, line: UInt = #line) async {
        do {
            _ = try await body()
            XCTFail("expected \(expected)", file: file, line: line)
        } catch {
            XCTAssertEqual(error as? PrismError, expected, file: file, line: line)
        }
    }

    // MARK: origin pinning

    func testBearerGoesToTheConfiguredOriginWithJSONAndNoCookies() async throws {
        let server = StubServer { _ in .json(200, #"{"api":1,"minClient":"1.0"}"#) }
        let (client, _) = try makeClient(server, vault: "work")
        struct V: Decodable, Equatable { let api: Int }
        let v: V = try await client.send(.get("/api/omni/version", query: [URLQueryItem(name: "x", value: "a b")]))
        XCTAssertEqual(v, V(api: 1))
        let r = try XCTUnwrap(server.requests.first)
        XCTAssertEqual(r.url.absoluteString, "https://prism.example.com/api/omni/version?x=a%20b")
        XCTAssertEqual(r.header("Authorization"), "Bearer \(TestTokens.device)")
        XCTAssertEqual(r.header("Accept"), "application/json")
        XCTAssertEqual(r.header("X-Prism-Vault"), "work")
        XCTAssertNil(r.header("Cookie"))
        XCTAssertNil(r.header("Content-Type"), "a GET has no body type")
        XCTAssertNil(r.header("X-Prism-Action-Origin"), "this client never downgrades itself to an agent")
    }

    func testPathsThatCouldLeaveTheOriginAreRefusedBeforeAnythingIsSent() async throws {
        let server = StubServer { _ in .json(200, "{}") }
        let (client, _) = try makeClient(server)
        for path in ["https://evil.example.net/api", "//evil.example.net/api", "/api/../../etc", "api/omni", "/api\\@evil.example.net", "/api?x=1", ""] {
            await assertThrows(.invalidRequest("path refused")) { try await client.send(.get(path)) }
        }
        XCTAssertTrue(server.requests.isEmpty)
    }

    func testCallerCannotOverrideCredentialHeaders() async throws {
        let server = StubServer { _ in .json(200, "{}") }
        let (client, _) = try makeClient(server)
        _ = try await client.send(PrismRequest(method: "POST", path: "/api/x", headers: ["Authorization": "Bearer other", "Cookie": "s=1", "Host": "evil.example.net", "Content-Type": "text/plain", "X-Custom": "ok"]))
        let r = try XCTUnwrap(server.requests.first)
        XCTAssertEqual(r.header("Authorization"), "Bearer \(TestTokens.device)")
        XCTAssertNil(r.header("Cookie"))
        XCTAssertEqual(r.url.host, "prism.example.com")
        XCTAssertEqual(r.header("Content-Type"), "application/json")
        XCTAssertEqual(r.header("X-Custom"), "ok")
    }

    func testNoTokenSendsNothing() async throws {
        let server = StubServer { _ in .json(200, "{}") }
        let (client, _) = try makeClient(server, token: nil)
        await assertThrows(.notSignedIn) { try await client.send(.get("/api/omni/version")) }
        XCTAssertTrue(server.requests.isEmpty)
    }

    // MARK: redirects

    func testARedirectToAnotherOriginIsNeverFollowed() async throws {
        let server = StubServer { r in
            r.url.host == "prism.example.com" ? .redirect(status: 302, to: "https://evil.example.net/steal") : .json(200, #"{"stolen":true}"#)
        }
        let (client, _) = try makeClient(server)
        for method in ["GET", "POST"] {
            await assertThrows(.redirectRefused(status: 302)) { try await client.send(PrismRequest(method: method, path: "/api/omni/threads")) }
        }
        XCTAssertEqual(Set(server.requests.compactMap(\.url.host)), ["prism.example.com"], "nothing — and no bearer — reached the other origin")
    }

    /// Control: the same fake server DOES see a second, off-origin request (bearer and all)
    /// when a default session follows the redirect — so the test above is not vacuous.
    func testControlANaiveSessionWouldHaveFollowedTheRedirect() async throws {
        let server = StubServer { r in
            r.url.host == "prism.example.com" ? .redirect(status: 302, to: "https://evil.example.net/steal") : .json(200, #"{"stolen":true}"#)
        }
        var request = URLRequest(url: URL(string: "https://prism.example.com/api/omni/threads")!)
        request.setValue("Bearer \(TestTokens.device)", forHTTPHeaderField: "Authorization")
        _ = try await server.makeRedirectFollowingSession().data(for: request)
        XCTAssertEqual(server.requests.compactMap(\.url.host), ["prism.example.com", "evil.example.net"])
    }

    func testASameOriginRedirectIsAlsoRefused() async throws {
        let server = StubServer { r in r.path == "/a" ? .redirect(status: 307, to: "https://prism.example.com/b") : .json(200, "{}") }
        let (client, _) = try makeClient(server)
        await assertThrows(.redirectRefused(status: 307)) { try await client.send(.get("/a")) }
        XCTAssertEqual(server.requests.map(\.path), ["/a"])
    }

    func testAStreamRedirectIsRefused() async throws {
        let server = StubServer { r in r.url.host == "prism.example.com" ? .redirect(status: 302, to: "https://evil.example.net/stream") : .sse(["data: x\n\n"]) }
        let (client, _) = try makeClient(server)
        await assertThrows(.redirectRefused(status: 302)) { try await client.openStream(.get("/api/omni/events")) }
        XCTAssertEqual(Set(server.requests.compactMap(\.url.host)), ["prism.example.com"])
    }

    // MARK: typed errors

    func testStatusMapping() async throws {
        func error(_ answer: StubAnswer) async throws -> PrismError? {
            let server = StubServer { _ in answer }
            let (client, _) = try makeClient(server)
            do {
                _ = try await client.send(PrismRequest(method: "POST", path: "/api/x"))
                return nil
            } catch { return error as? PrismError }
        }
        var e = try await error(.json(403, #"{"error":"forbidden","detail":"sign in on the device"}"#))
        guard case .forbidden(let f)? = e else { return XCTFail("\(String(describing: e))") }
        XCTAssertEqual(f.code, "forbidden")
        XCTAssertEqual(f.detail, "sign in on the device")
        XCTAssertEqual(e?.httpStatus, 403)

        e = try await error(.json(409, #"{"error":"digest_mismatch","detail":"the draft changed"}"#))
        guard case .conflict(let c)? = e else { return XCTFail("\(String(describing: e))") }
        XCTAssertEqual(c.code, "digest_mismatch")
        XCTAssertEqual(e?.serverCode, "digest_mismatch")

        e = try await error(.json(409, #"{"error":"conflict","turnId":"turn_1"}"#))
        guard case .conflict(let c2)? = e else { return XCTFail("\(String(describing: e))") }
        XCTAssertTrue(String(decoding: c2.body, as: UTF8.self).contains("turn_1"), "route-specific fields stay readable")

        for (status, code) in [(400, "bad_request"), (404, "not_found"), (410, "expired"), (415, "unsupported_media_type"), (422, "x"), (429, "too_many_streams")] {
            e = try await error(.json(status, #"{"error":"\#(code)"}"#))
            guard case .rejected(let r)? = e else { return XCTFail("\(status): \(String(describing: e))") }
            XCTAssertEqual(r.status, status)
            XCTAssertEqual(r.code, code)
        }

        for (status, code) in [(500, "internal_error"), (502, "hermes_unavailable"), (503, "hermes_not_configured"), (504, "hermes_timeout")] {
            e = try await error(.json(status, #"{"error":"\#(code)"}"#))
            guard case .outcomeUnknown(let u)? = e else { return XCTFail("\(status): \(String(describing: e))") }
            XCTAssertEqual(u.status, status)
            XCTAssertEqual(u.code, code)
        }
        e = try await error(.json(502, "<html>Bad gateway</html>"))
        guard case .outcomeUnknown(let u)? = e else { return XCTFail() }
        XCTAssertNil(u.code)

        // Timeouts and a connection lost mid-flight: the request may have landed.
        for code in [URLError.Code.timedOut, .networkConnectionLost, .badServerResponse] {
            e = try await error(.failure(code))
            guard case .outcomeUnknown(let t)? = e else { return XCTFail("\(code): \(String(describing: e))") }
            XCTAssertNil(t.status)
        }
        // Never connected: provably not delivered.
        for code in [URLError.Code.cannotConnectToHost, .cannotFindHost, .notConnectedToInternet, .secureConnectionFailed] {
            e = try await error(.failure(code))
            guard case .unreachable? = e else { return XCTFail("\(code): \(String(describing: e))") }
        }
        e = try await error(.json(200, "not json"))
        XCTAssertNil(e, "send(_:) does not decode")
    }

    func testDecodingFailureDoesNotLeakTheBody() async throws {
        let server = StubServer { _ in .json(200, #"{"api":"private text that must not be logged"}"#) }
        let (client, _) = try makeClient(server)
        struct V: Decodable { let api: Int }
        do {
            let _: V = try await client.send(.get("/api/omni/version"))
            XCTFail("expected a decoding error")
        } catch {
            guard case PrismError.decoding(let why) = error else { return XCTFail("\(error)") }
            XCTAssertEqual(why, "wrong type at api")
        }
    }

    // MARK: 401 → signed-out signal

    func test401ConfirmedDeadForgetsTheTokenAndSignalsOnce() async throws {
        let signals = Counter()
        let server = StubServer { r in r.path == "/auth/me" ? .json(401, #"{"error":"unauthorized"}"#) : .json(401, #"{"error":"unauthorized"}"#) }
        let (client, store) = try makeClient(server) { signals.increment() }
        await assertThrows(.signedOut) { try await client.send(.get("/api/omni/threads")) }
        XCTAssertNil(try store.token(for: origin), "a dead token is forgotten")
        XCTAssertEqual(signals.value, 1)
        XCTAssertEqual(server.requests.map(\.path), ["/api/omni/threads", "/auth/me"])
        XCTAssertEqual(server.requests[1].header("Authorization"), "Bearer \(TestTokens.device)", "the SAME token is asked about")
        // Afterwards nothing is sent at all, and nothing starts a sign-in.
        await assertThrows(.notSignedIn) { try await client.send(.get("/api/omni/threads")) }
        XCTAssertEqual(server.requests.count, 2)
        XCTAssertEqual(signals.value, 1)
    }

    func test401WithALiveTokenKeepsIt() async throws {
        let signals = Counter()
        let server = StubServer { r in r.path == "/auth/me" ? .json(200, #"{"authenticated":true}"#) : .json(401, #"{"error":"unauthorized"}"#) }
        let (client, store) = try makeClient(server) { signals.increment() }
        await assertThrows(.unauthorized) { try await client.send(.get("/api/omni/threads")) }
        XCTAssertEqual(try store.token(for: origin), TestTokens.device)
        XCTAssertEqual(signals.value, 0)
    }

    func test401WithAnUnknownAnswerKeepsTheToken() async throws {
        for answer in [StubAnswer.json(502, "<html>"), .failure(.timedOut), .json(200, "<html>portal</html>")] {
            let server = StubServer { r in r.path == "/auth/me" ? answer : .json(401, "{}") }
            let (client, store) = try makeClient(server)
            await assertThrows(.unauthorized) { try await client.send(.get("/api/omni/threads")) }
            XCTAssertEqual(try store.token(for: origin), TestTokens.device, "unknown is not dead")
        }
    }

    func testABurstOf401sSignalsOnce() async throws {
        let signals = Counter()
        let server = StubServer { _ in .json(401, "{}") }
        let (client, _) = try makeClient(server) { signals.increment() }
        await withTaskGroup(of: Void.self) { group in
            for _ in 0..<8 {
                group.addTask { _ = try? await client.send(.get("/api/omni/threads")) }
            }
        }
        XCTAssertEqual(signals.value, 1)
    }

    func testA401ForAReplacedTokenIsIgnored() async throws {
        let store = InMemoryTokenStore()
        try store.setToken(TestTokens.device, for: origin)
        let origin = self.origin
        // The person signs in again while the old request is in flight.
        let server = StubServer { r in
            if r.path == "/auth/me" { return .json(401, "{}") }
            try? store.setToken(TestTokens.other, for: origin)
            return .json(401, "{}")
        }
        let client = PrismClient(origin: origin, tokenStore: store, session: server.session)
        await assertThrows(.unauthorized) { try await client.send(.get("/api/omni/threads")) }
        XCTAssertEqual(try store.token(for: origin), TestTokens.other, "the new token is untouched")
        XCTAssertEqual(server.requests.map(\.path), ["/api/omni/threads"], "no /auth/me question for a token that is no longer current")
    }

    // MARK: idempotency + JSON

    func testIdempotencyKeyValidation() {
        XCTAssertNil(IdempotencyKey("short"))
        XCTAssertNil(IdempotencyKey("has space 12345"))
        XCTAssertNil(IdempotencyKey("ünïcödé-key-1"))
        XCTAssertNil(IdempotencyKey(String(repeating: "a", count: 201)))
        XCTAssertNil(IdempotencyKey("line\nbreak-1234"))
        XCTAssertEqual(IdempotencyKey("abc.DEF_123:x-y")?.value, "abc.DEF_123:x-y")
        XCTAssertEqual(IdempotencyKey(String(repeating: "a", count: 200))?.value.count, 200)
        XCTAssertNotEqual(IdempotencyKey.random(), IdempotencyKey.random())
        XCTAssertNotNil(IdempotencyKey(IdempotencyKey.random().value))
    }

    func testMutationsSendJSONAndTheIdempotencyKey() async throws {
        let server = StubServer { _ in .json(200, "{}", headers: ["Idempotent-Replayed": "true"]) }
        let (client, _) = try makeClient(server)
        struct Body: Encodable {
            let text: String
            let at: Date
        }
        let key = IdempotencyKey("key-12345678")!
        let r1 = try await client.send(.json("POST", "/api/x", body: Body(text: "a/b ☃", at: Date(timeIntervalSince1970: 1_760_000_000.5)), idempotencyKey: key))
        XCTAssertTrue(r1.isIdempotentReplay)
        XCTAssertEqual(r1.header("idempotent-replayed"), "true")
        _ = try await client.send(PrismRequest(method: "POST", path: "/api/y"))
        let a = server.requests[0], b = server.requests[1]
        XCTAssertEqual(a.header("Idempotency-Key"), "key-12345678")
        XCTAssertEqual(a.header("Content-Type"), "application/json")
        let sent = try PrismJSON.decoder().decode(JSONValue.self, from: a.body)
        XCTAssertEqual(sent["text"]?.stringValue, "a/b ☃")
        XCTAssertEqual(sent["at"]?.stringValue, "2025-10-09T08:53:20.500Z")
        XCTAssertNil(b.header("Idempotency-Key"))
        XCTAssertEqual(b.bodyString, "{}", "a body-less mutation still sends a JSON object (415 otherwise)")
        XCTAssertEqual(b.header("Content-Type"), "application/json")
    }

    func testDatesDecodeWithAndWithoutFractionalSeconds() throws {
        struct D: Decodable { let a: Date; let b: Date }
        let d = try PrismJSON.decoder().decode(D.self, from: Data(#"{"a":"2026-10-08T15:04:00.000Z","b":"2026-10-08T15:04:00Z"}"#.utf8))
        XCTAssertEqual(d.a, d.b)
        XCTAssertThrowsError(try PrismJSON.decoder().decode(D.self, from: Data(#"{"a":"yesterday","b":"2026-10-08T15:04:00Z"}"#.utf8)))
    }

    // MARK: streaming

    func testOpenStreamYieldsTheBodyAndMapsANon200() async throws {
        let server = StubServer { r in
            r.path == "/ok" ? .sse(["event: a\nda", "ta: 1\n\n", ": ping\n\n"]) : .json(429, #"{"error":"too_many_streams"}"#)
        }
        let (client, _) = try makeClient(server)
        var body = Data()
        for try await chunk in try await client.openStream(.get("/ok")) { body.append(chunk) }
        XCTAssertEqual(String(decoding: body, as: UTF8.self), "event: a\ndata: 1\n\n: ping\n\n")
        XCTAssertEqual(server.requests[0].header("Accept"), "text/event-stream")
        XCTAssertEqual(server.requests[0].header("Authorization"), "Bearer \(TestTokens.device)")
        do {
            _ = try await client.openStream(.get("/busy"))
            XCTFail("expected 429")
        } catch {
            XCTAssertEqual((error as? PrismError)?.serverCode, "too_many_streams")
        }
    }
}

final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var n = 0
    func increment() { lock.lock(); n += 1; lock.unlock() }
    var value: Int { lock.lock(); defer { lock.unlock() }; return n }
}
