import Foundation
@_exported import PrismModels
import PrismSSE
import PrismTransport

/// Failures of `/api/comms/*` the app handles by name. Anything else keeps the
/// transport's ``PrismError`` (signed out, unreachable, other 4xx/5xx).
public enum CommsError: Error, Equatable, Sendable {
    /// The server is not a Comms server this client can drive (integration, restricted
    /// grant, operations or schema version do not match). Nothing else should be called.
    case unsupportedServer(String)
    /// 503 `source_unavailable`: the network's bridge is down; cached data is still fine.
    case sourceUnavailable(network: CommsNetwork)
    /// 404 `thread_unavailable`.
    case threadUnavailable
    /// 410: the media token expired — refetch the thread/messages for fresh tokens.
    case mediaExpired
    /// 403 `client_scope`: this token may not call that route.
    case clientScope
    /// 404 `person_unavailable`: no such person note (or it was merged / superseded).
    case personUnavailable
    /// 409 `pin_limit`: nine conversations are pinned already (Messages' limit).
    case pinLimit
    /// 409 `pins_changed`: another device pinned or unpinned meanwhile; refetch the pins.
    case pinsChanged
    /// 404 `pins_disabled`: the server has pins turned off.
    case pinsDisabled
    /// 404 `thread_actions_disabled`: Mute / Archive / Status are off on the server.
    case threadActionsDisabled
    /// 404 `folders_disabled`: owner folders are off on the server.
    case foldersDisabled
    /// 404 `folder_unavailable`: no such folder (deleted on another device).
    case folderUnavailable
    /// 409 `folder_exists`: a folder with that name already exists.
    case folderExists
    /// 409 `folder_limit`: twenty folders exist already.
    case folderLimit
    /// 409 `folders_changed`: the order named other folders than exist (refetch).
    case foldersChanged
    /// 409 `no_note`: this conversation has no vault note, so no status can be set.
    case noStatusNote
    /// 409 `status_changed`: the status moved since (someone or the classifier): nothing undone.
    case statusChanged
    /// 409 `already_undone` / 404 `undo_unavailable`.
    case undoUnavailable
    /// A send (`POST /threads/:id/messages` or `/attachments`), or a reaction add/remove, did
    /// not succeed (reactions share the send gates and error codes, plus `alreadyReacted`).
    case sendFailed(CommsSendFailure)
}

/// Why an Omni request in Comms did not start (nothing was sent either way).
public enum CommsOmniError: Error, Equatable, Sendable {
    /// Omni in Comms is switched off on the server.
    case disabled
    /// Omni is still working on this conversation (the running turn, when named).
    case busy(turnID: String?)
    /// Only the owner's signed-in device may ask Omni.
    case deviceRequired
    case rateLimited
    case invalid(String)
    /// Omni (Hermes) or the server didn't answer.
    case unavailable
}

/// Why a send failed, and whether it may have gone out anyway.
public struct CommsSendFailure: Error, Equatable, Sendable {
    public enum Reason: Equatable, Sendable {
        /// 403 `send_disabled` (or the comms module is off): the server's kill switch.
        case sendDisabled
        /// 403 `device_required`: only a signed-in device may send.
        case deviceRequired
        /// 404: the thread (or the replied-to message) is gone.
        case notFound
        /// 409 `unsupported_network`: this network cannot be sent to from Comms.
        case unsupportedNetwork
        /// 413 `too_large`.
        case tooLarge
        /// 415 `unsupported_type`.
        case unsupportedType
        /// 422 `invalid` (empty text, bad clientId, …).
        case invalid
        /// 429 `rate_limited`.
        case rateLimited
        /// 409 `in_progress`: a request with this clientId is still running on the server.
        /// It may yet go out; Try Again later with the same clientId.
        case inProgress
        /// 503 `source_unavailable`: the server has no chat credential to send with.
        case sourceUnavailable
        /// 409 `encrypted_room`: an end-to-end encrypted room; Comms cannot send there.
        case encryptedRoom
        /// 422 `bridge_command`: a text starting with "!" + letter would be a bridge command.
        case bridgeCommand
        /// 422 `topic_required`: a Telegram forum needs the topic to post in (never "All").
        case topicRequired
        /// 409 `topic_mismatch`: the declared topic is not the one the message / thread belongs to (nothing sent).
        case topicMismatch
        /// 429 `busy`: too many uploads at once (`Retry-After` seconds).
        case busy
        /// 409 `already_reacted` (reactions): the owner already has this key on the message
        /// (from this account or from his phone).
        case alreadyReacted
        /// 502 `send_failed` from the homeserver / bridge.
        case sendFailed
        /// The server could not be reached; nothing was delivered.
        case unreachable
        /// Timed out / connection lost / another 5xx: the outcome is unknown.
        case outcomeUnknown
        /// Any other refusal (`error` code kept).
        case other(String)
    }

    public var reason: Reason
    /// The server's human sentence, when it gave one.
    public var message: String?
    /// The message may have reached the network. The client must NOT retry on its own:
    /// it shows "Not Delivered" and only an explicit Try Again (same clientId) resends.
    public var maybeSent: Bool
    /// The HTTP status, when an answer arrived.
    public var status: Int?

    public init(reason: Reason, message: String? = nil, maybeSent: Bool = false, status: Int? = nil) {
        self.reason = reason
        self.message = message
        self.maybeSent = maybeSent
        self.status = status
    }
}

/// What `POST /threads/:id/attachments` carries besides the bytes.
public enum CommsOutgoingKind: String, Sendable, Hashable, CaseIterable {
    case image, video, file, voice
}

/// `GET /threads` filters. `limit` is 1...100 (server default 50).
///
/// `statuses` (`status=<s>`, repeated) and `attention` (`attention=true` = urgent + action
/// required) narrow by Prism's triage status; `person` lists the threads shared with one
/// vault person.
public struct CommsThreadQuery: Sendable, Equatable {
    public var folder: CommsFolder
    public var unreadOnly: Bool
    public var networks: [CommsNetwork]
    public var statuses: [CommsThreadStatus]
    public var attention: Bool
    public var person: String?
    /// An owner folder's threads (`inFolder=`, sprint Task 9). With it, `anyFolder` is implied
    /// unless a system folder is wanted.
    public var inFolder: String?
    /// Send no `folder` (every folder). Meaningful with `person` (the server's default for a
    /// person query); without one the server falls back to the inbox.
    public var anyFolder: Bool
    public var search: String?
    public var cursor: String?
    public var limit: Int?

    public init(folder: CommsFolder = .inbox, unreadOnly: Bool = false, networks: [CommsNetwork] = [], statuses: [CommsThreadStatus] = [], attention: Bool = false, person: String? = nil, anyFolder: Bool = false, search: String? = nil, cursor: String? = nil, limit: Int? = nil, inFolder: String? = nil) {
        self.inFolder = inFolder
        self.folder = folder
        self.unreadOnly = unreadOnly
        self.networks = networks
        self.statuses = statuses
        self.attention = attention
        self.person = person
        self.anyFolder = anyFolder
        self.search = search
        self.cursor = cursor
        self.limit = limit
    }
}

/// Typed calls for `/api/comms/*` (owner-only, restricted `comms-native` token).
///
/// Threads, messages, media and the live stream, plus (Phase 2) owner sends of text and
/// attachments, which the server gates on a device token and `capabilities.send`. A server with
/// `COMMS_ENABLED` off answers 404 `comms_disabled` (``PrismError/rejected(_:)``).
public struct CommsClient: Sendable {
    public let client: PrismClient
    static let base = "/api/comms"
    /// The only schema version this client understands.
    static let schemaVersion = 1
    static let requiredOperations: Set<String> = ["threads:read", "messages:read", "media:read", "stream:read"]

    public init(client: PrismClient) {
        self.client = client
    }

    // MARK: Capabilities

