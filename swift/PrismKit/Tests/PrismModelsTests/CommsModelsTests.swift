import Foundation
import PrismModels
import XCTest

final class CommsModelsTests: XCTestCase {
    func fixture(_ name: String) throws -> Data {
        let url = try XCTUnwrap(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures"))
        return try Data(contentsOf: url)
    }

    func testDecodesServerFixtures() throws {
        let threads = try PrismJSON.decoder().decode(CommsThreadPage.self, from: try fixture("comms-threads"))
        XCTAssertTrue(threads.threads.count >= 5)
        XCTAssertTrue(threads.threads.contains { if case .monogram = $0.avatar { return true } else { return false } })
        XCTAssertEqual(threads.threads[0].networks, [.telegram])
        XCTAssertEqual(threads.threads[0].channels[0].capabilities?.react, true)
        let messages = try PrismJSON.decoder().decode(CommsMessagePage.self, from: try fixture("comms-messages"))
        let photo = try XCTUnwrap(messages.messages.first { $0.id == "$photo" })
        XCTAssertEqual(photo.attachments[0].kind, .image)
        XCTAssertNotNil(photo.attachments[0].mediaToken)
        XCTAssertNotNil(photo.attachments[0].thumbToken)
        let hello = try XCTUnwrap(messages.messages.first { $0.id == "$hello" })
        XCTAssertEqual(hello.body?.plain, "hello there")
        XCTAssertEqual(hello.body?.spans, [.text("hello there")])
        XCTAssertNotNil(hello.editedAt)
        XCTAssertEqual(hello.delivery, .sent)
        XCTAssertEqual(hello.reactions[0].senders[0].eventId, "$react1")
        XCTAssertNotNil(messages.messages.first { $0.replyTo != nil })
        XCTAssertNotNil(messages.messages.first { !$0.linkPreviews.isEmpty }?.linkPreviews[0].imageToken)
        // Round trip.
        let again = try PrismJSON.decoder().decode(CommsMessagePage.self, from: try PrismJSON.encoder().encode(messages))
        XCTAssertEqual(again, messages)
    }

    func testUnknownNetworkDecodesAsUnknown() throws {
        let n = try JSONDecoder().decode([CommsNetwork].self, from: Data(#"["whatsapp","signal","matrix"]"#.utf8))
        XCTAssertEqual(n, [.whatsapp, .unknown("signal"), .matrix])
        XCTAssertEqual(try JSONEncoder().encode(CommsNetwork.unknown("signal")), Data(#""signal""#.utf8))
        let more = try JSONDecoder().decode([CommsNetwork].self, from: Data(#"["instagram","linkedin"]"#.utf8))
        XCTAssertEqual(more, [.instagram, .linkedin])
        XCTAssertEqual(try JSONEncoder().encode(more), Data(#"["instagram","linkedin"]"#.utf8))
    }

    func testUnknownEnumValuesAndSpansNeverBreakDecoding() throws {
        XCTAssertEqual(try JSONDecoder().decode(CommsFolder.self, from: Data(#""vault""#.utf8)), .unknown("vault"))
        XCTAssertEqual(try JSONDecoder().decode(CommsAttachmentKind.self, from: Data(#""hologram""#.utf8)), .unknown("hologram"))
        XCTAssertEqual(try JSONDecoder().decode(CommsDelivery.self, from: Data(#""bounced""#.utf8)), .unknown("bounced"))
        let spans = try JSONDecoder().decode([CommsSpan].self, from: Data(#"[{"t":"bold","c":[{"t":"text","v":"a"},{"t":"link","href":"https://x.y","c":[{"t":"text","v":"b"}]}]},{"t":"sparkle","c":[]},{"t":"mention","id":"@a:x","name":"A"},{"t":"br"},{"t":"pre","v":"x"}]"#.utf8))
        XCTAssertEqual(spans[0], .bold([.text("a"), .link(href: "https://x.y", [.text("b")])]))
        XCTAssertEqual(spans[1], .unknown("sparkle"))
        XCTAssertEqual(spans[2], .mention(id: "@a:x", name: "A"))
        XCTAssertEqual(spans[3], .br)
        XCTAssertEqual(spans[4], .pre("x"))
        let avatar = try JSONDecoder().decode(CommsAvatar.self, from: Data(#"{"monogram":"AB","members":[{"token":"t"},{"future":1}]}"#.utf8))
        XCTAssertEqual(avatar, .monogram("AB", members: [.token("t"), .unknown]))
    }

    func testThreadStatusIsPrismsModel() throws {
        let wires = ["urgent", "action-required", "unclassified", "triage-failed", "informational", "low", "social", "triaged", "handled"]
        XCTAssertEqual(CommsThreadStatus.ordered.map(\.wire), wires)
        XCTAssertEqual(CommsThreadStatus.ordered.map(\.label), ["Urgent", "Action required", "Needs triage", "Couldn\u{2019}t classify", "Informational", "Low priority", "Social", "Reviewed", "Handled"])
        for w in wires { XCTAssertEqual(CommsThreadStatus(wire: w).wire, w) }
        XCTAssertEqual(try JSONDecoder().decode(CommsThreadStatus.self, from: Data(#""snoozed""#.utf8)), .unknown("snoozed"))
        XCTAssertEqual(CommsThreadStatus.needsAttention, [.urgent, .actionRequired])
        XCTAssertTrue(CommsThreadStatus.urgent.needsAttention)
        XCTAssertFalse(CommsThreadStatus.handled.needsAttention)
        XCTAssertEqual(CommsThreadStatus.needsAttentionLabel, "Needs attention")
    }

    func testContactAndDetailDecodeLeniently() throws {
        let c = try JSONDecoder().decode(CommsContact.self, from: Data(#"{"phones":"nope","emails":[{"value":"a@b.test"},{}]}"#.utf8))
        XCTAssertEqual(c.phones, [])
        XCTAssertEqual(c.emails, [CommsContactPoint(value: "a@b.test")])
        XCTAssertEqual(c.handles, [])
        XCTAssertFalse(c.isEmpty)
        let person = CommsPerson(id: "p", name: "P", contact: CommsContact(phones: [.init(value: "+1555")], handles: [.init(network: .telegram, value: "p", kind: .username)]))
        let again = try PrismJSON.decoder().decode(CommsPerson.self, from: PrismJSON.encoder().encode(person))
        XCTAssertEqual(again, person)
    }

    func testChannelCapabilitiesMissingFlagsFailClosed() throws {
        let c = try JSONDecoder().decode(CommsChannelCapabilities.self, from: Data(#"{"react":true}"#.utf8))
        XCTAssertTrue(c.react)
        XCTAssertFalse(c.edit)
        XCTAssertFalse(c.attachments)
    }
    // MARK: Final wave I2b: one bad value never blanks a page

    static let goodMessage = #"{"id":"$ok","threadId":"th_1","channel":{"network":"whatsapp","accountLabel":null},"source":{"network":"whatsapp","eventId":"$ok","ref":"$ok"},"sender":{"id":"@a:x","name":"A","avatar":null,"isSelf":false,"isOmni":false},"sentAt":"2026-11-21T00:00:00.000Z","body":{"spans":[{"t":"text","v":"hi"}],"plain":"hi","jumboEmoji":false,"truncated":false},"attachments":[],"linkPreviews":[],"reactions":[],"delivery":null,"redacted":false}"#

    func message(_ id: String, patch: (String) -> String = { $0 }) -> String {
        patch(Self.goodMessage.replacingOccurrences(of: "$ok", with: id))
    }

    func testMessagePageDecodesElementWiseAndCountsDropped() throws {
        let badDate = message("$baddate") { $0.replacingOccurrences(of: #""sentAt":"2026-11-21T00:00:00.000Z""#, with: #""sentAt":12"#) }
        let noSender = message("$nosender") { $0.replacingOccurrences(of: #""sender":{"id":"@a:x","name":"A","avatar":null,"isSelf":false,"isOmni":false},"#, with: "") }
        let json = #"{"messages":["# + [message("$1"), badDate, "42", noSender, "null", message("$2")].joined(separator: ",") + #"],"before":"tc_x","hasMore":true}"#
        let page = try PrismJSON.decoder().decode(CommsMessagePage.self, from: Data(json.utf8))
        XCTAssertEqual(page.messages.map(\.id), ["$1", "$2"])
        XCTAssertEqual(page.dropped, 4)
        XCTAssertEqual(page.before, "tc_x")
        XCTAssertTrue(page.hasMore)
        // Round trip keeps the wire shape (no `dropped` key on the wire).
        let encoded = String(decoding: try PrismJSON.encoder().encode(page), as: UTF8.self)
        XCTAssertFalse(encoded.contains("dropped"))
    }

    func testThreadPageDecodesElementWise() throws {
        let good = try fixture("comms-threads")
        var obj = try XCTUnwrap(try JSONSerialization.jsonObject(with: good) as? [String: Any])
        var threads = try XCTUnwrap(obj["threads"] as? [Any])
        let count = threads.count
        threads.insert(["id": "th_bad", "title": 7], at: 1)
        threads.append("garbage")
        obj["threads"] = threads
        let page = try PrismJSON.decoder().decode(CommsThreadPage.self, from: try JSONSerialization.data(withJSONObject: obj))
        XCTAssertEqual(page.threads.count, count)
        XCTAssertEqual(page.dropped, 2)
    }

    func testAttachmentNumbersAreLenient() throws {
        let a = try JSONDecoder().decode(CommsAttachment.self, from: Data(#"{"kind":"image","w":1.5,"h":"tall","size":1e300,"durationMs":-0.4}"#.utf8))
        XCTAssertEqual(a.w, 2)
        XCTAssertNil(a.h)
        XCTAssertNil(a.size)
        XCTAssertEqual(a.durationMs, 0)
        XCTAssertEqual(a.kind, .image)
    }

    func testMalformedKnownSpansFallBackInsteadOfThrowing() throws {
        let json = #"[{"t":"text"},{"t":"link","c":[{"t":"text","v":"label"}]},{"t":"mention","id":"@a:x"},{"t":"pre","v":3},{"t":"sparkle","c":[{"t":"text","v":"kept"}]},{"t":"bold","c":[{"t":"text","v":"a"},17,{"t":"italic","c":"nope"}]},{"v":"no kind"},{"t":"text","v":"ok"}]"#
        let spans = try JSONDecoder().decode([CommsSpan].self, from: Data(json.utf8))
        XCTAssertEqual(spans.count, 8)
        XCTAssertEqual(spans[0], .unknown("text"))
        XCTAssertEqual(spans[1], .unknown("link", children: [.text("label")]))
        XCTAssertEqual(spans[2], .unknown("mention"))
        XCTAssertEqual(spans[3], .unknown("pre"))
        XCTAssertEqual(spans[4], .unknown("sparkle", children: [.text("kept")]))
        XCTAssertEqual(spans[5], .bold([.text("a"), .italic([])]))
        XCTAssertEqual(spans[6], .unknown(""))
        XCTAssertEqual(spans[7], .text("ok"))
        // .unknown round-trips with its children.
        let again = try JSONDecoder().decode([CommsSpan].self, from: try JSONEncoder().encode(spans))
        XCTAssertEqual(again, spans)
        // A whole message whose body holds these still decodes.
        let msg = message("$rich") { $0.replacingOccurrences(of: #"[{"t":"text","v":"hi"}]"#, with: json) }
        let page = try PrismJSON.decoder().decode(CommsMessagePage.self, from: Data((#"{"messages":["# + msg + #"],"before":null,"hasMore":false}"#).utf8))
        XCTAssertEqual(page.messages.count, 1)
        XCTAssertEqual(page.dropped, 0)
    }
}
