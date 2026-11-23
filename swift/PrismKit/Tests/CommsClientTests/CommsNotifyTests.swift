import CommsClient
import Foundation
import PrismAuth
import PrismModels
import PrismTestSupport
import PrismTransport
import XCTest

/// Sprint Task 1: read/unread, notification settings, APNs registration, status counts.
final class CommsNotifyTests: XCTestCase {
    let origin = try! ServerOrigin("https://prism.example.com")
    static let thread = #"{"id":"th_1","title":"Ann","titleSource":"person","avatar":null,"kind":"dm","networks":["whatsapp"],"lastActivityAt":"2026-11-21T10:00:00Z","unread":{"count":0,"trusted":true},"folder":"inbox","urgency":null,"status":"urgent","pinned":false,"muted":false,"channels":[]}"#
    static let settings = #"{"settings":{"enabled":true,"statuses":{"urgent":true,"action-required":true,"informational":false,"unclassified":false},"networks":{"telegram":false},"knownPeopleImmediately":true,"hidePreviews":false,"readReceipts":false,"readReceiptsByNetwork":{}},"available":{"push":true,"readReceipts":false}}"#

    func make(_ handler: @escaping StubServer.Handler) throws -> (CommsClient, StubServer) {
        let server = StubServer(handler)
        let store = InMemoryTokenStore()
        try store.setToken(TestTokens.device, for: origin)
        return (CommsClient(client: PrismClient(origin: origin, tokenStore: store, session: server.session)), server)
    }