    /// What the server declares. Fails CLOSED: throws ``CommsError/unsupportedServer(_:)``
    /// unless it is the Comms integration, grants a restricted client, speaks schema 1
    /// and offers every read operation this client uses.
    public func capabilities() async throws -> CommsCapabilities {
        let response = try await send(.get("/api/integrations/comms/capabilities"))
        let caps: CommsCapabilities
        do { caps = try response.decode() } catch { throw CommsError.unsupportedServer("capabilities not understood") }
        guard caps.integration == "comms" else { throw CommsError.unsupportedServer("not a comms server") }
        guard caps.restricted else { throw CommsError.unsupportedServer("grant is not restricted") }
        guard caps.schemaVersions.contains(Self.schemaVersion) else { throw CommsError.unsupportedServer("schema version \(caps.schemaVersions) unsupported") }
        guard Self.requiredOperations.isSubset(of: caps.operations) else { throw CommsError.unsupportedServer("missing operations") }
        return caps
    }

    // MARK: Threads and messages

    public func threads(_ q: CommsThreadQuery) async throws -> CommsThreadPage {
        var items = q.anyFolder ? [] : [URLQueryItem(name: "folder", value: q.folder.wire)]
        if q.unreadOnly { items.append(URLQueryItem(name: "unread", value: "1")) }
        if !q.networks.isEmpty { items.append(URLQueryItem(name: "network", value: q.networks.map(\.wire).joined(separator: ","))) }
        for status in q.statuses { items.append(URLQueryItem(name: "status", value: status.wire)) }
        if q.attention { items.append(URLQueryItem(name: "attention", value: "true")) }
        if let p = q.person, !p.isEmpty { items.append(URLQueryItem(name: "person", value: try Self.segment(p))) }
        if let f = q.inFolder, !f.isEmpty { items.append(URLQueryItem(name: "inFolder", value: try Self.segment(f))) }
        if let s = q.search, !s.isEmpty { items.append(URLQueryItem(name: "q", value: s)) }
        if let c = q.cursor, !c.isEmpty { items.append(URLQueryItem(name: "cursor", value: c)) }
        if let l = q.limit { items.append(URLQueryItem(name: "limit", value: String(l))) }
        return try await send(.get("\(Self.base)/threads", query: items)).decode()
    }

    public func thread(id: String) async throws -> CommsThreadDetail {
        try await send(.get("\(Self.base)/threads/\(try Self.segment(id))")).decode()
    }

    // MARK: Pins

    /// `GET /pins`: the pinned threads in the owner's grid order (shared by every device).
    public func pins() async throws -> [CommsThread] {
        try await send(.get("\(Self.base)/pins")).decode(PinnedThreads.self).threads
    }

    /// `POST /threads/:id/pin`: pin at the end of the grid (idempotent). Nine pinned already →
    /// ``CommsError/pinLimit``.
    @discardableResult
    public func pin(threadID: String) async throws -> CommsThread {
        try await send(PrismRequest(method: "POST", path: "\(Self.base)/threads/\(try Self.segment(threadID))/pin")).decode(OneThread.self).thread
    }

    /// `DELETE /threads/:id/pin` (idempotent).
    @discardableResult
    public func unpin(threadID: String) async throws -> CommsThread {
        try await send(PrismRequest(method: "DELETE", path: "\(Self.base)/threads/\(try Self.segment(threadID))/pin")).decode(OneThread.self).thread
    }

    /// `PUT /pins {threadIds}`: the new grid order; must name exactly the pinned set, else
    /// ``CommsError/pinsChanged``.
    @discardableResult
    public func reorderPins(_ threadIDs: [String]) async throws -> [CommsThread] {
        struct Body: Encodable { let threadIds: [String] }
        let ids = try threadIDs.map { try Self.segment($0) }
        return try await send(try PrismRequest.json("PUT", "\(Self.base)/pins", body: Body(threadIds: ids))).decode(PinnedThreads.self).threads
    }

    private struct PinnedThreads: Decodable { let threads: [CommsThread] }

    // MARK: Row actions (sprint Task 9)

    /// `POST /threads/:id/mute {muted}` (Hide Alerts: no notification for it).
    @discardableResult
    public func setMuted(threadID: String, _ muted: Bool) async throws -> CommsThread {
        struct Body: Encodable { let muted: Bool }
        return try await send(try PrismRequest.json("POST", "\(Self.base)/threads/\(try Self.segment(threadID))/mute", body: Body(muted: muted))).decode(OneThread.self).thread
    }

    /// `POST /threads/:id/archive {archived}`: to / from the Archived folder.
    @discardableResult
    public func setArchived(threadID: String, _ archived: Bool) async throws -> CommsThread {
        struct Body: Encodable { let archived: Bool }
        return try await send(try PrismRequest.json("POST", "\(Self.base)/threads/\(try Self.segment(threadID))/archive", body: Body(archived: archived))).decode(OneThread.self).thread
    }

    /// `POST /threads/:id/status {status}`: one tag write on the thread's vault note (Prism's
    /// status rules), with an undo. Only ``CommsThreadStatus/settable`` statuses are accepted.
    public func setStatus(threadID: String, _ status: CommsThreadStatus) async throws -> CommsStatusChange {
        struct Body: Encodable { let status: String }
        guard CommsThreadStatus.settable.contains(status) else { throw PrismError.invalidRequest("status not settable") }
        return try await send(try PrismRequest.json("POST", "\(Self.base)/threads/\(try Self.segment(threadID))/status", body: Body(status: status.wire))).decode()
    }

    /// `POST /threads/:id/status/undo {undoId}`.
    @discardableResult
    public func undoStatus(threadID: String, undoID: String) async throws -> CommsThread {
        struct Body: Encodable { let undoId: String }
        return try await send(try PrismRequest.json("POST", "\(Self.base)/threads/\(try Self.segment(threadID))/status/undo", body: Body(undoId: try Self.segment(undoID)))).decode(OneThread.self).thread
    }

    // MARK: Owner folders (sprint Task 9)

    private struct Folders: Decodable { let folders: [CommsChatFolder] }
    private struct OneFolder: Decodable { let folder: CommsChatFolder }
    private struct Name: Encodable { let name: String }
    private struct ThreadIDs: Encodable { let threadIds: [String] }

    /// `GET /folders`, in the owner's order.
    public func folders() async throws -> [CommsChatFolder] {
        try await send(.get("\(Self.base)/folders")).decode(Folders.self).folders
    }

    public func createFolder(name: String) async throws -> CommsChatFolder {
        try await send(try PrismRequest.json("POST", "\(Self.base)/folders", body: Name(name: name))).decode(OneFolder.self).folder
    }

    @discardableResult
    public func renameFolder(id: String, name: String) async throws -> CommsChatFolder {
        try await send(try PrismRequest.json("PATCH", "\(Self.base)/folders/\(try Self.segment(id))", body: Name(name: name))).decode(OneFolder.self).folder
    }

    /// Delete a folder; its conversations stay where they are.
    public func deleteFolder(id: String) async throws {
        _ = try await send(PrismRequest(method: "DELETE", path: "\(Self.base)/folders/\(try Self.segment(id))"))
    }

    /// `PUT /folders/order`: exactly the existing folders (else ``CommsError/foldersChanged``).
    @discardableResult
    public func reorderFolders(_ ids: [String]) async throws -> [CommsChatFolder] {
        struct Body: Encodable { let folderIds: [String] }
        let ids = try ids.map { try Self.segment($0) }
        return try await send(try PrismRequest.json("PUT", "\(Self.base)/folders/order", body: Body(folderIds: ids))).decode(Folders.self).folders
    }

    @discardableResult
    public func addToFolder(id: String, threadIDs: [String]) async throws -> CommsChatFolder {
        let ids = try threadIDs.map { try Self.segment($0) }
        return try await send(try PrismRequest.json("POST", "\(Self.base)/folders/\(try Self.segment(id))/threads", body: ThreadIDs(threadIds: ids))).decode(OneFolder.self).folder
    }

