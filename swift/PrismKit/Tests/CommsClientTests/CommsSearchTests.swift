import CommsClient
import Foundation
import PrismAuth
import PrismModels
import PrismTestSupport
import PrismTransport
import XCTest

/// Task 4: GET /search, /search/media, the tidy routes and their refusals.
final class CommsSearchTests: XCTestCase {
    let origin = try! ServerOrigin("https://prism.example.com")
    static let thread = #"{"id":"th_ann","title":"Ann Lee","titleSource":"person","avatar":null,"kind":"dm","networks":["whatsapp"],"lastActivityAt":"2026-11-21T10:00:00Z","unread":{"count":0,"trusted":true},"folder":"inbox","urgency":null,"pinned":false,"muted":false,"channels":[],"needsTidy":true}"#

    func make(_ handler: @escaping StubServer.Handler) throws -> (CommsClient, StubServer) {
        let server = StubServer(handler)
        let store = InMemoryTokenStore()
        try store.setToken(TestTokens.device, for: origin)
        return (CommsClient(client: PrismClient(origin: origin, tokenStore: store, session: server.session)), server)
    }

    func testSearchSendsFiltersAndDecodesHitsLeniently() async throws {
        let body = """
        {"query":"pier","messages":[
          {"id":"sr_1","threadId":"th_ann","messageId":"$e1","sentAt":"2026-11-20T09:30:00.000Z","sender":{"name":"Ann Lee","isSelf":false},
           "text":"see you at the pier","highlights":[{"start":15,"length":4},{"start":17,"length":40},{"start":-1,"length":2}],"origin":"live"},
          {"id":"sr_2","threadId":"th_ann","sentAt":"2012-01-01T08:00:00.000Z","sender":{"name":"Ann","isSelf":true},"text":"old pier","highlights":[],"origin":"history"},
          {"broken":1}],
         "threads":[\(Self.thread)],"suggestions":{"threads":[\(Self.thread)]},"history":{"sources":3,"pending":1,"failed":0,"messages":9},"next":"abc","partial":true}
        """
        let (comms, server) = try make { _ in .json(200, body) }
        let r = try await comms.search(query: " pier ", filter: CommsSearchFilter(threadId: "th_ann", networks: [.whatsapp], fromSelf: false), limit: 99)
        let req = server.requests[0]
        XCTAssertEqual(req.path, "/api/comms/search")
        XCTAssertEqual(req.query["q"], "pier")
        XCTAssertEqual(req.query["thread"], "th_ann")
        XCTAssertEqual(req.query["network"], "whatsapp")
        XCTAssertEqual(req.query["from"], "others")
        XCTAssertEqual(req.query["limit"], "50")
        XCTAssertEqual(r.messages.map(\.id), ["sr_1", "sr_2"])
        XCTAssertEqual(r.messages[0].highlights, [CommsTextRange(start: 15, length: 4)], "out-of-range highlights are dropped")
        XCTAssertEqual(r.messages[1].origin, .history)
        XCTAssertNil(r.messages[1].messageId)
        XCTAssertEqual(r.suggestions?.map(\.id), ["th_ann"])
        XCTAssertEqual(r.threads.first?.needsTidy, true)
        XCTAssertEqual(r.history?.pending, 1)
        XCTAssertEqual(r.next, "abc")
        XCTAssertTrue(r.partial)
    }

