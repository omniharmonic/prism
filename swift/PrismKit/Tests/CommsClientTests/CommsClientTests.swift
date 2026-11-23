import CommsClient
import Foundation
import PrismAuth
import PrismSSE
import PrismTestSupport
import PrismTransport
import XCTest

final class CommsClientTests: XCTestCase {
    let origin = try! ServerOrigin("https://prism.example.com")

    func make(_ handler: @escaping StubServer.Handler) throws -> (CommsClient, StubServer) {
        let server = StubServer(handler)
        let store = InMemoryTokenStore()
        try store.setToken(TestTokens.device, for: origin)
        return (CommsClient(client: PrismClient(origin: origin, tokenStore: store, session: server.session)), server)
    }

    static func fixture(_ name: String) throws -> String {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("PrismModelsTests/Fixtures/\(name)")
        return String(decoding: try Data(contentsOf: url), as: UTF8.self)
    }

    func testDecodesServerFixtures() async throws {
        let threadsJSON = try Self.fixture("comms-threads.json")
        let messagesJSON = try Self.fixture("comms-messages.json")
        let (comms, server) = try make { r in
            r.path.hasSuffix("/messages") ? .json(200, messagesJSON) : .json(200, threadsJSON)
        }
        let page = try await comms.threads(CommsThreadQuery(folder: .inbox, unreadOnly: true, networks: [.whatsapp, .telegram], search: "al & bo", cursor: "c1", limit: 20))
        XCTAssertFalse(page.threads.isEmpty)
        XCTAssertNil(page.next)
        XCTAssertEqual(server.requests[0].path, "/api/comms/threads")
        XCTAssertEqual(server.requests[0].query, ["folder": "inbox", "unread": "1", "network": "whatsapp,telegram", "q": "al & bo", "cursor": "c1", "limit": "20"])
        XCTAssertEqual(server.requests[0].header("Authorization"), "Bearer \(TestTokens.device)")

        let m = try await comms.messages(threadID: "th_room1", before: "tc_abcdefghijklmnopqrstuvwx", limit: 30)
        XCTAssertFalse(m.messages.isEmpty)
        XCTAssertEqual(server.requests[1].path, "/api/comms/threads/th_room1/messages")
        XCTAssertEqual(server.requests[1].query, ["before": "tc_abcdefghijklmnopqrstuvwx", "limit": "30"])
        XCTAssertTrue(m.messages.contains { $0.system != nil && $0.body == nil })
        XCTAssertTrue(m.messages.contains { $0.reactions.first?.senders.first?.eventId != nil })
    }