    @discardableResult
    public func removeFromFolder(id: String, threadIDs: [String]) async throws -> CommsChatFolder {
        let ids = try threadIDs.map { try Self.segment($0) }
        return try await send(try PrismRequest.json("POST", "\(Self.base)/folders/\(try Self.segment(id))/threads/remove", body: ThreadIDs(threadIds: ids))).decode(OneFolder.self).folder
    }
    private struct OneThread: Decodable { let thread: CommsThread }

    // MARK: People

    /// `GET /people/:id`: the person, how to reach them, and every conversation shared with
    /// them (DMs on each network and their groups, any folder), newest activity first. An
    /// unknown, merged or superseded person throws ``CommsError/personUnavailable``.
    public func person(id: String) async throws -> CommsPerson {
        try await send(.get("\(Self.base)/people/\(try Self.segment(id))")).decode()
    }

    /// One page, newest LAST. Pass the previous page's `before` to go further back while
    /// its `hasMore` is true. `limit` is 1...100.
    ///
    /// A Telegram forum thread: `topic` = one topic's timeline; nil = "All topics" (merged, each
    /// message tagged with its ``CommsMessage/topic``). Cursors belong to the view they came from.
    public func messages(threadID: String, before: String?, limit: Int, topic: String? = nil) async throws -> CommsMessagePage {
        var items: [URLQueryItem] = []
        if let topic, !topic.isEmpty { items.append(URLQueryItem(name: "topic", value: topic)) }
        if let before, !before.isEmpty { items.append(URLQueryItem(name: "before", value: before)) }
        items.append(URLQueryItem(name: "limit", value: String(limit)))
        return try await send(.get("\(Self.base)/threads/\(try Self.segment(threadID))/messages", query: items)).decode()
    }

    // MARK: Sending

