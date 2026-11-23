import CommsClient
import Foundation
import PrismAuth
import PrismTestSupport
import PrismTransport
import XCTest

final class CommsSendTests: XCTestCase {
    let origin = try! ServerOrigin("https://prism.example.com")
    let clientID = "6f1c2a7e-3b4d-4c5e-9f60-718293a4b5c6"

    func make(_ handler: @escaping StubServer.Handler) throws -> (CommsClient, StubServer) {
        let server = StubServer(handler)
        let store = InMemoryTokenStore()
        try store.setToken(TestTokens.device, for: origin)
        return (CommsClient(client: PrismClient(origin: origin, tokenStore: store, session: server.session)), server)
    }

    let ok: StubServer.Handler = { _ in
        .json(200, #"{"clientId":"6f1c2a7e-3b4d-4c5e-9f60-718293a4b5c6","eventId":"$ev1","status":"sent"}"#)
    }

    func testSendTextPostsJSONWithClientIDAndReply() async throws {
        let (comms, server) = try make(ok)
        let result = try await comms.sendText(threadID: "th_1", clientID: clientID, text: "Hi there", replyTo: "$parent:example.test")
        XCTAssertEqual(result, CommsSendResult(clientId: clientID, eventId: "$ev1", status: "sent"))
        let r = server.requests[0]
        XCTAssertEqual(r.method, "POST")
        XCTAssertEqual(r.path, "/api/comms/threads/th_1/messages")
        XCTAssertEqual(r.header("Content-Type"), "application/json")
        XCTAssertEqual(r.header("Authorization"), "Bearer \(TestTokens.device)")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: r.body) as? [String: String])
        XCTAssertEqual(body, ["clientId": clientID, "text": "Hi there", "replyTo": "$parent:example.test"])

