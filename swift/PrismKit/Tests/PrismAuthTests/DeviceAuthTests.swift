import Foundation
@testable import PrismAuth
import PrismTestSupport
import XCTest

/// A browser leg with no browser: returns a scripted redirect.
struct FakeFlow: RedirectFlow {
    var redirectURI = "prism://auth/callback"
    /// Builds the URL "the browser" was redirected to from the authorize URL it was shown.
    var respond: @Sendable (_ authorize: [String: String]) -> String

    func start() async throws -> any RedirectFlowSession { Session(redirectURI: redirectURI, respond: respond) }

    struct Session: RedirectFlowSession {
        let redirectURI: String
        let respond: @Sendable ([String: String]) -> String
        func waitForCode(authorizeURL: URL, expectedState: String) async throws -> String {
            let q = Dictionary(FormEncoding.decode(authorizeURL.query(percentEncoded: true) ?? ""), uniquingKeysWith: { a, _ in a })
            return try PKCE.codeFromRedirect(respond(q), redirectURI: redirectURI, expectedState: expectedState)
        }
    }
}

final class DeviceAuthTests: XCTestCase {
    let origin = try! ServerOrigin("https://prism.example.com")
    let tokenJSON = #"{"access_token":"\#(TestTokens.device)","token_type":"Bearer","expires_in":7776000,"device_id":"dev_1"}"#

    // MARK: token response parsing (ported from auth.rs)