    /// `POST /threads/:id/messages` `{clientId, text, replyTo?}`. The SAME `clientID`
    /// for a retry of the same message (the server is idempotent on it). Failures throw
    /// ``CommsError/sendFailed(_:)`` (or ``PrismError/notSignedIn`` / ``PrismError/signedOut``).
    ///
    /// `mentions` (groups whose channel declares `mentions`): UTF-16 ranges of `text`. `channel`:
    /// the channel the owner picked in a merged conversation; the server refuses the send (409)
    /// unless the thread sends through exactly that channel.
    ///
    /// `topic`: a Telegram forum thread's topic to post in — required there (the server refuses
    /// a send without one, `topicRequired`), ignored elsewhere.
    public func sendText(threadID: String, clientID: String, text: String, replyTo: String? = nil, email: CommsEmailDetail.Reply? = nil, mentions: [CommsMention] = [], channel: CommsChannelRef? = nil, topic: String? = nil) async throws -> CommsSendResult {
        try Self.checkClientID(clientID)
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw CommsError.sendFailed(CommsSendFailure(reason: .invalid, message: "The message is empty."))
        }
        guard text.utf8.count <= Self.maxTextBytes else {
            throw CommsError.sendFailed(CommsSendFailure(reason: .tooLarge, message: "The message is too long to send."))
        }
        let units = text.utf16.count
        guard mentions.allSatisfy({ $0.start >= 0 && $0.length > 0 && $0.start + $0.length <= units }) else {
            throw CommsError.sendFailed(CommsSendFailure(reason: .invalid, message: "A mention is outside the message."))
        }
        // `email`: on an email thread, the To/Cc/Subject the composer SHOWED (the server compares
        // them with what it would send and refuses a difference: 409 `target_changed`).
        struct Body: Encodable { var clientId: String; var text: String; var replyTo: String?; var email: CommsEmailDetail.Reply?; var mentions: [CommsMention]?; var channel: ChannelPick?; var topic: String? }
        let path = "\(Self.base)/threads/\(try Self.segment(threadID))/messages"
        // A comms message id is the Matrix event id (`$…`); refused locally like the server would.
        if let replyTo { _ = try Self.messageSegment(replyTo) }
        let request = try PrismRequest.json("POST", path, body: Body(clientId: clientID, text: text, replyTo: replyTo, email: email,
                                                                     mentions: mentions.isEmpty ? nil : mentions.sorted { $0.start < $1.start },
                                                                     channel: channel.map(ChannelPick.init), topic: topic))
        return try await sendMessage(request)
    }

    /// `POST /threads/:id/attachments` (multipart): one file, its kind, and for voice the
    /// duration and waveform (≤ 200 values, each 0…1024; out-of-range values are clamped).
    /// A caption is sent separately with ``sendText(threadID:clientID:text:replyTo:)``.
    /// `w` / `h` (image / video) are size hints the server accepts; for images it reads the
    /// real size from the bytes. Pictures must be JPEG, PNG, GIF or WebP (HEIC is refused).
    public func sendAttachment(threadID: String, clientID: String, kind: CommsOutgoingKind, data: Data, mime: String, filename: String, durationMs: Int? = nil, waveform: [Int]? = nil, w: Int? = nil, h: Int? = nil, channel: CommsChannelRef? = nil, topic: String? = nil) async throws -> CommsSendResult {
        try Self.checkClientID(clientID)
        guard !data.isEmpty else { throw CommsError.sendFailed(CommsSendFailure(reason: .invalid, message: "The file is empty.")) }
        var form = Self.form(clientID: clientID, kind: kind, durationMs: durationMs, waveform: waveform, w: w, h: h, channel: channel)
        form.file("file", filename: Self.safeFilename(filename), mime: Self.safeMime(mime), data: data)
        let path = "\(Self.base)/threads/\(try Self.segment(threadID))/attachments"
        let request = PrismRequest(method: "POST", path: path, query: Self.topicQuery(topic), body: form.finish(), timeout: Self.uploadTimeout, contentType: form.contentType)
        return try await sendMessage(request)
    }

    /// The same upload streamed from a local file: the bytes are never loaded into memory (the
    /// multipart body is assembled in a temporary file, deleted afterwards). With `maxBytes`, a
    /// larger file is refused locally (`tooLarge`) before anything is read or sent.
    public func sendAttachment(threadID: String, clientID: String, kind: CommsOutgoingKind, fileURL: URL, mime: String, filename: String? = nil, durationMs: Int? = nil, waveform: [Int]? = nil, w: Int? = nil, h: Int? = nil, maxBytes: Int? = nil, channel: CommsChannelRef? = nil, topic: String? = nil) async throws -> CommsSendResult {
        try Self.checkClientID(clientID)
        guard fileURL.isFileURL, let size = (try? FileManager.default.attributesOfItem(atPath: fileURL.path))?[.size] as? Int else {
            throw CommsError.sendFailed(CommsSendFailure(reason: .invalid, message: "The file can't be read."))
        }
        guard size > 0 else { throw CommsError.sendFailed(CommsSendFailure(reason: .invalid, message: "The file is empty.")) }
        if let maxBytes, maxBytes > 0, size > maxBytes {
            throw CommsError.sendFailed(CommsSendFailure(reason: .tooLarge, message: "The attachment is too large to send."))
        }
        let path = "\(Self.base)/threads/\(try Self.segment(threadID))/attachments"
        var form = Self.form(clientID: clientID, kind: kind, durationMs: durationMs, waveform: waveform, w: w, h: h, channel: channel)
        let head = form.fileHeader("file", filename: Self.safeFilename(filename ?? fileURL.lastPathComponent), mime: Self.safeMime(mime))
        let body = FileManager.default.temporaryDirectory.appendingPathComponent("comms-upload-\(UUID().uuidString).multipart")
        defer { try? FileManager.default.removeItem(at: body) }
        do {
            try MultipartForm.writeFile(to: body, head: head, source: fileURL, tail: form.tail)
        } catch {
            throw CommsError.sendFailed(CommsSendFailure(reason: .invalid, message: "The file can't be read."))
        }
        var request = PrismRequest(method: "POST", path: path, query: Self.topicQuery(topic), timeout: Self.uploadTimeout, contentType: form.contentType)
        request.bodyFileURL = body
        return try await sendMessage(request)
    }

    /// The wire form of a channel pick: `{network, accountLabel?}`.
    struct ChannelPick: Encodable {
        var network: String
        var accountLabel: String?
        init(_ c: CommsChannelRef) { network = c.network.wire; accountLabel = c.accountLabel }
        var json: String { (try? String(decoding: JSONEncoder().encode(self), as: UTF8.self)) ?? "{}" }
    }

    static func form(clientID: String, kind: CommsOutgoingKind, durationMs: Int?, waveform: [Int]?, w: Int?, h: Int?, channel: CommsChannelRef? = nil) -> MultipartForm {
        var form = MultipartForm()
        form.field("clientId", clientID)
        form.field("kind", kind.rawValue)
        if let channel { form.field("channel", ChannelPick(channel).json) }
        if let durationMs, kind == .voice || kind == .video { form.field("durationMs", String(max(0, durationMs))) }
        if let waveform, kind == .voice, !waveform.isEmpty {
            let clamped = waveform.prefix(Self.maxWaveformSamples).map { min(1024, max(0, $0)) }
            form.field("waveform", "[" + clamped.map(String.init).joined(separator: ",") + "]")
        }
        if kind == .image || kind == .video, let w, let h, w > 0, h > 0 {
            form.field("w", String(w))
            form.field("h", String(h))
        }
        return form
    }

    // MARK: New conversations (phase 2b)

    /// `GET /recipients?q=&limit=`: the To: field's suggestions — people (with any existing
    /// iMessage/SMS thread per address), existing conversations on any network, and the text
    /// itself when it is a sendable address. `q` is trimmed, 1…100 characters (refused
    /// locally otherwise); `limit` 1…20 per list.
    public func recipients(query: String, limit: Int = 8) async throws -> CommsRecipients {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty, q.count <= 100 else { throw PrismError.invalidRequest("The search must be 1 to 100 characters.") }
        let items = [URLQueryItem(name: "q", value: q), URLQueryItem(name: "limit", value: String(min(20, max(1, limit))))]
        return try await send(.get("\(Self.base)/recipients", query: items)).decode()
    }

    /// The networks a new conversation can be started on.
    public enum NewConversationNetwork: String, Sendable, Hashable { case imessage, sms, email }

    /// `POST /conversations` `{clientId, handle, network, text}`: start an iMessage/SMS
    /// conversation with `handle` (an E.164 phone or an email). When one already exists the
    /// server sends NOTHING and answers `existing: true` with its id — open it and send there.
    /// The SAME `clientID` for a Try Again (idempotent). Failures throw
    /// ``CommsError/sendFailed(_:)`` like a send (`invalid` carries the server's sentence,
    /// e.g. for an address it can't use).
    /// `email` (D11): `handle` is an email address and `subject` is required; the server sends it
    /// through the same approval executor as a reply (plain text only).
    public func startConversation(clientID: String, handle: String, network: NewConversationNetwork, text: String, subject: String? = nil) async throws -> CommsNewConversation {
        try Self.checkClientID(clientID)
        let h = handle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !h.isEmpty, h.utf8.count <= 254 else {
            throw CommsError.sendFailed(CommsSendFailure(reason: .invalid, message: "That address can't be used."))
        }
        if network == .sms, h.contains("@") {
            throw CommsError.sendFailed(CommsSendFailure(reason: .invalid, message: "SMS needs a phone number."))
        }
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw CommsError.sendFailed(CommsSendFailure(reason: .invalid, message: "The message is empty."))
        }
        guard text.utf8.count <= Self.maxTextBytes else {
            throw CommsError.sendFailed(CommsSendFailure(reason: .tooLarge, message: "The message is too long to send."))
        }
        if network == .email {
            guard h.contains("@") else { throw CommsError.sendFailed(CommsSendFailure(reason: .invalid, message: "Use an email address.")) }
            guard let s = subject, !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                throw CommsError.sendFailed(CommsSendFailure(reason: .invalid, message: "A new email needs a subject."))
            }
        }
        struct Body: Encodable { var clientId: String; var handle: String; var network: String; var text: String; var subject: String? }
        let request = try PrismRequest.json("POST", "\(Self.base)/conversations",
                                            body: Body(clientId: clientID.lowercased(), handle: h, network: network.rawValue, text: text, subject: network == .email ? subject : nil))
        let r: PrismResponse
        do { r = try await client.sendRaw(request) } catch { throw Self.mapSend(error) }
        guard r.isSuccess else { throw Self.mapSend(PrismClient.error(for: r)) }
        do { return try r.decode(CommsNewConversation.self) } catch {
            throw CommsError.sendFailed(CommsSendFailure(reason: .outcomeUnknown, message: "The server's answer was not understood.", maybeSent: true, status: r.status))
        }
    }

    // MARK: Email

    /// `GET /threads/:id/messages/:messageId/original` — "View full email".
    public func emailOriginal(threadID: String, messageID: String) async throws -> CommsEmailOriginal {
        let path = "\(Self.base)/threads/\(try Self.segment(threadID))/messages/\(Self.percentEncodedSegment(messageID))/original"
        guard !messageID.isEmpty, messageID.count <= 300 else { throw CommsError.threadUnavailable }
        return try await send(.get(path)).decode(CommsEmailOriginal.self)
    }

    // MARK: Reactions

    /// `POST /threads/:id/messages/:messageId/reactions` `{clientId, key}`: react with `key`
    /// (any short emoji / text, ≤ 64 characters). The SAME `clientID` for a Try Again (the
    /// server is idempotent on it). Failures throw ``CommsError/sendFailed(_:)`` with the send
    /// reasons plus ``CommsSendFailure/Reason/alreadyReacted`` (409) and `notFound` (404: the
    /// thread or message is gone, or not in this thread).
    public func addReaction(threadID: String, messageID: String, clientID: String, key: String, topic: String? = nil) async throws -> CommsSendResult {
        try Self.checkClientID(clientID)
        let k = try Self.reactionKey(key)
        struct Body: Encodable { var clientId: String; var key: String; var topic: String? }
        var request = try PrismRequest.json("POST", try Self.reactionsPath(threadID: threadID, messageID: messageID), body: Body(clientId: clientID, key: k, topic: topic))
        request.percentEncodedPath = true
        return try await sendMessage(request)
    }

    /// `DELETE /threads/:id/messages/:messageId/reactions/:key`: remove the owner's reaction
    /// `key` (only one this Comms account sent; a reaction made from the phone answers 404
    /// `notFound`, as does one already removed). Failures throw ``CommsError/sendFailed(_:)``.
    public func removeReaction(threadID: String, messageID: String, key: String, topic: String? = nil) async throws {
        let k = try Self.reactionKey(key)
        let path = try Self.reactionsPath(threadID: threadID, messageID: messageID) + "/" + Self.percentEncodedSegment(k)
        var request = PrismRequest(method: "DELETE", path: path, query: Self.topicQuery(topic))
        request.percentEncodedPath = true
        let r: PrismResponse
        do { r = try await client.sendRaw(request) } catch { throw Self.mapSend(error) }
        guard r.isSuccess else { throw Self.mapSend(PrismClient.error(for: r)) }
    }

    /// `?topic=` for a forum send (attachments, reaction removal); none when nil.
    static func topicQuery(_ topic: String?) -> [URLQueryItem] {
        guard let topic, !topic.isEmpty else { return [] }
        return [URLQueryItem(name: "topic", value: topic)]
    }

    static func reactionsPath(threadID: String, messageID: String) throws -> String {
        "\(Self.base)/threads/\(try Self.segment(threadID))/messages/\(Self.percentEncodedSegment(try Self.messageSegment(messageID)))/reactions"
    }

    /// A comms message id: the Matrix event id (`$` + `[A-Za-z0-9._~=+/:-]`, ≤ 256), as the
    /// server validates it, and never a path-like shape (`..`, `//`, `/.`, a trailing `/`): room
    /// v1/v2 ids are chosen by federated homeservers, and the id travels as ONE percent-encoded
    /// segment that a proxy decoding `%2F` must still not turn into another route. Refused
    /// locally otherwise (`invalid`).
    static func messageSegment(_ id: String) throws -> String {
        let n = id.utf8.count
        guard n >= 2, n <= 256, id.hasPrefix("$"), id.utf8.dropFirst().allSatisfy({ c in
            (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A)
                || [0x2E, 0x5F, 0x7E, 0x3D, 0x2B, 0x2F, 0x3A, 0x2D].contains(c)
        }), !id.contains(".."), !id.contains("//"), !id.hasSuffix("/"), !id.contains("/.")
        else { throw CommsError.sendFailed(CommsSendFailure(reason: .invalid, message: "That message can't be reacted to.")) }
        return id
    }

    /// A reaction key the server accepts: 1…64 characters (code points), no NUL / CR / LF or
    /// other control characters, well-formed.
    static func reactionKey(_ key: String) throws -> String {
        let scalars = key.unicodeScalars
        guard !key.isEmpty, scalars.count <= 64, !scalars.contains(where: { $0.properties.generalCategory == .control }) else {
            throw CommsError.sendFailed(CommsSendFailure(reason: .invalid, message: "That reaction can't be sent."))
        }
        return key
    }

    /// Every byte but RFC 3986 unreserved characters escaped (`$` → `%24`, `/` → `%2F`, emoji
    /// as UTF-8 escapes); the request is marked ``PrismRequest/percentEncodedPath``.
    static func percentEncodedSegment(_ s: String) -> String {
        s.addingPercentEncoding(withAllowedCharacters: unreservedCharacters) ?? ""
    }
    private static let unreservedCharacters = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")

    static let maxTextBytes = 32_000
    static let maxWaveformSamples = 200
    static let uploadTimeout: TimeInterval = 180

    private func sendMessage(_ request: PrismRequest) async throws -> CommsSendResult {
        let r: PrismResponse
        do { r = try await client.sendRaw(request) } catch { throw Self.mapSend(error) }
        guard r.isSuccess else { throw Self.mapSend(PrismClient.error(for: r)) }
        do { return try r.decode(CommsSendResult.self) } catch {
            // The server said 2xx: it was accepted, but we cannot read the event id.
            throw CommsError.sendFailed(CommsSendFailure(reason: .outcomeUnknown, message: "The server's answer was not understood.", maybeSent: true, status: r.status))
        }
    }

    /// The contract's send errors. Signed-out / not-signed-in stay ``PrismError``.
    static func mapSend(_ error: any Error) -> any Error {
        if error is CancellationError { return CommsError.sendFailed(CommsSendFailure(reason: .outcomeUnknown, maybeSent: true)) }
        guard let e = error as? PrismError else { return error }
        let body: Data?
        switch e {
        case .forbidden(let f), .conflict(let f), .rejected(let f): body = f.body
        case .outcomeUnknown(let u): body = u.body
        case .unreachable:
            return CommsError.sendFailed(CommsSendFailure(reason: .unreachable, message: "Can't reach the server."))
        case .invalidRequest(let why):
            return CommsError.sendFailed(CommsSendFailure(reason: .invalid, message: why))
        default:
            return e
        }
        let obj = (body.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any])
        let message = (obj?["message"] as? String ?? obj?["detail"] as? String).map { String($0.prefix(300)) }
        let status = e.httpStatus
        let code = e.serverCode ?? ""
        let reason: CommsSendFailure.Reason
        switch (status, code) {
        case (403, "send_disabled"), (404, "comms_disabled"): reason = .sendDisabled
        case (403, "device_required"): reason = .deviceRequired
        case (403, "client_scope"): return CommsError.clientScope
        case (404, _): reason = .notFound
        case (409, "unsupported_network"): reason = .unsupportedNetwork
        case (409, "in_progress"): reason = .inProgress
        case (409, "encrypted_room"): reason = .encryptedRoom
        case (409, "already_reacted"): reason = .alreadyReacted
        case (422, "bridge_command"): reason = .bridgeCommand
        case (422, "topic_required"): reason = .topicRequired
        case (409, "topic_mismatch"): reason = .topicMismatch
        case (429, "busy"): reason = .busy
        case (503, "source_unavailable"): reason = .sourceUnavailable
        case (413, _): reason = .tooLarge
        case (415, _): reason = .unsupportedType
        case (422, _), (400, _): reason = .invalid
        case (429, _): reason = .rateLimited
        case (502, "send_failed"): reason = .sendFailed
        case (nil, _): reason = .outcomeUnknown
        case (let s?, _) where s >= 500: reason = .outcomeUnknown
        default: reason = .other(code)
        }
        // Only a 502 says outright whether it may have gone out; any other 5xx or a lost
        // connection may have landed, so assume it did (never auto-retry those).
        let maybeSent: Bool
        switch reason {
        case .sendFailed: maybeSent = (obj?["maybeSent"] as? Bool) ?? true
        case .outcomeUnknown, .inProgress: maybeSent = true
        default: maybeSent = false
        }
        return CommsError.sendFailed(CommsSendFailure(reason: reason, message: message, maybeSent: maybeSent, status: status))
    }

    /// A clientId is a UUID (the server derives the Matrix txn id from it).
    static func checkClientID(_ id: String) throws {
        guard UUID(uuidString: id) != nil else { throw CommsError.sendFailed(CommsSendFailure(reason: .invalid, message: "clientId must be a UUID.")) }
    }

    /// A file name without paths, quotes or control characters (it goes in a header).
    static func safeFilename(_ name: String) -> String {
        let last = (name as NSString).lastPathComponent
        let cleaned = String(last.unicodeScalars.filter { $0.value >= 0x20 && $0 != "\"" && $0 != "\\" && $0 != "/" && $0.value != 0x7F }.map(Character.init))
        let trimmed = cleaned.trimmingCharacters(in: .whitespaces)
        return trimmed.isEmpty || trimmed == "." || trimmed == ".." ? "file" : String(trimmed.prefix(200))
    }

    /// `type/subtype` only; anything else is sent as `application/octet-stream`.
    static func safeMime(_ mime: String) -> String {
        let base = mime.split(separator: ";").first.map { $0.trimmingCharacters(in: .whitespaces).lowercased() } ?? ""
        let ok = base.utf8.count <= 100 && base.split(separator: "/").count == 2 && base.utf8.allSatisfy { c in
            (c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x7A) || c == 0x2F || c == 0x2E || c == 0x2B || c == 0x2D || c == 0x5F
        }
        return ok ? base : "application/octet-stream"
    }

    // MARK: Media

    /// The absolute URL of a media or avatar token (`<origin>/api/comms/media/<token>`).
    ///
    /// The server REQUIRES the bearer on this request. A plain URL load (`AsyncImage`,
    /// `URLSession.shared`, a web view) is refused with 401, so native code must not fetch
    /// it directly: use ``media(token:)``, which attaches the credential and checks the
    /// origin. The URL is for identity (cache keys) and for handing to an authenticated
    /// loader.
    public func mediaURL(token: String) -> URL {
        let escaped = token.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? token
        // The origin builds the URL (https only; loopback http in debug builds).
        return (try? client.origin.url(path: "\(Self.base)/media/\(escaped)")) ?? URL(string: client.origin.value)!
    }

    /// Fetch a token's bytes with the bearer attached. Throws ``CommsError/mediaExpired``
    /// on 410. Returns the bytes and the `Content-Type` (`application/octet-stream` when
    /// the server named none).
    public func media(token: String) async throws -> (Data, String) {
        try await media(token: token, playableAudio: false)
    }

    /// `playableAudio`: ask for a rendition AVFoundation can play (`?format=m4a`) — the server
    /// transcodes Ogg/Opus, AMR and WebM voice notes to AAC and answers anything already playable
    /// unchanged. Errors: 503 `transcode_unavailable`, 422 `transcode_failed`, 413 `too_large`.
    public func media(token: String, playableAudio: Bool) async throws -> (Data, String) {
        var request = PrismRequest.get("\(Self.base)/media/\(try Self.segment(token))", query: playableAudio ? [URLQueryItem(name: "format", value: "m4a")] : [])
        // The server streams up to 200 MB of media (MEDIA_MAX_BYTES); the client's 32 MB JSON
        // cap refused every large video and big photo (owner report: "won't open at all").
        request.maxResponseBytes = Self.mediaMaxBytes
        let response = try await send(request)
        return (response.body, response.header("Content-Type") ?? "application/octet-stream")
    }

    /// The largest media body accepted (the server's `MEDIA_MAX_BYTES`).
    public static let mediaMaxBytes = 200 * 1024 * 1024

    /// `POST /api/comms/media/refresh`: fresh tokens for expired ones (same media, same
    /// size, this device). Tokens the server would not refresh are absent from the result.
    public func refreshMedia(tokens: [String]) async throws -> [String: String] {
        guard !tokens.isEmpty else { return [:] }
        struct Body: Encodable { let tokens: [String] }
        struct Answer: Decodable { let tokens: [String: String?] }
        let request = PrismRequest(method: "POST", path: "\(Self.base)/media/refresh", body: try JSONEncoder().encode(Body(tokens: Array(tokens.prefix(100)))))
        let answer = try await send(request).decode(Answer.self)
        return answer.tokens.compactMapValues { $0 }
    }

    // MARK: Live

    /// `GET /api/comms/stream`, resuming after `lastEventID` (`Last-Event-ID`). A dropped
    /// connection is retried with backoff from the last event seen; a `.reset` event means
    /// the server could not replay the gap — refetch what is on screen. Fatal errors
    /// (signed out, `client_scope`, …) end the sequence by throwing. Cancelling the
    /// consuming task closes the connection.
    public func stream(lastEventID: String?, policy: SSERetryPolicy = .default) -> AsyncThrowingStream<CommsEvent, any Error> {
        let client = self.client
        let sse = SSEStream.events(lastEventID: lastEventID, policy: policy, reconnectOnEnd: true, classify: Self.classify) { cursor in
            var request = PrismRequest.get("\(Self.base)/stream")
            if let cursor { request.headers["Last-Event-ID"] = cursor }
            do { return try await client.openStream(request) } catch { throw Self.map(error) }
        }
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    for try await item in sse {
                        guard case .event(let e) = item else { continue }
                        let payload = (try? PrismJSON.decoder().decode(JSONValue.self, from: Data(e.data.utf8))) ?? .null
                        continuation.yield(CommsEvent(id: e.id, kind: CommsEventKind(wire: e.event), payload: payload))
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    static let classify: SSEStream.Classify = { error in
        if let c = error as? CommsError {
            switch c {
            case .clientScope, .threadUnavailable, .mediaExpired: return .fail
            default: return .retry
            }
        }
        guard let e = error as? PrismError else { return .retry }
        switch e {
        case .unreachable, .outcomeUnknown, .unauthorized: return .retry
        case .rejected(let f): return [408, 425, 429].contains(f.status) ? .retry : .fail
        default: return .fail
        }
    }

    // MARK: Read state + notifications (Sprint Task 1)

    /// `POST /threads/:id/read` `{upTo?, viewing?, explicit?}`: mark read up to `upTo` (default:
    /// everything). `viewing: true` = this device shows the thread now (no push for it; renew
    /// within 90 s), `false` = it closed. `explicit: true` ONLY for the owner's own "Mark as Read"
    /// action: it sends a network read receipt where supported even with the receipts toggle off
    /// (D10); opening / viewing sends one only with the toggle on. Both need the server flag —
    /// see ``CommsReadResult/receipt``.
    @discardableResult
    ///
    /// `topic`: a Telegram forum topic read on its own — only that topic's read point moves (and a
    /// receipt names only it); nil = the whole thread (a forum's All Topics up to `upTo`).
    public func markRead(threadID: String, upTo: Date? = nil, viewing: Bool? = nil, explicit: Bool = false, topic: String? = nil) async throws -> CommsReadResult {
        struct Body: Encodable { var upTo: String?; var viewing: Bool?; var explicit: Bool?; var topic: String? }
        let stamp = upTo.map { Self.isoFormatter.string(from: $0) }
        let body = Body(upTo: stamp, viewing: viewing, explicit: explicit ? true : nil, topic: topic)
        let request = try PrismRequest.json("POST", "\(Self.base)/threads/\(try Self.segment(threadID))/read", body: body)
        return try await send(request).decode()
    }

    /// `POST /threads/:id/unread`: the thread shows unread until it is read again.
    @discardableResult
    public func markUnread(threadID: String) async throws -> CommsUnreadResult {
        struct Empty: Encodable {}
        return try await send(try PrismRequest.json("POST", "\(Self.base)/threads/\(try Self.segment(threadID))/unread", body: Empty())).decode()
    }

    /// `GET /threads/status-counts` — per-status counts and (newer servers) the unread summary.
    public func statusCounts(folder: CommsFolder = .inbox) async throws -> CommsStatusCounts {
        try await send(.get("\(Self.base)/threads/status-counts", query: [URLQueryItem(name: "folder", value: folder.wire)])).decode()
    }

    public func notificationSettings() async throws -> CommsNotifySettingsResponse {
        try await send(.get("\(Self.base)/notifications/settings")).decode()
    }

    /// `PUT /notifications/settings` with ONLY the changed keys (the server merges key by key, and
    /// status / network maps entry by entry): a stale screen never undoes another device's choice.
    public func updateNotificationSettings(_ patch: CommsNotifySettingsPatch) async throws -> CommsNotifySettingsResponse {
        try await send(try PrismRequest.json("PUT", "\(Self.base)/notifications/settings", body: patch)).decode()
    }

    /// `POST /notifications/test`: a fixed "Notifications are working" alert to each of the owner's
    /// Comms devices; answers what APNs said for each (status + Apple's reason).
    public func sendTestNotification() async throws -> CommsPushTestResult {
        struct Empty: Encodable {}
        return try await send(try PrismRequest.json("POST", "\(Self.base)/notifications/test", body: Empty())).decode()
    }

    /// `POST /devices/apns`: register this app's APNs device token (raw bytes → lowercase hex).
    public func registerPush(deviceToken: Data, environment: CommsPushEnvironment, platform: CommsPushPlatform) async throws -> CommsPushRegistration {
        struct Body: Encodable { var token: String; var environment: CommsPushEnvironment; var platform: CommsPushPlatform }
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        return try await send(try PrismRequest.json("POST", "\(Self.base)/devices/apns", body: Body(token: hex, environment: environment, platform: platform))).decode()
    }

    /// `DELETE /devices/apns`: this device stops receiving Comms notifications.
    public func unregisterPush() async throws {
        _ = try await send(PrismRequest(method: "DELETE", path: "\(Self.base)/devices/apns"))
    }

    nonisolated(unsafe) static let isoFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    // MARK: Search (Task 4)

    /// `GET /search?q=`: messages across all history (projected + vault transcripts), best
    /// first, with highlight ranges; the first page also carries conversation suggestions.
    /// Pass the previous page's `next` as `cursor`. 404 `search_disabled` = the server has no
    /// full search (fall back to thread search).
    public func search(query: String, filter: CommsSearchFilter = CommsSearchFilter(), cursor: String? = nil, limit: Int = 30) async throws -> CommsSearchResults {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty, q.count <= 200 else { throw PrismError.invalidRequest("The search must be 1 to 200 characters.") }
        var items = [URLQueryItem(name: "q", value: q), URLQueryItem(name: "limit", value: String(min(50, max(1, limit))))]
        if let t = filter.threadId { items.append(URLQueryItem(name: "thread", value: try Self.segment(t))) }
        if let p = filter.personId { items.append(URLQueryItem(name: "person", value: try Self.segment(p))) }
        if !filter.networks.isEmpty { items.append(URLQueryItem(name: "network", value: filter.networks.map(\.wire).joined(separator: ","))) }
        if let s = filter.fromSelf { items.append(URLQueryItem(name: "from", value: s ? "me" : "others")) }
        if let c = cursor, !c.isEmpty { items.append(URLQueryItem(name: "cursor", value: c)) }
        return try await send(.get("\(Self.base)/search", query: items)).decode()
    }

    /// `GET /search/media?kind=`: photos or links of about the last 90 days, newest first.
    public func searchMedia(kind: CommsMediaKind, query: String? = nil, threadID: String? = nil, cursor: String? = nil, limit: Int = 60) async throws -> CommsMediaPage {
        var items = [URLQueryItem(name: "kind", value: kind.rawValue), URLQueryItem(name: "limit", value: String(min(100, max(1, limit))))]
        if let q = query?.trimmingCharacters(in: .whitespacesAndNewlines), !q.isEmpty { items.append(URLQueryItem(name: "q", value: String(q.prefix(200)))) }
        if let t = threadID { items.append(URLQueryItem(name: "thread", value: try Self.segment(t))) }
        if let c = cursor, !c.isEmpty { items.append(URLQueryItem(name: "cursor", value: c)) }
        return try await send(.get("\(Self.base)/search/media", query: items)).decode()
    }

    // MARK: Contact tidy-up (Task 4, D17)

    /// `GET /tidy`: People to tidy, most talked-to first.
    public func tidyList(cursor: String? = nil, limit: Int = 30) async throws -> CommsTidyPage {
        var items = [URLQueryItem(name: "limit", value: String(min(50, max(1, limit))))]
        if let c = cursor, !c.isEmpty { items.append(URLQueryItem(name: "cursor", value: c)) }
        return try await send(.get("\(Self.base)/tidy", query: items)).decode()
    }

    /// `GET /tidy/threads/:id`: the "Who is this?" prompt for a DM, nil when nothing is needed.
    public func tidyItem(threadID: String) async throws -> CommsTidyItem? {
        struct Answer: Decodable { var needed: Bool; var item: CommsTidyItem? }
        let a: Answer = try await send(.get("\(Self.base)/tidy/threads/\(try Self.segment(threadID))")).decode()
        return a.needed ? a.item : nil
    }

    /// Link the DM's counterpart to an existing person (writes their handle onto the person note).
    public func tidyLink(threadID: String, personID: String) async throws -> CommsTidyResult {
        struct Body: Encodable { var threadId: String; var personId: String }
        return try await tidyPost("link", Body(threadId: threadID, personId: personID))
    }

    /// Create a person for the DM's counterpart. `allowSimilar` = create although people with
    /// that name exist (each is filed as a "same person?" suggestion in Prism, never merged).
    public func tidyCreate(threadID: String, name: String, allowSimilar: Bool = false) async throws -> CommsTidyResult {
        struct Body: Encodable { var threadId: String; var name: String; var allowSimilar: Bool }
        return try await tidyPost("create", Body(threadId: threadID, name: name, allowSimilar: allowSimilar))
    }

    /// Never ask about this counterpart again (nothing is written to the vault).
    public func tidyIgnore(threadID: String) async throws -> CommsTidyResult {
        struct Body: Encodable { var threadId: String }
        return try await tidyPost("ignore", Body(threadId: threadID))
    }

    /// Undo a link / create / ignore (refused with ``CommsTidyRefusal/changedSince`` when the
    /// person note was edited meanwhile).
    public func tidyUndo(actionID: String) async throws -> CommsTidyResult {
        struct Body: Encodable { var actionId: String }
        return try await tidyPost("undo", Body(actionId: actionID))
    }

    private func tidyPost<B: Encodable>(_ op: String, _ body: B) async throws -> CommsTidyResult {
        let r = try await client.sendRaw(try PrismRequest.json("POST", "\(Self.base)/tidy/\(op)", body: body))
        guard r.isSuccess else { throw Self.mapTidy(PrismClient.error(for: r)) }
        return try r.decode()
    }

    /// 409/422/404 refusals of the tidy routes → ``CommsTidyRefusal``; anything else as ``map(_:)``.
    static func mapTidy(_ error: any Error) -> any Error {
        guard let e = error as? PrismError else { return error }
        let body: Data?
        switch e {
        case .forbidden(let f), .conflict(let f), .rejected(let f): body = f.body
        default: return map(e)
        }
        let obj = body.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]
        func person(_ p: [String: Any]?) -> CommsTidyItem.Suggestion? {
            guard let p, let id = p["id"] as? String, let name = p["name"] as? String else { return nil }
            return CommsTidyItem.Suggestion(personId: id, name: name, reason: "same-name")
        }
        switch (e.httpStatus, e.serverCode) {
        case (409, "similar_people"):
            return CommsTidyRefusal.similarPeople(((obj?["people"] as? [[String: Any]]) ?? []).compactMap(person))
        case (409, "claimed_by_another_person"):
            if let p = person(obj?["person"] as? [String: Any]) { return CommsTidyRefusal.claimedByAnotherPerson(CommsTidyItem.Suggestion(personId: p.personId, name: p.name, reason: "same-handle")) }
            return CommsTidyRefusal.other("claimed_by_another_person")
        case (409, "changed_since"): return CommsTidyRefusal.changedSince
        case (409, "already_undone"), (409, "already_linked"): return CommsTidyRefusal.alreadyDone
        case (422, "invalid_name"): return CommsTidyRefusal.invalidName
        case (404, "tidy_disabled"): return CommsTidyRefusal.disabled
        case (_, let code?): return [409, 422].contains(e.httpStatus ?? 0) ? CommsTidyRefusal.other(code) : map(e)
        default: return map(e)
        }
    }

    // MARK: Omni in Comms (Phase 4)

    /// `GET /threads/:id/omni`: drafts, "drafting", and Omni's last private answer for one
    /// conversation. Throws ``CommsOmniError``.
    public func omni(threadID: String) async throws -> CommsOmniState {
        try await omniCall(.get("\(Self.base)/threads/\(try Self.segment(threadID))/omni"))
    }

    /// `@Omni`: a private instruction about this conversation (`messageIDs` = the messages the owner
    /// pointed at, "Ask Omni about this"). Omni answers privately and may PROPOSE a draft; nothing
    /// is sent. One key per press; resend the same key after an unclear outcome.
    /// `topic`: a forum's topic on screen (the draft is bound to it unless the selected messages name one).
    public func assist(threadID: String, instruction: String, messageIDs: [String] = [], topic: String? = nil, idempotencyKey: IdempotencyKey = .random()) async throws -> CommsOmniStart {
        let text = instruction.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, text.count <= Self.maxInstruction else { throw CommsOmniError.invalid("Ask Omni with 1–\(Self.maxInstruction) characters.") }
        struct Body: Encodable { var instruction: String; var messageIds: [String]?; var topic: String? }
        let ids = Array(messageIDs.prefix(20))
        for id in ids { _ = try Self.messageSegment(id) }
        let path = "\(Self.base)/threads/\(try Self.segment(threadID))/assist"
        return try await omniCall(try .json("POST", path, body: Body(instruction: text, messageIds: ids.isEmpty ? nil : ids, topic: topic), idempotencyKey: idempotencyKey))
    }

    /// "Catch me up": a private summary of the conversation (never sent, never a draft).
    public func catchUp(threadID: String, idempotencyKey: IdempotencyKey = .random()) async throws -> CommsOmniStart {
        struct Empty: Encodable {}
        let path = "\(Self.base)/threads/\(try Self.segment(threadID))/catch-up"
        return try await omniCall(try .json("POST", path, body: Empty(), idempotencyKey: idempotencyKey))
    }

    /// The owner closed Omni's note for `turnID`: it stays closed on every device
    /// (`POST /threads/:id/omni/dismiss`). Throws ``CommsOmniError``.
    public func dismissOmniNote(threadID: String, turnID: String) async throws {
        struct Body: Encodable { var turnId: String }
        struct Ok: Decodable { var ok: Bool }
        let path = "\(Self.base)/threads/\(try Self.segment(threadID))/omni/dismiss"
        let _: Ok = try await omniCall(try .json("POST", path, body: Body(turnId: turnID)))
    }

    static let maxInstruction = 4_000

    private func omniCall<T: Decodable>(_ request: PrismRequest) async throws -> T {
        let r = try await client.sendRaw(request)
        guard r.isSuccess else { throw Self.mapOmni(PrismClient.error(for: r)) }
        do { return try r.decode(T.self) } catch { throw CommsOmniError.unavailable }
    }

    /// 404 `omni_disabled` · 409 `busy` · 403 `device_required` · 429 · 502 `omni_unavailable`.
    static func mapOmni(_ error: any Error) -> any Error {
        guard let e = error as? PrismError else { return error }
        let body: Data?
        switch e {
        case .forbidden(let f), .conflict(let f), .rejected(let f): body = f.body
        case .outcomeUnknown(let u): body = u.body
        default: return e
        }
        let obj = body.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]
        switch (e.httpStatus, e.serverCode) {
        case (404, "omni_disabled"), (404, "comms_disabled"): return CommsOmniError.disabled
        case (404, _): return CommsError.threadUnavailable
        case (409, "busy"): return CommsOmniError.busy(turnID: obj?["turnId"] as? String)
        case (403, "device_required"): return CommsOmniError.deviceRequired
        case (403, "client_scope"): return CommsError.clientScope
        case (429, _): return CommsOmniError.rateLimited
        case (422, _), (400, _): return CommsOmniError.invalid((obj?["message"] as? String).map { String($0.prefix(300)) } ?? "Omni couldn't take that.")
        default: return CommsOmniError.unavailable
        }
    }

    // MARK: Plumbing

    /// Send, mapping the contract's named failures; anything else is the transport's error.
    private func send(_ request: PrismRequest) async throws -> PrismResponse {
        let r = try await client.sendRaw(request)
        guard r.isSuccess else { throw Self.map(PrismClient.error(for: r)) }
        return r
    }

    /// 503 `source_unavailable` · 404 `thread_unavailable` · 410 · 403 `client_scope`.
    static func map(_ error: any Error) -> any Error {
        guard let e = error as? PrismError else { return error }
        let body: Data?
        switch e {
        case .forbidden(let f), .conflict(let f), .rejected(let f): body = f.body
        case .outcomeUnknown(let u): body = u.body
        default: return e
        }
        switch (e.httpStatus, e.serverCode) {
        case (503, "source_unavailable"):
            let name = (body.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any])?["network"] as? String
            // No network named: `.unknown("")`, never an invented one.
            return CommsError.sourceUnavailable(network: CommsNetwork(wire: name ?? ""))
        case (404, "thread_unavailable"): return CommsError.threadUnavailable
        case (404, "person_unavailable"): return CommsError.personUnavailable
        case (409, "pin_limit"): return CommsError.pinLimit
        case (409, "pins_changed"): return CommsError.pinsChanged
        case (404, "pins_disabled"): return CommsError.pinsDisabled
        case (404, "thread_actions_disabled"): return CommsError.threadActionsDisabled
        case (404, "folders_disabled"): return CommsError.foldersDisabled
        case (404, "folder_unavailable"): return CommsError.folderUnavailable
        case (409, "folder_exists"): return CommsError.folderExists
        case (409, "folder_limit"): return CommsError.folderLimit
        case (409, "folders_changed"): return CommsError.foldersChanged
        case (409, "no_note"): return CommsError.noStatusNote
        case (409, "status_changed"): return CommsError.statusChanged
        case (409, "already_undone"), (404, "undo_unavailable"): return CommsError.undoUnavailable
        case (410, _): return CommsError.mediaExpired
        case (403, "client_scope"): return CommsError.clientScope
        default: return e
        }
    }

    /// A path segment: an id/token only, never a path.
    static func segment(_ id: String) throws -> String {
        let n = id.utf8.count
        guard n >= 1, n <= 2048, id != ".", id != "..", id.utf8.allSatisfy({ c in
            (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) || c == 0x5F || c == 0x2E || c == 0x3A || c == 0x2D
        }) else { throw PrismError.invalidRequest("id refused") }
        return id
    }
}

