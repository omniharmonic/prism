import CommsClient
import Foundation
import PrismAuth
import PrismTestSupport
import PrismTransport
import XCTest

/// Sprint Task 9: row actions (`/threads/:id/mute|archive|status[/undo]`) and owner folders
/// (`/folders*`, `threads?inFolder=`).
final class CommsFolderTests: XCTestCase {
    let origin = try! ServerOrigin("https://prism.example.com")

    func make(_ handler: @escaping StubServer.Handler) throws -> (CommsClient, StubServer) {
        let server = StubServer(handler)
        let store = InMemoryTokenStore()
        try store.setToken(TestTokens.device, for: origin)
        return (CommsClient(client: PrismClient(origin: origin, tokenStore: store, session: server.session)), server)
    }

    static func thread(_ id: String, muted: Bool = false, folder: String = "inbox", status: String = "unclassified", extra: String = "") -> String {
        #"{"id":"\#(id)","title":"T","titleSource":"room","avatar":null,"kind":"dm","networks":["whatsapp"],"lastActivityAt":"2026-11-22T10:00:00.000Z","unread":{"count":0,"trusted":true},"folder":"\#(folder)","urgency":null,"status":"\#(status)","pinned":false,"muted":\#(muted),"channels":[{"network":"whatsapp","accountLabel":null}]\#(extra)}"#
    }

    func body(_ r: SeenRequest) -> [String: Any] { (try? JSONSerialization.jsonObject(with: r.body) as? [String: Any]) ?? [:] }

    func testRowActions() async throws {
        let (comms, server) = try make { r in
            switch r.path {
            case "/api/comms/threads/th_a/mute": return .json(200, #"{"thread":\#(Self.thread("th_a", muted: true))}"#)
            case "/api/comms/threads/th_a/archive": return .json(200, #"{"thread":\#(Self.thread("th_a", folder: "archived"))}"#)
            case "/api/comms/threads/th_a/status": return .json(200, #"{"thread":\#(Self.thread("th_a", status: "urgent", extra: #","noteId":"n1","folderIds":["cf_1"]"#)),"undo":{"id":"su_1","status":"informational"}}"#)
            case "/api/comms/threads/th_a/status/undo": return .json(200, #"{"thread":\#(Self.thread("th_a", status: "informational"))}"#)
            case "/api/comms/threads/th_x/status": return .json(409, #"{"error":"no_note"}"#)
            case "/api/comms/threads/th_y/status/undo": return .json(409, #"{"error":"status_changed"}"#)
            default: return .json(404, #"{"error":"thread_actions_disabled"}"#)
            }
        }
        let muted = try await comms.setMuted(threadID: "th_a", true)
        XCTAssertTrue(muted.muted)
        XCTAssertEqual(body(server.requests[0]) as? [String: Bool], ["muted": true])
        let archived = try await comms.setArchived(threadID: "th_a", true)
        XCTAssertEqual(archived.folder, .archived)
        let change = try await comms.setStatus(threadID: "th_a", .urgent)
        XCTAssertEqual(change.thread.status, .urgent)
        XCTAssertEqual(change.thread.noteId, "n1")
        XCTAssertEqual(change.thread.folderIds, ["cf_1"])
        XCTAssertEqual(change.undo, .init(id: "su_1", status: .informational))
        XCTAssertEqual(body(server.requests[2]) as? [String: String], ["status": "urgent"])
        let undone = try await comms.undoStatus(threadID: "th_a", undoID: "su_1")
        XCTAssertEqual(undone.status, .informational)
        XCTAssertEqual(body(server.requests[3]) as? [String: String], ["undoId": "su_1"])
        do { _ = try await comms.setStatus(threadID: "th_x", .handled); XCTFail() } catch { XCTAssertEqual(error as? CommsError, .noStatusNote) }
        do { _ = try await comms.undoStatus(threadID: "th_y", undoID: "su_2"); XCTFail() } catch { XCTAssertEqual(error as? CommsError, .statusChanged) }
        do { _ = try await comms.setMuted(threadID: "th_z", true); XCTFail() } catch { XCTAssertEqual(error as? CommsError, .threadActionsDisabled) }
        // Not settable → refused before any request.
        let count = server.requests.count
        do { _ = try await comms.setStatus(threadID: "th_a", .unclassified); XCTFail() } catch {}
        XCTAssertEqual(server.requests.count, count)
    }

    func testFolders() async throws {
        let f1 = #"{"id":"cf_1","name":"Work","position":0,"count":2}"#
        let f2 = #"{"id":"cf_2","name":"Family","position":1,"count":0}"#
        let (comms, server) = try make { r in
            switch (r.method, r.path) {
            case ("GET", "/api/comms/folders"): return .json(200, #"{"folders":[\#(f1),\#(f2)]}"#)
            case ("POST", "/api/comms/folders"): return r.bodyString.contains("Dup") ? .json(409, #"{"error":"folder_exists"}"#) : .json(201, #"{"folder":\#(f2)}"#)
            case ("PATCH", "/api/comms/folders/cf_1"): return .json(200, #"{"folder":\#(f1)}"#)
            case ("DELETE", "/api/comms/folders/cf_2"): return .json(200, #"{"ok":true}"#)
            case ("PUT", "/api/comms/folders/order"): return .json(409, #"{"error":"folders_changed","folderIds":["cf_1"]}"#)
            case ("POST", "/api/comms/folders/cf_1/threads"), ("POST", "/api/comms/folders/cf_1/threads/remove"): return .json(200, #"{"folder":\#(f1)}"#)
            case ("GET", "/api/comms/threads"): return .json(200, #"{"threads":[],"next":null}"#)
            default: return .json(404, #"{"error":"folders_disabled"}"#)
            }
        }
        let list = try await comms.folders()
        XCTAssertEqual(list.map(\.name), ["Work", "Family"])
        let created = try await comms.createFolder(name: "Family")
        XCTAssertEqual(created.id, "cf_2")
        do { _ = try await comms.createFolder(name: "Dup"); XCTFail() } catch { XCTAssertEqual(error as? CommsError, .folderExists) }
        try await comms.renameFolder(id: "cf_1", name: "Work")
        try await comms.deleteFolder(id: "cf_2")
        do { _ = try await comms.reorderFolders(["cf_2", "cf_1"]); XCTFail() } catch { XCTAssertEqual(error as? CommsError, .foldersChanged) }
        try await comms.addToFolder(id: "cf_1", threadIDs: ["th_a", "th_b"])
        try await comms.removeFromFolder(id: "cf_1", threadIDs: ["th_a"])
        let add = try XCTUnwrap(server.requests.first { $0.path == "/api/comms/folders/cf_1/threads" })
        XCTAssertEqual(body(add) as? [String: [String]], ["threadIds": ["th_a", "th_b"]])
        _ = try await comms.threads(CommsThreadQuery(anyFolder: true, inFolder: "cf_1"))
        let q = try XCTUnwrap(server.requests.last).query
        XCTAssertEqual(q["inFolder"], "cf_1")
        XCTAssertNil(q["folder"])
        do { _ = try await comms.deleteFolder(id: "cf_9"); XCTFail() } catch { XCTAssertEqual(error as? CommsError, .foldersDisabled) }
    }
}
