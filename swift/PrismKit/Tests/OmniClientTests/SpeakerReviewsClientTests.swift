import Foundation
import OmniClient
import PrismAuth
import PrismModels
import PrismTestSupport
import PrismTransport
import XCTest

final class SpeakerReviewsClientTests: XCTestCase {
    let origin = try! ServerOrigin("https://prism.example.com")
    /// The server's shape (apps/server/src/omni/speaker-reviews.ts `speakerReviewView`).
    static let review = #"{"id":"sr_0123456789abcdef01234567","meetingKey":"minutes:m1","title":"Ops sync","heldAt":"2026-11-20T17:00:00.000Z","status":"open","createdAt":"2026-11-20T18:00:00.000Z","updatedAt":"2026-11-20T18:00:00.000Z","rows":[{"id":"c1","label":"Speaker 1","seconds":241,"kind":"ask","confidence":"medium","guess":{"name":"Alex Chen","email":"alex@example.com"},"reasons":["Captions name Alex"],"quote":"Thanks, everyone.","hasClip":true},{"id":"c2","label":"Speaker 2","seconds":30,"kind":"ask","confidence":"low","guess":null,"reasons":[],"quote":null,"hasClip":false},{"id":"c3","label":"Speaker 3","seconds":600,"kind":"auto","confidence":"high","guess":{"name":"Sam Rivera"},"reasons":[],"quote":null,"hasClip":false}],"candidates":[{"name":"Alex Chen","email":"alex@example.com"},{"name":"Sam Rivera"}],"answers":{"c2":{"choice":"skip","name":null,"email":null,"at":"2026-11-20T18:05:00.000Z"}},"pending":1}"#

    func make(_ handler: @escaping StubServer.Handler) throws -> (OmniClient, StubServer) {
        let server = StubServer(handler)
        let store = InMemoryTokenStore()
        try store.setToken(TestTokens.device, for: origin)
        return (OmniClient(transport: PrismClient(origin: origin, tokenStore: store, session: server.session)), server)
    }

    func testListDecodesTheServersShapeAndSkipsABadReview() async throws {
        let (omni, server) = try make { _ in .json(200, #"{"reviews":[\#(Self.review),{"id":"x","rows":7}]}"#) }
        let list = try await omni.speakerReviews()
        XCTAssertEqual(server.requests[0].path, "/api/omni/speaker-reviews")
        XCTAssertEqual(server.requests[0].query, ["status": "all"])
        XCTAssertEqual(list.reviews.count, 1)
        let r = list.reviews[0]
        XCTAssertEqual(r.title, "Ops sync")
        XCTAssertEqual(r.pending, 1)
        XCTAssertEqual(r.askRows.map(\.id), ["c1", "c2"])
        XCTAssertEqual(r.autoRows.map(\.id), ["c3"])
        XCTAssertEqual(r.rows[0].guessLine, "Probably Alex Chen")
        XCTAssertEqual(r.rows[1].guessLine, "Not sure")
        XCTAssertEqual(r.rows[0].minutes, 4)
        XCTAssertEqual(r.answers["c2"]?.choice, .skip)
        XCTAssertEqual(r.answers["c2"]?.summary, "Skipped")
        XCTAssertEqual(r.heldAt, PrismJSON.parseDate("2026-11-20T17:00:00Z"))
        _ = try await omni.speakerReviews(openOnly: true)
        XCTAssertEqual(server.requests[1].query, ["status": "open"])
    }

    func testAnswerPostsTheBody() async throws {
        let (omni, server) = try make { _ in .json(200, #"{"review":\#(Self.review)}"#) }
        _ = try await omni.answerSpeaker("sr_0123456789abcdef01234567", rowID: "c1", choice: .other, name: "Jo Park", email: "jo@example.org")
        XCTAssertEqual(server.requests[0].method, "POST")
        XCTAssertEqual(server.requests[0].path, "/api/omni/speaker-reviews/sr_0123456789abcdef01234567/answers")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: Data((server.requests[0].bodyString ?? "").utf8)) as? [String: String])
        XCTAssertEqual(body, ["rowId": "c1", "choice": "other", "name": "Jo Park", "email": "jo@example.org"])
        _ = try await omni.answerSpeaker("sr_0123456789abcdef01234567", rowID: "c1", choice: .confirm)
        let confirm = try XCTUnwrap(JSONSerialization.jsonObject(with: Data((server.requests[1].bodyString ?? "").utf8)) as? [String: String])
        XCTAssertEqual(confirm, ["rowId": "c1", "choice": "confirm"])
    }

    func testClipIsBytesOfTheRightType() async throws {
        let bytes = Data([0, 0, 0, 0x18]) + Data("ftypM4A ".utf8) + Data(repeating: 7, count: 20)
        let (omni, server) = try make { request in
            request.path.hasSuffix("/c1/clip")
                ? .response(status: 200, headers: ["Content-Type": "audio/mp4"], chunks: [bytes])
                : .response(status: 200, headers: ["Content-Type": "text/html"], chunks: [Data("<html>".utf8)])
        }
        let clip = try await omni.speakerClip("sr_0123456789abcdef01234567", rowID: "c1")
        XCTAssertEqual(clip, bytes)
        XCTAssertEqual(server.requests[0].path, "/api/omni/speaker-reviews/sr_0123456789abcdef01234567/rows/c1/clip")
        do {
            _ = try await omni.speakerClip("sr_0123456789abcdef01234567", rowID: "c2")
            XCTFail("a non-audio answer is refused")
        } catch {}
        do {
            _ = try await omni.speakerClip("sr_0123456789abcdef01234567", rowID: "../x")
            XCTFail("a path-breaking id is refused locally")
        } catch {}
    }

    func testOptimisticAnswerRecomputesPending() throws {
        let r = try PrismJSON.decoder().decode(SpeakerReview.self, from: Data(Self.review.utf8))
        let next = r.with(answer: .init(choice: .confirm, name: "Alex Chen"), for: "c1")
        XCTAssertEqual(next.pending, 0)
        XCTAssertEqual(next.answers["c1"]?.summary, "Alex Chen")
        // An auto row's correction never counts as pending.
        XCTAssertEqual(r.with(answer: .init(choice: .other, name: "Jo"), for: "c3").pending, 1)
    }
}