/// A `multipart/form-data` body (RFC 7578) with a random boundary.
struct MultipartForm {
    let boundary = "CommsBoundary-" + UUID().uuidString
    private(set) var data = Data()

    var contentType: String { "multipart/form-data; boundary=\(boundary)" }

    mutating func field(_ name: String, _ value: String) {
        data.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n".utf8))
    }

    /// The file part's header (the fields so far, then the part's headers); `tail` closes it.
    func fileHeader(_ name: String, filename: String, mime: String) -> Data {
        data + Data("--\(boundary)\r\nContent-Disposition: \(Self.disposition(name, filename: filename))\r\nContent-Type: \(mime)\r\n\r\n".utf8)
    }

    /// The file part's Content-Disposition as browsers write it (WHATWG HTML "multipart/form-data
    /// encoding"): the name in raw UTF-8 with `"`, CR and LF percent-escaped. NOT RFC 5987
    /// `filename*=` — the server's parser (undici) refuses a whole body that carries one, which
    /// failed every upload with a non-ASCII name (a screenshot's U+202F, "Café", 照片…).
    static func disposition(_ name: String, filename: String) -> String {
        let escaped = filename.replacingOccurrences(of: "\"", with: "%22").replacingOccurrences(of: "\r", with: "%0D").replacingOccurrences(of: "\n", with: "%0A")
        return "form-data; name=\"\(name)\"; filename=\"\(escaped)\""
    }

    var tail: Data { Data("\r\n--\(boundary)--\r\n".utf8) }

    /// head + the source file (copied in 1 MB chunks) + tail, into `url`.
    static func writeFile(to url: URL, head: Data, source: URL, tail: Data) throws {
        guard FileManager.default.createFile(atPath: url.path, contents: head) else { throw CocoaError(.fileWriteUnknown) }
        let out = try FileHandle(forWritingTo: url)
        defer { try? out.close() }
        try out.seekToEnd()
        let input = try FileHandle(forReadingFrom: source)
        defer { try? input.close() }
        while let chunk = try input.read(upToCount: 1 << 20), !chunk.isEmpty { try out.write(contentsOf: chunk) }
        try out.write(contentsOf: tail)
    }

    mutating func file(_ name: String, filename: String, mime: String, data bytes: Data) {
        data.append(Data("--\(boundary)\r\nContent-Disposition: \(Self.disposition(name, filename: filename))\r\nContent-Type: \(mime)\r\n\r\n".utf8))
        data.append(bytes)
        data.append(Data("\r\n".utf8))
    }

    mutating func finish() -> Data {
        data.append(Data("--\(boundary)--\r\n".utf8))
        return data
    }
}