        _ = try await comms.sendText(threadID: "th_1", clientID: clientID, text: "No reply")
        let plain = try XCTUnwrap(JSONSerialization.jsonObject(with: server.requests[1].body) as? [String: Any])
        XCTAssertNil(plain["replyTo"])
    }

    func testSendTextCarriesMentionsAndTheChannelPick() async throws {
        let (comms, server) = try make(ok)
        _ = try await comms.sendText(threadID: "th_1", clientID: clientID, text: "Hi Sam and Ana",
                                     mentions: [CommsMention(userId: "@wa_2:hs", start: 11, length: 3), CommsMention(userId: "@wa_1:hs", start: 3, length: 3)],
                                     channel: CommsChannelRef(network: .whatsapp, accountLabel: "Work"))
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: server.requests[0].body) as? [String: Any])
        let mentions = try XCTUnwrap(body["mentions"] as? [[String: Any]])
        XCTAssertEqual(mentions.map { $0["userId"] as? String }, ["@wa_1:hs", "@wa_2:hs"], "ordered by position")
        XCTAssertEqual(mentions.first?["start"] as? Int, 3)
        XCTAssertEqual(body["channel"] as? [String: String], ["network": "whatsapp", "accountLabel": "Work"])
        // A range past the text is refused locally.
        do {
            _ = try await comms.sendText(threadID: "th_1", clientID: clientID, text: "Hi", mentions: [CommsMention(userId: "@x:hs", start: 1, length: 5)])
            XCTFail("sent")
        } catch { guard case CommsError.sendFailed(let f) = error, f.reason == .invalid else { return XCTFail("\(error)") } }
        XCTAssertEqual(server.requests.count, 1)
        _ = try await comms.sendAttachment(threadID: "th_1", clientID: clientID, kind: .file, data: Data([1, 2]), mime: "application/pdf", filename: "a.pdf",
                                           channel: CommsChannelRef(network: .telegram))
        let multipart = String(decoding: server.requests[1].body, as: UTF8.self)
        XCTAssertTrue(multipart.contains("name=\"channel\"\r\n\r\n{\"network\":\"telegram\"}"), multipart)
    }

    func testSendTextRefusesLocallyWhatTheServerWould() async throws {
        let (comms, server) = try make(ok)
        for (text, id, reason) in [("   ", clientID, CommsSendFailure.Reason.invalid), ("hi", "not-a-uuid", .invalid), (String(repeating: "x", count: 32_001), clientID, .tooLarge)] {
            do { _ = try await comms.sendText(threadID: "th_1", clientID: id, text: text); XCTFail("sent \(id)") } catch {
                guard case CommsError.sendFailed(let f) = error else { return XCTFail("\(error)") }
                XCTAssertEqual(f.reason, reason)
                XCTAssertFalse(f.maybeSent)
            }
        }
        do { _ = try await comms.sendText(threadID: "../x", clientID: clientID, text: "hi"); XCTFail() } catch {
            XCTAssertEqual(error as? PrismError, .invalidRequest("id refused"))
        }
        XCTAssertTrue(server.requests.isEmpty, "nothing reached the server")
    }

    func testSendAttachmentIsMultipart() async throws {
        let (comms, server) = try make(ok)
        let bytes = Data([0x4F, 0x67, 0x67, 0x53, 0, 1, 2])
        _ = try await comms.sendAttachment(threadID: "th_1", clientID: clientID, kind: .voice, data: bytes, mime: "audio/ogg; codecs=opus",
                                           filename: "../Voice Note \"1\".ogg", durationMs: 4200, waveform: [0, 512, 2000, -3])
        let r = server.requests[0]
        XCTAssertEqual(r.path, "/api/comms/threads/th_1/attachments")
        let type = try XCTUnwrap(r.header("Content-Type"))
        XCTAssertTrue(type.hasPrefix("multipart/form-data; boundary="), type)
        let boundary = String(type.dropFirst("multipart/form-data; boundary=".count))
        let parts = Self.parse(r.body, boundary: boundary)
        XCTAssertEqual(parts["clientId"]?.body, Data(clientID.utf8))
        XCTAssertEqual(parts["kind"]?.body, Data("voice".utf8))
        XCTAssertEqual(parts["durationMs"]?.body, Data("4200".utf8))
        XCTAssertEqual(parts["waveform"]?.body, Data("[0,512,1024,0]".utf8), "clamped to 0…1024")
        let file = try XCTUnwrap(parts["file"])
        XCTAssertEqual(file.body, bytes)
        XCTAssertTrue(file.headers.contains("filename=\"Voice Note 1.ogg\""), file.headers)
        XCTAssertTrue(file.headers.contains("Content-Type: audio/ogg"), file.headers)
    }

    func testImageAttachmentOmitsVoiceFieldsAndCapsWaveform() async throws {
        let (comms, server) = try make(ok)
        _ = try await comms.sendAttachment(threadID: "th_1", clientID: clientID, kind: .image, data: Data([1]), mime: "bogus mime",
                                           filename: "café.jpg", durationMs: 10, waveform: [1, 2])
        var r = server.requests[0]
        var parts: [String: Part] = Self.parse(r.body, boundary: String(r.header("Content-Type")!.split(separator: "=", maxSplits: 1)[1]))
        XCTAssertNil(parts["durationMs"])
        XCTAssertNil(parts["waveform"])
        XCTAssertNil(parts["w"], "no size given")
        XCTAssertTrue(parts["file"]!.headers.contains("Content-Type: application/octet-stream"))
        // Raw UTF-8 like a browser — never RFC 5987 `filename*` (the server's parser refuses it).
        XCTAssertTrue(parts["file"]!.headers.contains("filename=\"café.jpg\""), parts["file"]!.headers)
        XCTAssertFalse(parts["file"]!.headers.contains("filename*"), parts["file"]!.headers)

        _ = try await comms.sendAttachment(threadID: "th_1", clientID: clientID, kind: .voice, data: Data([1]), mime: "audio/mp4",
                                           filename: "v.m4a", durationMs: 1, waveform: Array(repeating: 7, count: 500))
        r = server.requests[1]
        parts = Self.parse(r.body, boundary: String(r.header("Content-Type")!.split(separator: "=", maxSplits: 1)[1]))
        let wave = try XCTUnwrap(JSONSerialization.jsonObject(with: parts["waveform"]!.body) as? [Int])
        XCTAssertEqual(wave.count, 200)
    }

    func testImageSizeHintsAndEchoClientID() async throws {
        let (comms, server) = try make(ok)
        _ = try await comms.sendAttachment(threadID: "th_1", clientID: clientID, kind: .image, data: Data([1]), mime: "image/jpeg",
                                           filename: "a.jpg", w: 4032, h: 3024)
        let r = server.requests[0]
        let parts = Self.parse(r.body, boundary: String(r.header("Content-Type")!.split(separator: "=", maxSplits: 1)[1]))
        XCTAssertEqual(parts["w"]?.body, Data("4032".utf8))
        XCTAssertEqual(parts["h"]?.body, Data("3024".utf8))
        XCTAssertEqual(Set(parts.keys), ["clientId", "kind", "w", "h", "file"], "only contract fields (unknown ones are 422)")

        let json = #"{"id":"$e","threadId":"th_1","channel":{"network":"whatsapp"},"source":{"network":"whatsapp","eventId":"$e","ref":"r"},"sender":{"id":"@me:x","name":"Me","isSelf":true,"isOmni":false},"sentAt":"2026-11-22T10:00:00Z","attachments":[],"linkPreviews":[],"reactions":[],"redacted":false,"clientId":"\#(clientID)"}"#
        let m = try PrismJSON.decoder().decode(CommsMessage.self, from: Data(json.utf8))
        XCTAssertEqual(m.clientId, clientID)
        let without = try PrismJSON.decoder().decode(CommsMessage.self, from: Data(json.replacingOccurrences(of: #","clientId":"\#(clientID)""#, with: "").utf8))
        XCTAssertNil(without.clientId)
    }

    func testFileUploadIsStreamedAndCapped() async throws {
        let (comms, server) = try make(ok)
        let src = FileManager.default.temporaryDirectory.appendingPathComponent("comms-test-\(UUID().uuidString).mov")
        let bytes = Data((0..<300_000).map { UInt8($0 % 251) })
        try bytes.write(to: src)
        defer { try? FileManager.default.removeItem(at: src) }
        let uploads = { Set((try? FileManager.default.contentsOfDirectory(atPath: NSTemporaryDirectory())) ?? []).filter { $0.hasPrefix("comms-upload-") } }
        let before = uploads()
        _ = try await comms.sendAttachment(threadID: "th_1", clientID: clientID, kind: .video, fileURL: src, mime: "video/quicktime", durationMs: 1200, w: 640, h: 360)
        let r = server.requests[0]
        XCTAssertEqual(r.header("Content-Length"), String(r.body.count))
        let parts = Self.parse(r.body, boundary: String(r.header("Content-Type")!.split(separator: "=", maxSplits: 1)[1]))
        XCTAssertEqual(parts["file"]?.body, bytes)
        XCTAssertEqual(parts["durationMs"]?.body, Data("1200".utf8))
        XCTAssertEqual(parts["w"]?.body, Data("640".utf8))
        XCTAssertEqual(Set(parts.keys), ["clientId", "kind", "durationMs", "w", "h", "file"])
        XCTAssertEqual(uploads(), before, "the temporary multipart body is deleted")

        do { _ = try await comms.sendAttachment(threadID: "th_1", clientID: clientID, kind: .video, fileURL: src, mime: "video/quicktime", maxBytes: 1000); XCTFail() } catch {
            guard case CommsError.sendFailed(let f) = error else { return XCTFail("\(error)") }
            XCTAssertEqual(f.reason, .tooLarge)
        }
        XCTAssertEqual(server.requests.count, 1, "over the cap: nothing sent")
    }

    /// Owner report 2026-11-22: a picture picked via "+ → Files" with a non-ASCII name (a macOS
    /// screenshot has U+202F before "AM") was refused 422 — the streamed upload sent `filename*`.
    func testStreamedImageUploadSendsTheUTF8NameTheServerCanRead() async throws {
        let (comms, server) = try make(ok)
        let src = FileManager.default.temporaryDirectory.appendingPathComponent("comms-test-\(UUID().uuidString).jpg")
        try Data([0xFF, 0xD8, 0xFF, 0xD9]).write(to: src)
        defer { try? FileManager.default.removeItem(at: src) }
        let name = "Screenshot 2026-11-22 at 10.15.32\u{202F}AM 照片.jpg"
        _ = try await comms.sendAttachment(threadID: "th_1", clientID: clientID, kind: .image, fileURL: src, mime: "image/jpeg", filename: name, w: 3024, h: 4032)
        let r = server.requests[0]
        XCTAssertEqual(r.header("Content-Length"), String(r.body.count))
        let parts = Self.parse(r.body, boundary: String(r.header("Content-Type")!.split(separator: "=", maxSplits: 1)[1]))
        XCTAssertEqual(parts["kind"]?.body, Data("image".utf8))
        XCTAssertEqual(parts["w"]?.body, Data("3024".utf8))
        let headers = try XCTUnwrap(parts["file"]?.headers)
        XCTAssertTrue(headers.contains("filename=\"\(name)\""), headers)
        XCTAssertFalse(headers.contains("filename*"), headers)
    }

    func testSendErrorMapping() async throws {
        let cases: [(StubAnswer, CommsSendFailure.Reason, Bool)] = [
            (.json(403, #"{"error":"send_disabled","message":"Sending is off."}"#), .sendDisabled, false),
            (.json(403, #"{"error":"device_required","message":"x"}"#), .deviceRequired, false),
            (.json(404, #"{"error":"not_found","message":"x"}"#), .notFound, false),
            (.json(404, #"{"error":"comms_disabled"}"#), .sendDisabled, false),
            (.json(409, #"{"error":"unsupported_network","message":"x"}"#), .unsupportedNetwork, false),
            (.json(413, #"{"error":"too_large","message":"x"}"#), .tooLarge, false),
            (.json(415, #"{"error":"unsupported_type","message":"x"}"#), .unsupportedType, false),
            (.json(422, #"{"error":"invalid","message":"x"}"#), .invalid, false),
            (.json(429, #"{"error":"rate_limited","message":"x"}"#), .rateLimited, false),
            (.json(409, #"{"error":"in_progress","message":"x"}"#), .inProgress, true),
            (.json(409, #"{"error":"encrypted_room","message":"x"}"#), .encryptedRoom, false),
            (.json(422, #"{"error":"bridge_command","message":"x"}"#), .bridgeCommand, false),
            (.json(429, #"{"error":"busy","message":"x"}"#, headers: ["Retry-After": "5"]), .busy, false),
            (.json(503, #"{"error":"source_unavailable","message":"x"}"#), .sourceUnavailable, false),
            (.json(502, #"{"error":"send_failed","message":"x","maybeSent":false}"#), .sendFailed, false),
            (.json(502, #"{"error":"send_failed","message":"x","maybeSent":true}"#), .sendFailed, true),
            (.json(500, #"{"error":"internal"}"#), .outcomeUnknown, true),
            (.failure(.timedOut), .outcomeUnknown, true),
            (.failure(.networkConnectionLost), .outcomeUnknown, true),
            (.failure(.cannotConnectToHost), .unreachable, false),
            (.json(200, #"{"nope":1}"#), .outcomeUnknown, true),
        ]
        for (answer, reason, maybeSent) in cases {
            let (comms, _) = try make { _ in answer }
            do { _ = try await comms.sendText(threadID: "th_1", clientID: clientID, text: "hi"); XCTFail("expected \(reason)") } catch {
                guard case CommsError.sendFailed(let f) = error else { XCTFail("\(reason): \(error)"); continue }
                XCTAssertEqual(f.reason, reason)
                XCTAssertEqual(f.maybeSent, maybeSent, "\(reason)")
            }
        }
        let (refused, _) = try make { _ in .json(403, #"{"error":"send_disabled","message":"Sending is off."}"#) }
        do { _ = try await refused.sendText(threadID: "th_1", clientID: clientID, text: "hi") } catch {
            guard case CommsError.sendFailed(let f) = error else { return XCTFail() }
            XCTAssertEqual(f.message, "Sending is off.")
            XCTAssertEqual(f.status, 403)
        }
        let (scope, _) = try make { _ in .json(403, #"{"error":"client_scope"}"#) }
        do { _ = try await scope.sendText(threadID: "th_1", clientID: clientID, text: "hi") } catch { XCTAssertEqual(error as? CommsError, .clientScope) }
    }

    func testCapabilitiesSendDecodesAndDefaultsOff() throws {
        let decoder = PrismJSON.decoder()
        let base = #""integration":"comms","clientId":"comms-native","restricted":true,"schemaVersions":[1],"operations":[],"networks":[]"#
        let on = try decoder.decode(CommsCapabilities.self, from: Data(#"{\#(base),"send":{"enabled":true,"maxAttachmentBytes":26214400}}"#.utf8))
        XCTAssertEqual(on.send, CommsSendCapabilities(enabled: true, maxAttachmentBytes: 26_214_400))
        XCTAssertTrue(on.canSend)
        let old = try decoder.decode(CommsCapabilities.self, from: Data("{\(base)}".utf8))
        XCTAssertNil(old.send)
        XCTAssertFalse(old.canSend)
        let partial = try decoder.decode(CommsCapabilities.self, from: Data(#"{\#(base),"send":{}}"#.utf8))
        XCTAssertEqual(partial.send, CommsSendCapabilities(enabled: false, maxAttachmentBytes: 0))

        let channel = try decoder.decode(CommsChannelCapabilities.self, from: Data(#"{"react":true}"#.utf8))
        XCTAssertFalse(channel.send, "missing => false")
        XCTAssertTrue(try decoder.decode(CommsChannelCapabilities.self, from: Data(#"{"send":true}"#.utf8)).send)
        XCTAssertFalse(channel.encrypted)
        XCTAssertTrue(try decoder.decode(CommsChannelCapabilities.self, from: Data(#"{"encrypted":true}"#.utf8)).encrypted)
        XCTAssertTrue(try decoder.decode(CommsChannelCapabilities.self, from: Data(#"{"mentions":true}"#.utf8)).mentions)
        XCTAssertFalse(try decoder.decode(CommsChannelCapabilities.self, from: Data(#"{}"#.utf8)).mentions)
    }

    func testTransportRefusesOtherBodyTypes() async throws {
        let server = StubServer { _ in .json(200, "{}") }
        let store = InMemoryTokenStore()
        try store.setToken(TestTokens.device, for: origin)
        let client = PrismClient(origin: origin, tokenStore: store, session: server.session)
        for type in ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data"] {
            do { _ = try await client.sendRaw(PrismRequest(method: "POST", path: "/x", body: Data("a".utf8), contentType: type)); XCTFail(type) } catch {
                XCTAssertEqual(error as? PrismError, .invalidRequest("content type refused"))
            }
        }
        XCTAssertTrue(server.requests.isEmpty)
    }

    // MARK: Multipart parsing (test-only)

    struct Part { var headers: String; var body: Data }

    static func parse(_ data: Data, boundary: String) -> [String: Part] {
        let delimiter = Data("--\(boundary)".utf8)
        var out: [String: Part] = [:]
        var chunks: [Data] = []
        var rest = data[...]
        while let r = rest.range(of: delimiter) {
            chunks.append(Data(rest[rest.startIndex..<r.lowerBound]))
            rest = rest[r.upperBound...]
        }
        for chunk in chunks.dropFirst() {
            guard let split = chunk.range(of: Data("\r\n\r\n".utf8)) else { continue }
            let headers = String(decoding: chunk[chunk.startIndex..<split.lowerBound], as: UTF8.self)
            var body = Data(chunk[split.upperBound...])
            if body.suffix(2) == Data("\r\n".utf8) { body.removeLast(2) }
            guard let nameRange = headers.range(of: "name=\""), let end = headers[nameRange.upperBound...].firstIndex(of: "\"") else { continue }
            out[String(headers[nameRange.upperBound..<end])] = Part(headers: headers, body: body)
        }
        return out
    }
}