    func testSearchRefusesEmptyLocallyAndMapsDisabled() async throws {
        let (comms, server) = try make { _ in .json(404, #"{"error":"search_disabled"}"#) }
        do { _ = try await comms.search(query: "  "); XCTFail() } catch {}
        XCTAssertTrue(server.requests.isEmpty)
        do { _ = try await comms.search(query: "x"); XCTFail() } catch let e as PrismError {
            XCTAssertEqual(e.serverCode, "search_disabled")
        }
    }

    func testMediaPage() async throws {
        let body = #"{"kind":"links","items":[{"id":"m_1","threadId":"th_ann","messageId":"$e","sentAt":"2026-11-20T09:30:00Z","sender":{"name":"Ann","isSelf":false},"kind":"link","link":{"url":"https://example.test/a","title":"A"}},{"x":1}],"next":null}"#
        let (comms, server) = try make { _ in .json(200, body) }
        let p = try await comms.searchMedia(kind: .links, query: "a", threadID: "th_ann")
        XCTAssertEqual(server.requests[0].query["kind"], "links")
        XCTAssertEqual(p.items.map(\.link?.url), ["https://example.test/a"])
        XCTAssertNil(p.next)
    }

    func testTidyCallsAndRefusals() async throws {
        let ok = #"{"action":{"id":"ta_1","kind":"link","threadId":"th_ann","personId":"p1","personName":"Ann","at":"2026-11-22T00:00:00Z","undone":false},"thread":\#(Self.thread)}"#
        final class Box: @unchecked Sendable { var answer: (Int, String) = (200, "") }
        let box = Box()
        box.answer = (200, ok)
        let (comms, server) = try make { _ in .json(box.answer.0, box.answer.1) }
        let r = try await comms.tidyLink(threadID: "th_ann", personID: "p1")
        XCTAssertEqual(r.action.id, "ta_1")
        XCTAssertEqual(server.requests[0].path, "/api/comms/tidy/link")
        let sent = try XCTUnwrap(JSONSerialization.jsonObject(with: server.requests[0].body) as? [String: String])
        XCTAssertEqual(sent, ["threadId": "th_ann", "personId": "p1"])

        box.answer = (409, #"{"error":"similar_people","people":[{"id":"p1","name":"Ann Lee"}]}"#)
        do { _ = try await comms.tidyCreate(threadID: "th_ann", name: "Ann Lee"); XCTFail() } catch let e as CommsTidyRefusal {
            XCTAssertEqual(e, .similarPeople([.init(personId: "p1", name: "Ann Lee", reason: "same-name")]))
        }
        box.answer = (409, #"{"error":"claimed_by_another_person","person":{"id":"p2","name":"Bo"}}"#)
        do { _ = try await comms.tidyLink(threadID: "th_ann", personID: "p1"); XCTFail() } catch let e as CommsTidyRefusal {
            XCTAssertEqual(e, .claimedByAnotherPerson(.init(personId: "p2", name: "Bo", reason: "same-handle")))
        }
        box.answer = (409, #"{"error":"changed_since"}"#)
        do { _ = try await comms.tidyUndo(actionID: "ta_1"); XCTFail() } catch let e as CommsTidyRefusal { XCTAssertEqual(e, .changedSince) }
        // People-cleanup safety refusals reach the app as named codes (Comms shows its own copy).
        box.answer = (409, #"{"error":"not_one_counterpart"}"#)
        do { _ = try await comms.tidyLink(threadID: "th_ann", personID: "p1"); XCTFail() } catch let e as CommsTidyRefusal { XCTAssertEqual(e, .other("not_one_counterpart")) }
        box.answer = (409, #"{"error":"owner_person"}"#)
        do { _ = try await comms.tidyCreate(threadID: "th_ann", name: "Ben Owner"); XCTFail() } catch let e as CommsTidyRefusal { XCTAssertEqual(e, .other("owner_person")) }
        box.answer = (200, #"{"needed":true,"item":{"threadId":"th_ann","network":"whatsapp","name":"Ann","avatar":null,"handle":{"kind":"phone","value":"+15550001111"},"messageCount":3,"lastActivityAt":"2026-11-21T10:00:00Z","score":1,"suggestions":[{"personId":"p1","name":"Ann Lee","reason":"same-name"}]}}"#)
        let item = try await comms.tidyItem(threadID: "th_ann")
        XCTAssertEqual(item?.handle?.value, "+15550001111")
        box.answer = (200, #"{"needed":false}"#)
        let none = try await comms.tidyItem(threadID: "th_ann")
        XCTAssertNil(none)
    }
}
