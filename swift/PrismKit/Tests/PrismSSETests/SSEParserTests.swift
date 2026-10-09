import Foundation
import PrismSSE
import XCTest

final class SSEParserTests: XCTestCase {
    func events(_ items: [SSEItem]) -> [SSEEvent] {
        items.compactMap { if case .event(let e) = $0 { return e } else { return nil } }
    }

    func testBasicEventWithIdAndName() {
        var p = SSEParser()
        let out = p.feed("event: text\ndata: {\"seq\":3}\nid: 3\n\n")
        XCTAssertEqual(out, [.event(SSEEvent(event: "text", data: "{\"seq\":3}", id: "3"))])
        XCTAssertEqual(p.lastEventID, "3")
    }

    func testDefaultEventNameAndOptionalSpace() {
        var p = SSEParser()
        XCTAssertEqual(events(p.feed("data:no space\n\ndata:  two spaces\n\n")), [SSEEvent(data: "no space"), SSEEvent(data: " two spaces")])
    }

    func testMultiLineData() {
        var p = SSEParser()
        XCTAssertEqual(events(p.feed("data: line 1\ndata: line 2\ndata:\ndata: line 4\n\n")), [SSEEvent(data: "line 1\nline 2\n\nline 4")])
    }

    func testCRLFAndBareCRLineEnds() {
        var p = SSEParser()
        XCTAssertEqual(events(p.feed("event: a\r\ndata: 1\r\nid: 7\r\n\r\nevent: b\rdata: 2\r\r")), [SSEEvent(event: "a", data: "1", id: "7"), SSEEvent(event: "b", data: "2")])
        XCTAssertEqual(p.lastEventID, "7")
    }

    func testEveryChunkingGivesTheSameEvents() {
        let stream = "\u{FEFF}: connected\r\n\r\nevent: text_delta\r\ndata: {\"text\":\"héllo 🌊\"}\r\n\r\nevent: text\ndata: {\"seq\":1}\ndata: more\nid: 1\n\n: ping\n\nretry: 2500\nevent: status\rdata: done\rid: 2\r\r"
        let bytes = Data(stream.utf8)
        var whole = SSEParser()
        let expected = whole.feed(bytes)
        XCTAssertEqual(events(expected), [
            SSEEvent(event: "text_delta", data: "{\"text\":\"héllo 🌊\"}"),
            SSEEvent(event: "text", data: "{\"seq\":1}\nmore", id: "1"),
            SSEEvent(event: "status", data: "done", id: "2"),
        ])
        XCTAssertEqual(expected.first, .comment("connected"))
        XCTAssertTrue(expected.contains(.comment("ping")))
        XCTAssertTrue(expected.contains(.retry(milliseconds: 2500)))
        // Byte by byte (splits CRLF pairs and multi-byte UTF-8), and every two-way split.
        var single = SSEParser()
        var out: [SSEItem] = []
        for b in bytes { out += single.feed(Data([b])) }
        XCTAssertEqual(out, expected)
        XCTAssertEqual(single.lastEventID, "2")
        for cut in 0...bytes.count {
            var p = SSEParser()
            let got = p.feed(bytes.prefix(cut)) + p.feed(bytes.suffix(from: cut))
            XCTAssertEqual(got, expected, "split at \(cut)")
        }
    }

    func testCommentsAreNotEvents() {
        var p = SSEParser()
        XCTAssertEqual(p.feed(": ping\n\n:\n\n:no-space\n"), [.comment("ping"), .comment(""), .comment("no-space")])
        XCTAssertNil(p.lastEventID)
    }

    func testIdLessEventsDoNotMoveTheCursor() {
        var p = SSEParser()
        let out = events(p.feed("event: text\ndata: a\nid: 5\n\nevent: text_delta\ndata: live\n\nevent: text_delta\ndata: live2\n\n"))
        XCTAssertEqual(out.map(\.id), ["5", nil, nil], "a live delta carries no id of its own")
        XCTAssertEqual(p.lastEventID, "5", "the resume cursor stays on the last persisted event")
    }

    func testEventWithoutDataIsNotDispatchedAndAnIncompleteEventIsHeld() {
        var p = SSEParser()
        XCTAssertEqual(p.feed("event: orphan\n\n"), [])
        XCTAssertEqual(p.feed("event: text\ndata: partial"), [])
        XCTAssertEqual(p.feed("\n"), [])
        XCTAssertEqual(events(p.feed("\n")), [SSEEvent(event: "text", data: "partial")])
        // The event name does not leak into the next event.
        XCTAssertEqual(events(p.feed("data: next\n\n")), [SSEEvent(data: "next")])
    }

    func testIdRules() {
        var p = SSEParser(lastEventID: "9")
        XCTAssertEqual(p.lastEventID, "9")
        _ = p.feed("id: a\u{0}b\ndata: x\n\n")
        XCTAssertEqual(p.lastEventID, "9", "an id with NUL is ignored")
        _ = p.feed("id: 10\n\n")
        XCTAssertEqual(p.lastEventID, "10", "an id on a data-less block still moves the cursor")
        _ = p.feed("id\ndata: x\n\n")
        XCTAssertNil(p.lastEventID, "an empty id resets the cursor")
    }

    func testUnknownFieldsAndBadRetryAreIgnored() {
        var p = SSEParser()
        XCTAssertEqual(p.feed("foo: bar\nretry: soon\nretry: -1\ndata: x\n\n"), [.event(SSEEvent(data: "x"))])
    }

    func testOversizedLineIsBounded() {
        var p = SSEParser(maxLineBytes: 16)
        let out = events(p.feed("data: " + String(repeating: "x", count: 100) + "\n\ndata: ok\n\n"))
        XCTAssertEqual(out.count, 2)
        XCTAssertEqual(out[0].data.utf8.count, 10)
        XCTAssertEqual(out[1].data, "ok")
    }
}

final class SSERetryPolicyTests: XCTestCase {
    func testBackoffGrowsIsCappedAndJittered() {
        let p = SSERetryPolicy(initialDelay: .seconds(1), maxDelay: .seconds(30), multiplier: 2, jitter: 0.5)
        XCTAssertEqual(p.delay(attempt: 1, random: 1), .seconds(1))
        XCTAssertEqual(p.delay(attempt: 2, random: 1), .seconds(2))
        XCTAssertEqual(p.delay(attempt: 4, random: 1), .seconds(8))
        XCTAssertEqual(p.delay(attempt: 20, random: 1), .seconds(30))
        XCTAssertEqual(p.delay(attempt: 1, random: 0), .milliseconds(500))
        XCTAssertEqual(p.delay(attempt: 20, random: 0), .seconds(15))
        XCTAssertEqual(p.delay(attempt: 1, serverRetry: .milliseconds(2500), random: 1), .milliseconds(2500), "the server's retry: is the base")
        XCTAssertEqual(SSERetryPolicy(jitter: 0).delay(attempt: 3, random: 0.3), .seconds(4))
    }
}