    func testTokenResponseParsing() throws {
        let ok = try DeviceAuthClient.parseTokenResponse(status: 200, body: Data(tokenJSON.utf8))
        XCTAssertEqual(ok.accessToken, TestTokens.device)
        XCTAssertEqual(ok.deviceID, "dev_1")
        XCTAssertEqual(ok.expiresIn, 7_776_000)
        XCTAssertFalse("\(ok)".contains(TestTokens.device), "the description never shows the token")
        XCTAssertFalse(String(reflecting: ok).contains(TestTokens.device))

        func fails(_ status: Int, _ body: String, _ expected: DeviceAuthError, line: UInt = #line) {
            XCTAssertThrowsError(try DeviceAuthClient.parseTokenResponse(status: status, body: Data(body.utf8)), line: line) { XCTAssertEqual($0 as? DeviceAuthError, expected, line: line) }
        }
        fails(200, #"{"access_token":"\#(TestTokens.device)","token_type":"mac"}"#, .unexpectedTokenType)
        fails(200, #"{"access_token":"eyJhbGciOi.jwt.like","token_type":"Bearer"}"#, .unexpectedTokenFormat)
        fails(200, #"{"access_token":"pd_short","token_type":"Bearer"}"#, .unexpectedTokenFormat)
        fails(200, #"{"access_token":"pd_\#(String(repeating: "A", count: 30)) x","token_type":"Bearer"}"#, .unexpectedTokenFormat)
        fails(200, "not json", .unexpectedTokenResponse)
        fails(200, #"{"token_type":"Bearer"}"#, .unexpectedTokenResponse)
        fails(400, #"{"error":"invalid_grant","error_description":"code expired"}"#, .server(code: "invalid_grant", description: "code expired", status: 400))
        fails(400, #"{"error":"invalid_request"}"#, .server(code: "invalid_request", description: nil, status: 400))
        fails(400, #"{"error":"unsupported_grant_type"}"#, .server(code: "unsupported_grant_type", description: nil, status: 400))
        fails(401, #"{"error":"invalid_client"}"#, .server(code: "invalid_client", description: nil, status: 401))
        fails(400, #"{"error":"<b>x</b>","error_description":"a\u0007b"}"#, .server(code: "bxb", description: "ab", status: 400))
        fails(429, "slow down", .http(status: 429))
        fails(502, "<html>", .http(status: 502))
    }

    // MARK: exchange over the (stubbed) wire

    func testExchangePostsThePKCEFormToTheOriginOnly() async throws {
        let json = tokenJSON
        let server = StubServer { _ in .json(200, json) }
        let client = DeviceAuthClient(origin: origin, session: server.session)
        let cred = try await client.exchange(code: "the code+/=", verifier: "ver1fier", redirectURI: "http://127.0.0.1:50123/callback")
        XCTAssertEqual(cred.accessToken, TestTokens.device)
        let r = try XCTUnwrap(server.requests.first)
        XCTAssertEqual(server.requests.count, 1)
        XCTAssertEqual(r.method, "POST")
        XCTAssertEqual(r.url.absoluteString, "https://prism.example.com/auth/device/token")
        XCTAssertEqual(r.header("Content-Type"), "application/x-www-form-urlencoded")
        XCTAssertNil(r.header("Authorization"), "the token endpoint takes no credential (PKCE)")
        XCTAssertNil(r.header("Cookie"))
        let form = Dictionary(FormEncoding.decode(r.bodyString), uniquingKeysWith: { a, _ in a })
        XCTAssertEqual(form, ["grant_type": "authorization_code", "code": "the code+/=", "code_verifier": "ver1fier", "redirect_uri": "http://127.0.0.1:50123/callback", "client_id": "prism-native"])
        XCTAssertTrue(r.bodyString.contains("code=the%20code%2B%2F%3D"), "strictly percent-encoded: \(r.bodyString)")
    }

    func testExchangeErrorPaths() async throws {
        let cases: [(StubAnswer, DeviceAuthError)] = [
            (.json(400, #"{"error":"invalid_grant","error_description":"bad code"}"#), .server(code: "invalid_grant", description: "bad code", status: 400)),
            (.json(429, #"{"error":"rate_limited"}"#), .server(code: "rate_limited", description: nil, status: 429)),
            (.json(500, "oops"), .http(status: 500)),
            (.json(200, #"{"access_token":"not-a-device-token","token_type":"Bearer"}"#), .unexpectedTokenFormat),
            (.failure(.cannotConnectToHost), .unreachable("connection refused")),
            (.failure(.timedOut), .unreachable("timed out")),
            (.failure(.notConnectedToInternet), .unreachable("offline")),
        ]
        for (answer, expected) in cases {
            let server = StubServer { _ in answer }
            let client = DeviceAuthClient(origin: origin, session: server.session)
            do {
                _ = try await client.exchange(code: "c", verifier: "v", redirectURI: "prism://auth/callback")
                XCTFail("expected \(expected)")
            } catch {
                XCTAssertEqual(error as? DeviceAuthError, expected)
                XCTAssertFalse("\(error)".contains("prism.example.com"), "errors never carry the URL")
            }
        }
    }

    func testExchangeNeverFollowsARedirect() async throws {
        let server = StubServer { r in
            r.url.host == "prism.example.com" ? .redirect(status: 307, to: "https://evil.example.net/auth/device/token") : .json(200, #"{"access_token":"pd_\#(String(repeating: "E", count: 43))","token_type":"Bearer"}"#)
        }
        let client = DeviceAuthClient(origin: origin, session: server.session)
        do {
            _ = try await client.exchange(code: "c", verifier: "v", redirectURI: "prism://auth/callback")
            XCTFail("a redirected token call must fail")
        } catch {
            XCTAssertEqual(error as? DeviceAuthError, .redirectRefused(status: 307))
        }
        XCTAssertEqual(server.requests.map(\.url.host), ["prism.example.com"], "the code and verifier never reach another host")
    }

    func testLiveness() async {
        func liveness(_ answer: StubAnswer) async -> TokenLiveness {
            let server = StubServer { _ in answer }
            let l = await DeviceAuthClient(origin: origin, session: server.session).liveness(of: TestTokens.device)
            XCTAssertEqual(server.requests.first?.path, "/auth/me")
            XCTAssertEqual(server.requests.first?.header("Authorization"), "Bearer \(TestTokens.device)")
            return l
        }
        var l = await liveness(.json(200, #"{"authenticated":true,"email":"owner@example.com"}"#))
        XCTAssertEqual(l, .alive)
        l = await liveness(.json(401, #"{"error":"unauthorized"}"#))
        XCTAssertEqual(l, .dead)
        l = await liveness(.json(200, #"{"authenticated":false}"#))
        XCTAssertEqual(l, .unknown)
        l = await liveness(.json(502, "<html>bad gateway</html>"))
        XCTAssertEqual(l, .unknown)
        l = await liveness(.json(200, "<html>captive portal</html>"))
        XCTAssertEqual(l, .unknown)
        l = await liveness(.failure(.timedOut))
        XCTAssertEqual(l, .unknown)
        l = await liveness(.redirect(status: 302, to: "https://evil.example.net/auth/me"))
        XCTAssertEqual(l, .unknown)
    }

    // MARK: the whole flow, UI-free

    func testSignInStoresTheTokenAndSignOutRevokesAndForgets() async throws {
        let json = tokenJSON
        let server = StubServer { r in
            switch r.path {
            case "/auth/device/token": return .json(200, json)
            case "/auth/device/revoke": return .json(200, "{}")
            default: return .json(404, "{}")
            }
        }
        let store = InMemoryTokenStore()
        let signIn = DeviceSignIn(origin: origin, tokenStore: store, session: server.session)
        XCTAssertFalse(signIn.hasToken)

        let seenAuthorize = Captured<[String: String]>()
        let flow = FakeFlow { q in
            seenAuthorize.set(q)
            return "prism://auth/callback?code=CODE123&state=\(q["state"]!)"
        }
        let cred = try await signIn.signIn(using: flow, label: "Omni (test)")
        XCTAssertEqual(cred.deviceID, "dev_1")
        XCTAssertEqual(try store.token(for: origin), TestTokens.device)
        XCTAssertTrue(signIn.hasToken)

        let authorize = try XCTUnwrap(seenAuthorize.value)
        XCTAssertEqual(authorize["redirect_uri"], "prism://auth/callback")
        XCTAssertEqual(authorize["label"], "Omni (test)")
        let form = Dictionary(FormEncoding.decode(server.requests[0].bodyString), uniquingKeysWith: { a, _ in a })
        XCTAssertEqual(form["code"], "CODE123")
        XCTAssertEqual(form["redirect_uri"], "prism://auth/callback")
        XCTAssertEqual(PKCE.challengeS256(form["code_verifier"]!), authorize["code_challenge"], "the verifier sent matches the challenge shown")

        let out = await signIn.signOut()
        XCTAssertEqual(out, .revoked)
        XCTAssertNil(try store.token(for: origin))
        let revoke = try XCTUnwrap(server.requests.last)
        XCTAssertEqual(revoke.path, "/auth/device/revoke")
        XCTAssertEqual(revoke.bodyString, "token=\(TestTokens.device)")
        let again = await signIn.signOut()
        XCTAssertEqual(again, .notSignedIn)
    }

    func testSignInRefusesAForgedRedirectAndStoresNothing() async throws {
        let json = tokenJSON
        let responses: [(@Sendable ([String: String]) -> String, DeviceAuthError)] = [
            ({ _ in "prism://auth/callback?code=STOLEN&state=attacker" }, .stateMismatch),
            ({ q in "prism://evil/callback?code=X&state=\(q["state"]!)" }, .redirectMismatch),
            ({ q in "https://prism.example.com/auth/callback?code=X&state=\(q["state"]!)" }, .redirectMismatch),
            ({ q in "prism://auth/callback?error=access_denied&state=\(q["state"]!)" }, .denied("access_denied")),
            ({ q in "prism://auth/callback?state=\(q["state"]!)" }, .malformedCallback),
        ]
        for (respond, expected) in responses {
            let server = StubServer { _ in .json(200, json) }
            let store = InMemoryTokenStore()
            let signIn = DeviceSignIn(origin: origin, tokenStore: store, session: server.session)
            do {
                try await signIn.signIn(using: FakeFlow(respond: respond), label: "x")
                XCTFail("expected \(expected)")
            } catch {
                XCTAssertEqual(error as? DeviceAuthError, expected)
            }
            XCTAssertTrue(server.requests.isEmpty, "no token call is made for a refused redirect")
            XCTAssertNil(try store.token(for: origin))
        }
    }

    func testSignInWithAFailedExchangeStoresNothing() async throws {
        let server = StubServer { _ in .json(400, #"{"error":"invalid_grant"}"#) }
        let store = InMemoryTokenStore()
        let signIn = DeviceSignIn(origin: origin, tokenStore: store, session: server.session)
        do {
            try await signIn.signIn(using: FakeFlow { q in "prism://auth/callback?code=C&state=\(q["state"]!)" }, label: "x")
            XCTFail("expected invalid_grant")
        } catch {
            XCTAssertEqual(error as? DeviceAuthError, .server(code: "invalid_grant", description: nil, status: 400))
        }
        XCTAssertNil(try store.token(for: origin))
    }

    func testSignOutForgetsEvenWhenTheServerIsUnreachable() async throws {
        let server = StubServer { _ in .failure(.notConnectedToInternet) }
        let store = InMemoryTokenStore()
        try store.setToken(TestTokens.device, for: origin)
        let out = await DeviceSignIn(origin: origin, tokenStore: store, session: server.session).signOut()
        guard case .forgottenLocally(let reason) = out else { return XCTFail("\(out)") }
        XCTAssertFalse(reason.contains(TestTokens.device))
        XCTAssertNil(try store.token(for: origin))
    }

    func testTokensAreKeptPerOrigin() throws {
        let store = InMemoryTokenStore()
        let other = try ServerOrigin("https://other.example.com")
        try store.setToken(TestTokens.device, for: origin)
        XCTAssertNil(try store.token(for: other))
        try store.setToken(TestTokens.other, for: other)
        try store.removeToken(for: origin)
        XCTAssertNil(try store.token(for: origin))
        XCTAssertEqual(try store.token(for: other), TestTokens.other)
    }

    // MARK: loopback listener (in-process, 127.0.0.1 only)

    func testLoopbackListenerAcceptsOnlyTheMatchingCallback() async throws {
        let listener: LoopbackRedirectListener
        do { listener = try await LoopbackRedirectListener.bind() } catch { throw XCTSkip("loopback sockets are unavailable in this sandbox: \(error)") }
        XCTAssertTrue(listener.redirectURI.hasPrefix("http://127.0.0.1:"))
        XCTAssertTrue(listener.redirectURI.hasSuffix("/callback"))
        XCTAssertGreaterThanOrEqual(listener.port, 1024)
        let base = "http://127.0.0.1:\(listener.port)"
        async let code = listener.waitForCode(expectedState: "STATE1", timeout: .seconds(10))
        try await Task.sleep(for: .milliseconds(50))
        let session = URLSession(configuration: .ephemeral)
        func status(_ path: String) async throws -> Int {
            let (_, r) = try await session.data(from: URL(string: base + path)!)
            return (r as! HTTPURLResponse).statusCode
        }
        // Wrong path, wrong state, no state: refused, and the sign-in is still waiting.
        var s = try await status("/other?code=X&state=STATE1")
        XCTAssertEqual(s, 404)
        s = try await status("/callback?code=EVIL&state=WRONG")
        XCTAssertEqual(s, 400)
        s = try await status("/callback?code=EVIL")
        XCTAssertEqual(s, 400)
        s = try await status("/callback?code=GOOD&state=STATE1")
        XCTAssertEqual(s, 200)
        let got = try await code
        XCTAssertEqual(got, "GOOD")
    }

    /// First-run fix: after the real callback, a repeat of it (reload, a browser's retry or
    /// preview) and stray requests (favicon) are answered calmly and deliver nothing.
    func testLoopbackListenerAnswersARepeatedCallbackWithoutDeliveringAnything() async throws {
        var holder: LoopbackRedirectListener?
        do { holder = try await LoopbackRedirectListener.bind() } catch { throw XCTSkip("loopback sockets are unavailable in this sandbox: \(error)") }
        let base = "http://127.0.0.1:\(holder!.port)"
        let session = URLSession(configuration: .ephemeral)
        func get(_ path: String) async throws -> (Int, String) {
            let (d, r) = try await session.data(from: URL(string: base + path)!)
            return ((r as! HTTPURLResponse).statusCode, String(decoding: d, as: UTF8.self))
        }
        let waiting = Task { [listener = holder!] in try await listener.waitForCode(expectedState: "STATE1", timeout: .seconds(10)) }
        try await Task.sleep(for: .milliseconds(50))
        var r = try await get("/favicon.ico")
        XCTAssertEqual(r.0, 404)
        r = try await get("/callback?code=GOOD&state=STATE1")
        XCTAssertEqual(r.0, 200)
        let got = try await waiting.value
        XCTAssertEqual(got, "GOOD")
        // The flow drops its reference once it has the code; the listener must still answer.
        holder = nil
        try await Task.sleep(for: .milliseconds(400))
        r = try await get("/callback?code=GOOD&state=STATE1")
        XCTAssertEqual(r.0, 200)
        XCTAssertTrue(r.1.contains("Signed in"))
        // Another code with our state changes nothing (the first one was the sign-in)…
        r = try await get("/callback?code=OTHER&state=STATE1")
        XCTAssertEqual(r.0, 200)
        // …and everything else is still refused.
        r = try await get("/callback?code=EVIL&state=WRONG")
        XCTAssertEqual(r.0, 404)
        r = try await get("/favicon.ico")
        XCTAssertEqual(r.0, 404)
    }

    func testLoopbackRepeatPagesNeverCarryAnOutcome() {
        typealias L = LoopbackRedirectListener
        for ending in [L.Ending.signedIn, .denied, .failed] {
            for line in ["GET /callback?code=X&state=S HTTP/1.1", "GET /callback?error=access_denied&state=S HTTP/1.1", "GET /callback?state=S HTTP/1.1", "GET /callback?code=X&state=NOPE HTTP/1.1", "GET / HTTP/1.1", "POST /callback?code=X&state=S HTTP/1.1"] {
                XCTAssertNil(L.respond(to: line, expectedState: "S", alreadyEnded: ending).2, "\(ending) \(line)")
            }
        }
        XCTAssertEqual(L.respond(to: "GET /callback?code=X&state=S HTTP/1.1", expectedState: "S", alreadyEnded: .signedIn).0, 200)
        XCTAssertEqual(L.respond(to: "GET /callback?code=X&state=S HTTP/1.1", expectedState: "S", alreadyEnded: .failed).0, 400)
        // Before the end, the same line still completes the sign-in exactly once.
        if case .success(let code)? = L.respond(to: "GET /callback?code=X&state=S HTTP/1.1", expectedState: "S").2 { XCTAssertEqual(code, "X") } else { XCTFail("expected the code") }
    }

    func testLoopbackListenerTimesOutAndCancels() async throws {
        let a: LoopbackRedirectListener
        do { a = try await LoopbackRedirectListener.bind() } catch { throw XCTSkip("loopback sockets are unavailable in this sandbox") }
        do {
            _ = try await a.waitForCode(expectedState: "S", timeout: .milliseconds(50))
            XCTFail("expected a timeout")
        } catch {
            XCTAssertEqual(error as? DeviceAuthError, .timedOut)
        }
        let b = try await LoopbackRedirectListener.bind()
        let task = Task { try await b.waitForCode(expectedState: "S", timeout: .seconds(30)) }
        try await Task.sleep(for: .milliseconds(50))
        task.cancel()
        do {
            _ = try await task.value
            XCTFail("expected cancellation")
        } catch {
            XCTAssertEqual(error as? DeviceAuthError, .cancelled)
        }
    }

    // MARK: Keychain (compile check; the real Keychain is never touched by default)

    func testKeychainStoreRoundTrip() throws {
        guard ProcessInfo.processInfo.environment["PRISMKIT_KEYCHAIN_TESTS"] == "1" else {
            // Compile check only: the type exists and conforms.
            let store: any TokenStore = KeychainTokenStore(service: "com.example.prismkit.tests")
            _ = store
            throw XCTSkip("set PRISMKIT_KEYCHAIN_TESTS=1 to exercise the real login keychain")
        }
        let store = KeychainTokenStore(service: "com.example.prismkit.tests", useDataProtectionKeychain: false)
        let o = try ServerOrigin("https://keychain-test.example.com")
        try store.removeToken(for: o)
        XCTAssertNil(try store.token(for: o))
        try store.setToken(TestTokens.device, for: o)
        XCTAssertEqual(try store.token(for: o), TestTokens.device)
        try store.setToken(TestTokens.other, for: o)
        XCTAssertEqual(try store.token(for: o), TestTokens.other)
        try store.removeToken(for: o)
        XCTAssertNil(try store.token(for: o))
    }
}

/// A value captured from a `@Sendable` closure.
final class Captured<T: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: T?
    func set(_ v: T) { lock.lock(); stored = v; lock.unlock() }
    var value: T? { lock.lock(); defer { lock.unlock() }; return stored }
}