    func testThreadDetail() async throws {
        let (comms, server) = try make { _ in
            .json(200, #"{"thread":{"id":"th_1","title":"T","titleSource":"person","avatar":null,"kind":"dm","networks":["whatsapp"],"lastActivityAt":"2026-11-21T10:00:00Z","unread":{"count":2,"trusted":true},"folder":"inbox","urgency":"needs-reply","pinned":false,"muted":false,"channels":[]},"capabilities":null,"members":[{"id":"@a:x","name":"A","avatar":{"token":"tok"}}]}"#)
        }
        let d = try await comms.thread(id: "th_1")
        XCTAssertEqual(d.thread.urgency, .needsReply)
        XCTAssertNil(d.capabilities)
        XCTAssertEqual(d.members.first?.avatar, .token("tok"))
        XCTAssertEqual(server.requests[0].path, "/api/comms/threads/th_1")
        do { _ = try await comms.thread(id: "../x"); XCTFail() } catch { XCTAssertEqual((error as? PrismError), .invalidRequest("id refused")) }
    }

    func testTriageAndPersonQueryParameters() async throws {
        let (comms, server) = try make { _ in .json(200, #"{"threads":[]}"#) }
        _ = try await comms.threads(CommsThreadQuery(folder: .inbox, statuses: [.urgent, .actionRequired, .unknown("future")], attention: true, person: "p_alice-1"))
        let items = URLComponents(url: server.requests[0].url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        XCTAssertEqual(items.filter { $0.name == "status" }.map(\.value), ["urgent", "action-required", "future"])
        XCTAssertEqual(server.requests[0].query["attention"], "true")
        XCTAssertEqual(server.requests[0].query["person"], "p_alice-1")
        // Defaults send none of them.
        _ = try await comms.threads(CommsThreadQuery())
        XCTAssertEqual(server.requests[1].query, ["folder": "inbox"])
        do { _ = try await comms.threads(CommsThreadQuery(person: "../x")); XCTFail() } catch { XCTAssertEqual(error as? PrismError, .invalidRequest("id refused")) }
    }

    func testPersonEndpoint() async throws {
        let body = #"""
        {"id":"p_alice","name":"Alice Example","avatar":{"token":"t_a"},"noteId":"n1",
         "phones":[{"label":"mobile","value":"+15550100"},{"value":7}],
         "emails":[{"value":"alice@example.test"}],
         "handles":[{"network":"whatsapp","value":"+15550100","kind":"phone"},{"network":"signal","value":"+15550100","kind":"phone"},{"network":"telegram","value":"alice_ex","kind":"username"},{"network":"x","value":"a","kind":"future"}],
         "threads":[{"id":"th_1","title":"Alice Example","titleSource":"person","avatar":null,"kind":"dm","networks":["whatsapp"],"lastActivityAt":"2026-11-21T10:00:00Z","unread":{"count":0,"trusted":true},"folder":"inbox","urgency":null,"status":"action-required","pinned":false,"muted":false,"channels":[]},{"broken":true}]}
        """#
        let (comms, server) = try make { _ in .json(200, body) }
        let p = try await comms.person(id: "p_alice")
        XCTAssertEqual(server.requests[0].path, "/api/comms/people/p_alice")
        XCTAssertEqual(p.name, "Alice Example")
        XCTAssertEqual(p.avatar, .token("t_a"))
        XCTAssertEqual(p.phones, [CommsContactPoint(label: "mobile", value: "+15550100")])
        XCTAssertEqual(p.emails.map(\.value), ["alice@example.test"])
        XCTAssertEqual(p.handles.count, 4)
        XCTAssertEqual(p.handles[1].network, .unknown("signal"))
        XCTAssertEqual(p.handles[3].kind, .unknown("future"))
        XCTAssertEqual(p.threads.map(\.id), ["th_1"])
        XCTAssertEqual(p.threads[0].status, .actionRequired)
        XCTAssertEqual(p.droppedThreads, 1)
        do { _ = try await comms.person(id: "a/b"); XCTFail() } catch { XCTAssertEqual(error as? PrismError, .invalidRequest("id refused")) }
        let (gone, _) = try make { _ in .json(404, #"{"error":"person_unavailable"}"#) }
        do { _ = try await gone.person(id: "p_merged"); XCTFail() } catch { XCTAssertEqual(error as? CommsError, .personUnavailable) }
    }

    func testPersonQueryInEveryFolder() async throws {
        let (comms, server) = try make { _ in .json(200, #"{"threads":[]}"#) }
        _ = try await comms.threads(CommsThreadQuery(person: "p_a", anyFolder: true))
        XCTAssertEqual(server.requests[0].query, ["person": "p_a"])
    }

    func testStatusBurstEventWithNullThreadIsKept() async throws {
        let (comms, _) = try make { _ in
            .sse(["id: 7\nevent: thread.updated\ndata: {\"threadId\":null,\"reason\":\"status\"}\n\n"])
        }
        var e: CommsEvent?
        for try await ev in comms.stream(lastEventID: nil, policy: SSERetryPolicy(initialDelay: .milliseconds(1), jitter: 0, maxAttempts: 0)) {
            e = ev
            break
        }
        XCTAssertEqual(e?.kind, .threadUpdated)
        XCTAssertNil(e?.threadID)
        XCTAssertEqual(e?.payload["reason"]?.stringValue, "status")
        XCTAssertEqual(e?.refreshesThreadList, true)
        XCTAssertFalse(CommsEvent(id: nil, kind: .threadUpdated, payload: ["threadId": "th_1"]).refreshesThreadList)
    }

    func testThreadDetailContact() async throws {
        let (comms, _) = try make { _ in
            .json(200, #"{"thread":{"id":"th_1","title":"T","titleSource":"person","avatar":null,"kind":"dm","networks":["whatsapp"],"lastActivityAt":"2026-11-21T10:00:00Z","unread":{"count":0,"trusted":true},"folder":"inbox","urgency":null,"pinned":false,"muted":false,"channels":[]},"capabilities":null,"members":[{"id":"@a:x","name":"A","personId":"p_a"}],"contact":{"phones":[{"value":"+15550100"}]}}"#)
        }
        let d = try await comms.thread(id: "th_1")
        XCTAssertEqual(d.contact?.phones.first?.value, "+15550100")
        XCTAssertEqual(d.contact?.emails, [])
        XCTAssertEqual(d.members.first?.personId, "p_a")
        XCTAssertNil(d.thread.status)
    }

    func testHTTPErrorMapping() async throws {
        let cases: [(StubAnswer, CommsError)] = [
            (.json(503, #"{"error":"source_unavailable","network":"telegram"}"#), .sourceUnavailable(network: .telegram)),
            (.json(404, #"{"error":"thread_unavailable"}"#), .threadUnavailable),
            (.json(410, #"{"error":"expired"}"#), .mediaExpired),
            (.json(403, #"{"error":"client_scope"}"#), .clientScope),
        ]
        for (answer, expected) in cases {
            let (comms, _) = try make { _ in answer }
            do { _ = try await comms.thread(id: "th_1"); XCTFail("expected \(expected)") } catch { XCTAssertEqual(error as? CommsError, expected) }
        }
        // Everything else keeps the transport's typed errors.
        let (off, _) = try make { _ in .json(404, #"{"error":"comms_disabled"}"#) }
        do { _ = try await off.thread(id: "th_1"); XCTFail() } catch { XCTAssertEqual((error as? PrismError)?.serverCode, "comms_disabled") }
        let (other, _) = try make { _ in .json(403, #"{"error":"forbidden"}"#) }
        do { _ = try await other.threads(CommsThreadQuery()); XCTFail() } catch {
            guard case PrismError.forbidden = error else { return XCTFail("\(error)") }
        }
        let (unknownNet, _) = try make { _ in .json(503, #"{"error":"source_unavailable","network":"signal"}"#) }
        do { _ = try await unknownNet.thread(id: "th_1"); XCTFail() } catch { XCTAssertEqual(error as? CommsError, .sourceUnavailable(network: .unknown("signal"))) }
        // No network named: never invent one (it used to read as .matrix).
        for body in [#"{"error":"source_unavailable"}"#, #"{"error":"source_unavailable","network":7}"#] {
            let (anon, _) = try make { _ in .json(503, body) }
            do { _ = try await anon.thread(id: "th_1"); XCTFail() } catch { XCTAssertEqual(error as? CommsError, .sourceUnavailable(network: .unknown(""))) }
        }
    }

    func testCapabilitiesFailClosedWhenNotRestricted() async throws {
        @Sendable func caps(_ restricted: String, ops: String = #"["threads:read","messages:read","media:read","stream:read"]"#, integration: String = "comms") -> String {
            #"{"integration":"\#(integration)","clientId":"comms-native","restricted":\#(restricted),"schemaVersions":[1],"operations":\#(ops),"networks":["whatsapp","signal"]}"#
        }
        let (ok, server) = try make { _ in .json(200, caps("true")) }
        let c = try await ok.capabilities()
        XCTAssertEqual(c.networks, [.whatsapp, .unknown("signal")])
        XCTAssertEqual(server.requests[0].path, "/api/integrations/comms/capabilities")

        for body in [caps("false"), caps("true", integration: "other"), caps("true", ops: #"["threads:read"]"#), caps("true").replacingOccurrences(of: #""schemaVersions":[1]"#, with: #""schemaVersions":[2]"#), #"{"integration":"comms"}"#] {
            let (bad, _) = try make { _ in .json(200, body) }
            do { _ = try await bad.capabilities(); XCTFail("accepted \(body)") } catch {
                guard case CommsError.unsupportedServer = error else { return XCTFail("\(error)") }
            }
        }
    }

    func testMediaURLAndFetch() async throws {
        let (comms, server) = try make { r in
            r.path == "/api/comms/media/tok.en-1" ? .response(status: 200, headers: ["Content-Type": "image/jpeg"], chunks: [Data([1, 2, 3])]) : .json(410, #"{"error":"expired"}"#)
        }
        XCTAssertEqual(comms.mediaURL(token: "tok.en-1").absoluteString, "https://prism.example.com/api/comms/media/tok.en-1")
        let (data, type) = try await comms.media(token: "tok.en-1")
        XCTAssertEqual(data, Data([1, 2, 3]))
        XCTAssertEqual(type, "image/jpeg")
        XCTAssertEqual(server.requests[0].header("Authorization"), "Bearer \(TestTokens.device)")
        do { _ = try await comms.media(token: "gone"); XCTFail() } catch { XCTAssertEqual(error as? CommsError, .mediaExpired) }
    }

    func testMediaIsNotHeldToTheJSONResponseCap() async throws {
        // Owner report: big photos / videos "won't open at all" — the 32 MB JSON cap refused them.
        let server = StubServer { r in
            r.path.hasPrefix("/api/comms/media/") ? .response(status: 200, headers: ["Content-Type": "video/quicktime"], chunks: [Data(repeating: 7, count: 64)]) : .json(200, #"{"padding":"0123456789012345678901234567890123456789012345678901234567890123"}"#)
        }
        let store = InMemoryTokenStore()
        try store.setToken(TestTokens.device, for: origin)
        let comms = CommsClient(client: PrismClient(origin: origin, tokenStore: store, session: server.session, maxResponseBytes: 32))
        let (data, type) = try await comms.media(token: "big")
        XCTAssertEqual(data.count, 64)
        XCTAssertEqual(type, "video/quicktime")
        XCTAssertEqual(CommsClient.mediaMaxBytes, 200 * 1024 * 1024)
        do { _ = try await comms.capabilities(); XCTFail("JSON keeps the client's cap") } catch {}
    }

    func testRefreshMedia() async throws {
        let (comms, server) = try make { r in
            r.path == "/api/comms/media/refresh" ? .json(200, #"{"tokens":{"old.a":"new.a","old.b":null}}"#) : .json(404, "{}")
        }
        let fresh = try await comms.refreshMedia(tokens: ["old.a", "old.b"])
        XCTAssertEqual(fresh, ["old.a": "new.a"])
        XCTAssertEqual(server.requests[0].method, "POST")
        let body = try JSONSerialization.jsonObject(with: server.requests[0].body ?? Data()) as? [String: [String]]
        XCTAssertEqual(body?["tokens"], ["old.a", "old.b"])
        let none = try await comms.refreshMedia(tokens: [])
        XCTAssertEqual(none, [:])
        XCTAssertEqual(server.requests.count, 1, "nothing to refresh sends nothing")
    }

    func testStreamParsesEventsAndReset() async throws {
        let (comms, server) = try make { _ in
            .sse([
                ": ping\n\n",
                "id: 7\nevent: message.created\ndata: {\"threadId\":\"th_1\",\"messageId\":\"$e\"}\n\n",
                "id: 8\nevent: thread.updated\ndata: {\"threadId\":\"th_1\"}\n\nid: 9\nevent: reaction.changed\ndata: {\"threadId\":\"th_1\"}\n\n",
                "id: 10\nevent: future.thing\ndata: {\"x\":1}\n\n",
                "event: reset\ndata: {}\n\n",
            ])
        }
        var events: [CommsEvent] = []
        for try await e in comms.stream(lastEventID: "6", policy: SSERetryPolicy(initialDelay: .milliseconds(1), jitter: 0, maxAttempts: 0)) {
            events.append(e)
            if case .reset = e.kind { break }
        }
        XCTAssertEqual(events.map(\.kind), [.messageCreated, .threadUpdated, .reactionChanged, .unknown("future.thing"), .reset])
        XCTAssertEqual(events.map(\.id), ["7", "8", "9", "10", nil])
        XCTAssertEqual(events[0].threadID, "th_1")
        XCTAssertEqual(events[0].payload["messageId"]?.stringValue, "$e")
        XCTAssertEqual(server.requests[0].path, "/api/comms/stream")
        XCTAssertEqual(server.requests[0].header("Last-Event-ID"), "6")
        XCTAssertEqual(server.requests[0].header("Accept"), "text/event-stream")
    }

    func testStreamFatalErrorsEndTheSequence() async throws {
        let (comms, _) = try make { _ in .json(403, #"{"error":"client_scope"}"#) }
        do { for try await _ in comms.stream(lastEventID: nil) {}; XCTFail() } catch { XCTAssertEqual(error as? CommsError, .clientScope) }
    }
}
