import Foundation
@testable import PrismAuth
import XCTest

final class PKCETests: XCTestCase {
    func testRFC7636AppendixBVector() {
        XCTAssertEqual(PKCE.challengeS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    }

    func testRFC7636AppendixBOctetsEncodeToTheVerifier() {
        // RFC 7636 App. B: these 32 octets base64url-encode to the verifier above.
        let octets: [UInt8] = [116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186, 22, 212, 37, 77, 105, 214, 191, 240, 91, 88, 5, 88, 83, 132, 141, 121]
        XCTAssertEqual(PKCE.base64URL(Data(octets)), "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
    }

    func testSessionShape() throws {
        let s = try PKCESession()
        XCTAssertEqual(s.verifier.count, 43)
        XCTAssertTrue(s.verifier.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") })
        XCTAssertEqual(s.challenge.count, 43, "the server requires a 43-char challenge")
        XCTAssertEqual(s.challenge, PKCE.challengeS256(s.verifier))
        XCTAssertNotEqual(s.verifier, s.state)
        XCTAssertNotEqual(try PKCESession().verifier, s.verifier, "fresh randomness per attempt")
        XCTAssertFalse("\(s)".contains(s.verifier), "the description never shows the verifier")
        XCTAssertFalse(String(reflecting: s).contains(s.state))
    }

    func testAuthorizeURLCarriesEveryParamAndNeverTheVerifier() throws {
        let origin = try ServerOrigin("https://prism.example.com")
        let s = try PKCESession()
        let url = try PKCE.authorizeURL(origin: origin, configuration: .prismNative, redirectURI: "http://127.0.0.1:50123/callback", session: s, label: "Omni on Ben's Mac & co + 1")
        XCTAssertTrue(origin.contains(url))
        XCTAssertEqual(url.path, "/auth/device/authorize")
        let q = Dictionary(uniqueKeysWithValues: FormEncoding.decode(url.query(percentEncoded: true) ?? "").map { ($0.0, $0.1) })
        XCTAssertEqual(q["client_id"], "prism-native")
        XCTAssertEqual(q["response_type"], "code")
        XCTAssertEqual(q["redirect_uri"], "http://127.0.0.1:50123/callback")
        XCTAssertEqual(q["code_challenge_method"], "S256")
        XCTAssertEqual(q["code_challenge"], s.challenge)
        XCTAssertEqual(q["state"], s.state)
        XCTAssertEqual(q["label"], "Omni on Ben's Mac & co + 1", "& and + survive the round trip")
        XCTAssertNil(q["code_verifier"])
        XCTAssertFalse(url.absoluteString.contains(s.verifier))
        XCTAssertEqual(q.count, 7)
    }

    func testDeviceLabelIsBounded() {
        XCTAssertEqual(PKCE.deviceLabel("  Omni\u{0}\n on Mac  "), "Omni on Mac")
        XCTAssertEqual(PKCE.deviceLabel(String(repeating: "x", count: 200)).count, 80)
    }

    func testConstantTimeEquals() {
        XCTAssertTrue(PKCE.constantTimeEquals("abc", "abc"))
        XCTAssertFalse(PKCE.constantTimeEquals("abc", "abd"))
        XCTAssertFalse(PKCE.constantTimeEquals("abc", "abcd"))
        XCTAssertFalse(PKCE.constantTimeEquals("", "a"))
    }

    func testCallbackParsing() {
        let st = "S7ate"
        XCTAssertEqual(PKCE.parseCallbackQuery("code=abc&state=S7ate", expectedState: st), .code("abc"))
        XCTAssertEqual(PKCE.parseCallbackQuery("state=S7ate&code=a%2Bb", expectedState: st), .code("a+b"))
        XCTAssertEqual(PKCE.parseCallbackQuery("code=abc&state=nope", expectedState: st), .stateMismatch)
        XCTAssertEqual(PKCE.parseCallbackQuery("code=abc", expectedState: st), .stateMismatch)
        XCTAssertEqual(PKCE.parseCallbackQuery("", expectedState: st), .stateMismatch)
        XCTAssertEqual(PKCE.parseCallbackQuery("error=access_denied&state=S7ate", expectedState: st), .denied("access_denied"))
        // An error with the wrong state is not ours: ignored, not "denied".
        XCTAssertEqual(PKCE.parseCallbackQuery("error=access_denied&state=x", expectedState: st), .stateMismatch)
        XCTAssertEqual(PKCE.parseCallbackQuery("state=S7ate", expectedState: st), .malformed)
        XCTAssertEqual(PKCE.parseCallbackQuery("state=S7ate&code=", expectedState: st), .malformed)
        XCTAssertEqual(PKCE.parseCallbackQuery("state=S7ate&code=" + String(repeating: "c", count: 513), expectedState: st), .malformed)
        XCTAssertEqual(PKCE.parseCallbackQuery("error=%3Cscript%3Ebad&state=S7ate", expectedState: st), .denied("scriptbad"))
        // First occurrence wins: a second state cannot rescue a wrong first one.
        XCTAssertEqual(PKCE.parseCallbackQuery("state=evil&code=abc&state=S7ate", expectedState: st), .stateMismatch)
        XCTAssertEqual(PKCE.parseCallbackQuery("code=first&code=second&state=S7ate", expectedState: st), .code("first"))
        // An empty expected state never matches an empty returned one.
        XCTAssertEqual(PKCE.parseCallbackQuery("code=abc&state=", expectedState: ""), .stateMismatch)
    }

    func testRedirectMustBeExact() throws {
        let r = DeviceAuthConfiguration.prismNative.redirectURI
        XCTAssertEqual(try PKCE.codeFromRedirect("prism://auth/callback?code=abc&state=S", redirectURI: r, expectedState: "S"), "abc")
        let refused: [(String, DeviceAuthError)] = [
            ("prism://auth/callback?code=abc&state=X", .stateMismatch), // not our state
            ("prism://auth/callbackX?code=abc&state=S", .redirectMismatch), // another path
            ("prism://auth/callback/?code=abc&state=S", .redirectMismatch), // trailing slash
            ("prism://evil/callback?code=abc&state=S", .redirectMismatch), // another host
            ("evil://auth/callback?code=abc&state=S", .redirectMismatch), // another scheme
            ("PRISM://auth/callback?code=abc&state=S", .redirectMismatch), // not byte-exact
            ("prism://auth/callback?state=S", .malformedCallback), // no code
            ("prism://auth/callback?code=abc&state=S#f", .redirectMismatch), // a fragment
            ("prism://auth/callback", .stateMismatch),
            ("prism://user@auth/callback?code=abc&state=S", .redirectMismatch),
        ]
        for (url, expected) in refused {
            XCTAssertThrowsError(try PKCE.codeFromRedirect(url, redirectURI: r, expectedState: "S"), url) { XCTAssertEqual($0 as? DeviceAuthError, expected, url) }
        }
        XCTAssertThrowsError(try PKCE.codeFromRedirect("prism://auth/callback?error=access_denied&state=S", redirectURI: r, expectedState: "S")) {
            XCTAssertEqual($0 as? DeviceAuthError, .denied("access_denied"))
        }
    }

    func testLoopbackRequestLineClassification() {
        enum L {
            static func classify(_ line: String, _ state: String?) -> String {
                switch LoopbackRedirectListener.classify(requestLine: line, expectedState: state) {
                case .notFound: return "notFound"
                case .ignored: return "ignored"
                case .done(.code(let c)): return "code:\(c)"
                case .done(.denied(let e)): return "denied:\(e)"
                case .done(.malformed): return "malformed"
                case .done(.stateMismatch): return "stateMismatch"
                }
            }
        }
        XCTAssertEqual(L.classify("GET /callback?code=abc&state=S HTTP/1.1", "S"), "code:abc")
        XCTAssertEqual(L.classify("GET /callback?error=access_denied&state=S HTTP/1.1", "S"), "denied:access_denied")
        XCTAssertEqual(L.classify("GET /callback?code=abc&state=X HTTP/1.1", "S"), "ignored")
        XCTAssertEqual(L.classify("GET /callback?code=abc HTTP/1.1", "S"), "ignored")
        XCTAssertEqual(L.classify("GET /callback?state=S HTTP/1.1", "S"), "malformed")
        XCTAssertEqual(L.classify("POST /callback?code=abc&state=S HTTP/1.1", "S"), "notFound")
        XCTAssertEqual(L.classify("GET /other?code=abc&state=S HTTP/1.1", "S"), "notFound")
        XCTAssertEqual(L.classify("GET /callback/?code=abc&state=S HTTP/1.1", "S"), "notFound")
        XCTAssertEqual(L.classify("GET /callback?code=abc&state=S HTTP/2", "S"), "notFound")
        XCTAssertEqual(L.classify("garbage", "S"), "notFound")
        XCTAssertEqual(L.classify("GET /callback?code=abc&state=S HTTP/1.1", nil), "ignored", "before an attempt is waiting nothing can complete")
    }
}

final class ServerOriginTests: XCTestCase {
    func testAcceptsAndNormalises() throws {
        XCTAssertEqual(try ServerOrigin("https://prism.example.com").value, "https://prism.example.com")
        XCTAssertEqual(try ServerOrigin("  HTTPS://Prism.Example.COM/  ").value, "https://prism.example.com")
        XCTAssertEqual(try ServerOrigin("https://prism.example.com.").value, "https://prism.example.com")
        XCTAssertEqual(try ServerOrigin("https://prism.example.com:8443").value, "https://prism.example.com:8443")
        XCTAssertEqual(try ServerOrigin("http://127.0.0.1:8788").value, "http://127.0.0.1:8788")
        XCTAssertEqual(try ServerOrigin("http://localhost:3000").value, "http://localhost:3000")
        XCTAssertEqual(try ServerOrigin("http://[::1]:3000").value, "http://[::1]:3000")
        XCTAssertEqual(try ServerOrigin("https://100.64.0.7").value, "https://100.64.0.7")
        XCTAssertEqual(try ServerOrigin("https://mini.tailnet-name.ts.net").host, "mini.tailnet-name.ts.net")
    }

    func testRefusals() {
        let cases: [(String, ServerOriginError)] = [
            ("", .empty),
            ("   ", .empty),
            ("prism.example.com", .notAURL),
            ("http://prism.example.com", .insecureScheme),
            ("http://127.0.0.1.evil.com", .insecureScheme),
            ("ftp://prism.example.com", .unsupportedScheme("ftp")),
            ("prism://auth/callback", .unsupportedScheme("prism")),
            ("https://user@prism.example.com", .hasUserInfo),
            ("https://user:pw@prism.example.com", .hasUserInfo),
            ("https://prism.example.com@evil.com", .hasUserInfo),
            ("https://prism.example.com/api", .hasPath),
            ("https://prism.example.com?x=1", .hasQueryOrFragment),
            ("https://prism.example.com/#f", .hasQueryOrFragment),
            ("https://*.evil.com", .invalidHost),
            ("https://x.com;frame-src", .invalidHost),
            ("https://-bad.example.com", .invalidHost),
            ("https://exa mple.com", .invalidHost),
            ("https://prism.example.com\\@evil.com", .invalidHost),
            ("https://prism.exämple.com", .invalidHost),
            ("https://", .invalidHost),
            ("https://prism.example.com:99999", .invalidHost),
            ("https://prism.example.com:abc", .invalidHost),
            ("http://127.0.0.1:1940", .forbiddenPort(1940)),
            ("http://localhost:1939", .forbiddenPort(1939)),
            ("https://127.0.0.1:1940", .forbiddenPort(1940)),
        ]
        for (input, expected) in cases {
            XCTAssertThrowsError(try ServerOrigin(input), input) { XCTAssertEqual($0 as? ServerOriginError, expected, input) }
        }
    }

    func testContains() throws {
        let o = try ServerOrigin("https://prism.example.com")
        XCTAssertTrue(o.contains(URL(string: "https://prism.example.com/api/x?y=1")!))
        XCTAssertTrue(o.contains(URL(string: "https://PRISM.example.com:443/")!))
        for other in [
            "http://prism.example.com/", "https://prism.example.com:8443/", "https://prism.example.com.evil.com/", "https://evil.com/prism.example.com",
            "https://prism.example.com@evil.com/", "https://user@prism.example.com/", "wss://prism.example.com/", "https://sub.prism.example.com/",
        ] {
            XCTAssertFalse(o.contains(URL(string: other)!), other)
        }
        let local = try ServerOrigin("http://127.0.0.1:8788")
        XCTAssertTrue(local.contains(URL(string: "http://127.0.0.1:8788/x")!))
        XCTAssertFalse(local.contains(URL(string: "http://127.0.0.1:8787/x")!))
        XCTAssertFalse(local.contains(URL(string: "http://localhost:8788/x")!))
    }

    func testURLBuildingStaysOnOrigin() throws {
        let o = try ServerOrigin("https://prism.example.com")
        XCTAssertEqual(try o.url(path: "/api/omni/threads", query: [URLQueryItem(name: "q", value: "a b&c=d+e")]).absoluteString, "https://prism.example.com/api/omni/threads?q=a%20b%26c%3Dd%2Be")
        XCTAssertEqual(try o.url(path: "/api/x y").absoluteString, "https://prism.example.com/api/x%20y")
        for bad in ["api/x", "//evil.com/x", "/a/../b", "/a/./b", "/a\\b", "/a?x=1", "/a#f", "https://evil.com/x", ""] {
            XCTAssertThrowsError(try o.url(path: bad), bad)
        }
    }
}