    func json(_ r: SeenRequest) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: r.body) as? [String: Any])
    }

    func testMarkReadPostsUpToAndViewing() async throws {
        let (comms, server) = try make { _ in .json(200, #"{"receipt":"off","thread":\#(Self.thread)}"#) }
        let r = try await comms.markRead(threadID: "th_1", upTo: Date(timeIntervalSince1970: 1_790_000_000), viewing: true)
        XCTAssertEqual(r.receipt, "off")
        XCTAssertEqual(r.thread?.unread.count, 0)
        let req = server.requests[0]
        XCTAssertEqual(req.method, "POST")
        XCTAssertEqual(req.path, "/api/comms/threads/th_1/read")
        XCTAssertEqual(req.header("Content-Type"), "application/json")
        let body = try json(req)
        XCTAssertEqual(body["viewing"] as? Bool, true)
        XCTAssertEqual(body["upTo"] as? String, "2026-09-21T14:13:20.000Z")
        // nothing said → an empty object (mark everything read, presence untouched)
        _ = try await comms.markRead(threadID: "th_1")
        XCTAssertEqual(try json(server.requests[1]).count, 0)
    }

    func testMarkUnreadAndBadPathRefusedLocally() async throws {
        let (comms, server) = try make { _ in .json(200, #"{"thread":\#(Self.thread)}"#) }
        _ = try await comms.markUnread(threadID: "th_1")
        XCTAssertEqual(server.requests[0].path, "/api/comms/threads/th_1/unread")
        do {
            _ = try await comms.markUnread(threadID: "../x")
            XCTFail("expected a local refusal")
        } catch {}
        XCTAssertEqual(server.requests.count, 1)
    }

    func testSettingsRoundTripUsesTheWireKeys() async throws {
        let (comms, server) = try make { _ in .json(200, Self.settings) }
        let got = try await comms.notificationSettings()
        XCTAssertTrue(got.settings.statuses.actionRequired)
        XCTAssertFalse(got.settings.notifies(network: .telegram))
        XCTAssertTrue(got.settings.notifies(network: .whatsapp))
        XCTAssertEqual(got.available, CommsNotifyAvailability(push: true, readReceipts: false))
        var s = got.settings
        s.hidePreviews = true
        s.statuses.actionRequired = false
        _ = try await comms.updateNotificationSettings(.diff(from: got.settings, to: s))
        let put = server.requests[1]
        XCTAssertEqual(put.method, "PUT")
        let body = try json(put)
        XCTAssertEqual(Set(body.keys), ["hidePreviews", "statuses"], "only what changed — a stale screen never resends the rest")
        XCTAssertEqual(body["hidePreviews"] as? Bool, true)
        XCTAssertEqual(body["statuses"] as? [String: Bool], ["action-required": false], "the server's key, only the changed entry")
    }

    func testPatchDiffNetworksAndNothingChanged() {
        var a = CommsNotifySettings.defaults
        XCTAssertTrue(CommsNotifySettingsPatch.diff(from: a, to: a).isEmpty)
        var b = a
        b.networks["telegram"] = false
        XCTAssertEqual(CommsNotifySettingsPatch.diff(from: a, to: b).networks, ["telegram": false])
        a = b
        b.networks["telegram"] = true
        XCTAssertEqual(CommsNotifySettingsPatch.diff(from: a, to: b).networks, ["telegram": true])
    }

    func testExplicitMarkReadSaysSo() async throws {
        let (comms, server) = try make { _ in .json(200, #"{"receipt":"sent","thread":null}"#) }
        _ = try await comms.markRead(threadID: "th_1", explicit: true)
        XCTAssertEqual(try json(server.requests[0])["explicit"] as? Bool, true)
        _ = try await comms.markRead(threadID: "th_1", viewing: true)
        XCTAssertNil(try json(server.requests[1])["explicit"], "opening never claims to be explicit")
    }

    func testDefaultsMatchD18AndD10() {
        let d = CommsNotifySettings.defaults
        XCTAssertTrue(d.statuses.urgent && d.statuses.actionRequired)
        XCTAssertFalse(d.statuses.informational || d.statuses.unclassified || d.statuses.low || d.statuses.social || d.statuses.triaged || d.statuses.handled)
        XCTAssertEqual(d.folders, [:])
        XCTAssertFalse(d.readReceipts)
        XCTAssertFalse(d.hidePreviews)
    }

    func testFolderRulesAndEveryStatusRoundTrip() async throws {
        // An older server: no folders, four statuses → the rest read as defaults.
        let old = try JSONDecoder().decode(CommsNotifySettingsResponse.self, from: Data(Self.settings.utf8))
        XCTAssertEqual(old.settings.folders, [:])
        XCTAssertFalse(old.settings.statuses.social || old.settings.statuses.low || old.settings.statuses.handled)
        let new = #"{"settings":{"enabled":true,"statuses":{"urgent":true,"action-required":true,"informational":false,"low":false,"social":true,"triaged":false,"handled":false,"unclassified":false},"networks":{},"knownPeopleImmediately":true,"hidePreviews":false,"readReceipts":false,"readReceiptsByNetwork":{},"folders":{"cf_work":"all","cf_fam":"none","cf_x":"loud"}},"available":{"push":true,"readReceipts":false}}"#
        let (comms, server) = try make { _ in .json(200, new) }
        let got = try await comms.notificationSettings()
        XCTAssertTrue(got.settings.statuses.social)
        XCTAssertEqual(got.settings.notify(folder: "cf_work"), .all)
        XCTAssertEqual(got.settings.notify(folder: "cf_fam"), .off)
        XCTAssertEqual(got.settings.notify(folder: "cf_x"), .default, "an unknown rule reads as default")
        XCTAssertEqual(got.settings.notify(folder: "cf_other"), .default)
        var s = got.settings
        s.folders["cf_work"] = nil // back to Default
        s.folders["cf_new"] = .off
        s.statuses.low = true
        _ = try await comms.updateNotificationSettings(.diff(from: got.settings, to: s))
        let body = try json(server.requests[1])
        XCTAssertEqual(Set(body.keys), ["folders", "statuses"])
        XCTAssertEqual(body["folders"] as? [String: String], ["cf_work": "default", "cf_new": "none"])
        XCTAssertEqual(body["statuses"] as? [String: Bool], ["low": true])
    }

    func testRegisterPushSendsLowercaseHex() async throws {
        let (comms, server) = try make { r in r.method == "DELETE" ? .json(200, #"{"ok":true}"#) : .json(200, #"{"ok":true,"pushEnabled":false}"#) }
        let reg = try await comms.registerPush(deviceToken: Data([0xAB, 0x01, 0xFF]), environment: .sandbox, platform: .ios)
        XCTAssertFalse(reg.pushEnabled)
        let body = try json(server.requests[0])
        XCTAssertEqual(body["token"] as? String, "ab01ff")
        XCTAssertEqual(body["environment"] as? String, "sandbox")
        XCTAssertEqual(body["platform"] as? String, "ios")
        try await comms.unregisterPush()
        XCTAssertEqual(server.requests[1].method, "DELETE")
        XCTAssertEqual(server.requests[1].path, "/api/comms/devices/apns")
    }

    func testStatusCountsDecodesUnreadAndToleratesOlderServers() async throws {
        let (comms, _) = try make { r in
            r.url.query?.contains("archived") == true
                ? .json(200, #"{"folder":"archived","counts":{},"attention":0}"#)
                : .json(200, #"{"folder":"inbox","counts":{"urgent":2},"attention":2,"unread":{"threads":5,"attention":1}}"#)
        }
        let c = try await comms.statusCounts()
        XCTAssertEqual(c.unread, CommsStatusCounts.Unread(threads: 5, attention: 1))
        let old = try await comms.statusCounts(folder: .archived)
        XCTAssertNil(old.unread)
    }

    // MARK: owner-testing round 4

    func testSettingsCarryDevicesAndTestNotificationReportsPerDevice() async throws {
        let devices = #"[{"platform":"ios","environment":"sandbox","thisDevice":true,"registeredAt":"2026-11-22T10:00:00.000Z","lastSeenAt":"2026-11-22T11:00:00.000Z","lastDelivery":{"status":403,"reason":"BadEnvironmentKeyInToken","outcome":"failed","at":"2026-11-22T11:05:00.000Z"}},{"platform":"macos","environment":"production","thisDevice":false,"registeredAt":"2026-11-22T10:00:00.000Z","lastSeenAt":"2026-11-22T11:00:00.000Z","lastDelivery":null}]"#
        let (comms, server) = try make { r in
            r.path.hasSuffix("/test") ? .json(200, #"{"devices":\#(devices)}"#) : .json(200, String(Self.settings.dropLast()) + #","devices":\#(devices)}"#)
        }
        let s = try await comms.notificationSettings()
        XCTAssertEqual(s.devices?.count, 2)
        XCTAssertEqual(s.devices?.first?.lastDelivery?.reason, "BadEnvironmentKeyInToken")
        XCTAssertNil(s.devices?.last?.lastDelivery)
        let t = try await comms.sendTestNotification()
        XCTAssertEqual(t.devices.first?.lastDelivery?.status, 403)
        XCTAssertEqual(server.requests[1].method, "POST")
        XCTAssertEqual(server.requests[1].path, "/api/comms/notifications/test")
        // An older server sends no devices.
        let (old, _) = try make { _ in .json(200, Self.settings) }
        let o = try await old.notificationSettings()
        XCTAssertNil(o.devices)
    }

    func testPlayableAudioAsksForM4AAndPlainMediaDoesNot() async throws {
        let (comms, server) = try make { _ in .response(status: 200, headers: ["Content-Type": "audio/mp4"], chunks: [Data("m4a".utf8)]) }
        let (data, type) = try await comms.media(token: "tok", playableAudio: true)
        XCTAssertEqual(type, "audio/mp4")
        XCTAssertEqual(data, Data("m4a".utf8))
        XCTAssertEqual(server.requests[0].path, "/api/comms/media/tok")
        XCTAssertEqual(server.requests[0].query, ["format": "m4a"])
        _ = try await comms.media(token: "tok")
        XCTAssertEqual(server.requests[1].query, [:])
    }

    func testDismissOmniNotePostsTheTurn() async throws {
        let (comms, server) = try make { _ in .json(200, #"{"ok":true}"#) }
        try await comms.dismissOmniNote(threadID: "th_1", turnID: "turn_9")
        XCTAssertEqual(server.requests[0].method, "POST")
        XCTAssertEqual(server.requests[0].path, "/api/comms/threads/th_1/omni/dismiss")
        XCTAssertEqual(try json(server.requests[0])["turnId"] as? String, "turn_9")
    }
}
