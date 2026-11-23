import Foundation

// Task 4 (sprint to finish): full message search, Photos/Links, and contact tidy-up.
// Server: apps/server/src/routes/comms-search.ts (contract in the Task 4 report).

// MARK: Search

/// A highlighted run of a result's `text`, in UTF-16 code units (what `NSRange` counts).
public struct CommsTextRange: Codable, Hashable, Sendable {
    public var start: Int
    public var length: Int

    public init(start: Int, length: Int) {
        self.start = start
        self.length = length
    }
}

/// One message that matched: the snippet (≤ ~32 words around the hit) with highlight ranges.
public struct CommsSearchHit: Codable, Hashable, Sendable, Identifiable {
    public struct Sender: Codable, Hashable, Sendable {
        public var name: String
        public var isSelf: Bool

        public init(name: String, isSelf: Bool) {
            self.name = name
            self.isSelf = isSelf
        }
    }
    /// `live` = a projected message (has `messageId`); `history` = a vault transcript line.
    public enum Origin: String, Codable, Sendable { case live, history }

    public var id: String
    public var threadId: String
    public var messageId: String?
    public var sentAt: Date
    public var sender: Sender
    public var text: String
    public var highlights: [CommsTextRange]
    public var origin: Origin

    public init(id: String, threadId: String, messageId: String? = nil, sentAt: Date, sender: Sender, text: String, highlights: [CommsTextRange] = [], origin: Origin = .live) {
        self.id = id
        self.threadId = threadId
        self.messageId = messageId
        self.sentAt = sentAt
        self.sender = sender
        self.text = text
        self.highlights = highlights
        self.origin = origin
    }

    private enum CodingKeys: String, CodingKey { case id, threadId, messageId, sentAt, sender, text, highlights, origin }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        threadId = try c.decode(String.self, forKey: .threadId)
        messageId = try c.decodeIfPresent(String.self, forKey: .messageId)
        sentAt = try c.decode(Date.self, forKey: .sentAt)
        sender = try c.decode(Sender.self, forKey: .sender)
        text = try c.decode(String.self, forKey: .text)
        // Ranges outside the text are dropped (never trusted to index a string).
        let n = (text as NSString).length
        highlights = ((try? c.decodeIfPresent([CommsTextRange].self, forKey: .highlights)) ?? [])
            .filter { $0.start >= 0 && $0.length > 0 && $0.start + $0.length <= n }
        origin = (try? c.decodeIfPresent(Origin.self, forKey: .origin)) ?? .live
    }
}

/// How far the server's history index has come (vault transcripts).
public struct CommsSearchHistory: Codable, Hashable, Sendable {
    public var sources: Int
    public var pending: Int
    public var failed: Int
    public var messages: Int

    public init(sources: Int = 0, pending: Int = 0, failed: Int = 0, messages: Int = 0) {
        self.sources = sources
        self.pending = pending
        self.failed = failed
        self.messages = messages
    }
}

/// `GET /api/comms/search`.
public struct CommsSearchResults: Codable, Hashable, Sendable {
    public var query: String
    public var messages: [CommsSearchHit]
    /// The threads the hits belong to (title, avatar, network for the result headers).
    public var threads: [CommsThread]
    /// Conversations matching the text (first page only): the "Messages with" / "in" tokens.
    public var suggestions: [CommsThread]?
    public var history: CommsSearchHistory?
    public var next: String?
    /// The server ranked only the newest matches (a per-request bound): older ones may be missing.
    public var partial: Bool

    public init(query: String, messages: [CommsSearchHit] = [], threads: [CommsThread] = [], suggestions: [CommsThread]? = nil, history: CommsSearchHistory? = nil, next: String? = nil, partial: Bool = false) {
        self.partial = partial
        self.query = query
        self.messages = messages
        self.threads = threads
        self.suggestions = suggestions
        self.history = history
        self.next = next
    }

    private enum CodingKeys: String, CodingKey { case query, messages, threads, suggestions, history, next, partial }
    private struct Suggestions: Decodable { var threads: CommsLossyList<CommsThread>? }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        query = (try? c.decodeIfPresent(String.self, forKey: .query)) ?? ""
        messages = (try? c.decodeIfPresent(CommsLossyList<CommsSearchHit>.self, forKey: .messages))?.elements ?? []
        threads = (try? c.decodeIfPresent(CommsLossyList<CommsThread>.self, forKey: .threads))?.elements ?? []
        suggestions = (try? c.decodeIfPresent(Suggestions.self, forKey: .suggestions))?.threads?.elements
        history = try? c.decodeIfPresent(CommsSearchHistory.self, forKey: .history)
        next = try? c.decodeIfPresent(String.self, forKey: .next)
        partial = (try? c.decodeIfPresent(Bool.self, forKey: .partial)) ?? false
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(query, forKey: .query)
        try c.encode(messages, forKey: .messages)
        try c.encode(threads, forKey: .threads)
        if let suggestions { try c.encode(["threads": suggestions], forKey: .suggestions) }
        try c.encodeIfPresent(history, forKey: .history)
        try c.encodeIfPresent(next, forKey: .next)
        if partial { try c.encode(true, forKey: .partial) }
    }
}

/// What a message search is narrowed to (the search field's tokens).
public struct CommsSearchFilter: Sendable, Hashable {
    public var threadId: String?
    public var personId: String?
    public var networks: [CommsNetwork]
    /// true = only the owner's messages, false = only others', nil = both.
    public var fromSelf: Bool?

    public init(threadId: String? = nil, personId: String? = nil, networks: [CommsNetwork] = [], fromSelf: Bool? = nil) {
        self.threadId = threadId
        self.personId = personId
        self.networks = networks
        self.fromSelf = fromSelf
    }
}

/// The Photos / Links tabs (about the last 90 days).
public enum CommsMediaKind: String, Sendable { case photos, links }

public struct CommsMediaItem: Codable, Hashable, Sendable, Identifiable {
    public struct Link: Codable, Hashable, Sendable {
        public var url: String
        public var title: String?
        public var siteName: String?
        public var imageToken: String?

        public init(url: String, title: String? = nil, siteName: String? = nil, imageToken: String? = nil) {
            self.url = url
            self.title = title
            self.siteName = siteName
            self.imageToken = imageToken
        }
    }
    public var id: String
    public var threadId: String
    public var messageId: String
    public var sentAt: Date
    public var sender: CommsSearchHit.Sender
    public var attachment: CommsAttachment?
    public var link: Link?

    public init(id: String, threadId: String, messageId: String, sentAt: Date, sender: CommsSearchHit.Sender, attachment: CommsAttachment? = nil, link: Link? = nil) {
        self.id = id
        self.threadId = threadId
        self.messageId = messageId
        self.sentAt = sentAt
        self.sender = sender
        self.attachment = attachment
        self.link = link
    }
}

public struct CommsMediaPage: Codable, Hashable, Sendable {
    public var items: [CommsMediaItem]
    public var next: String?

    public init(items: [CommsMediaItem] = [], next: String? = nil) {
        self.items = items
        self.next = next
    }

    private enum CodingKeys: String, CodingKey { case items, next }
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        items = (try? c.decodeIfPresent(CommsLossyList<CommsMediaItem>.self, forKey: .items))?.elements ?? []
        next = try? c.decodeIfPresent(String.self, forKey: .next)
    }
}

// MARK: Contact tidy-up (D17)

/// A DM counterpart with no person note yet ("Who is this?" / "People to tidy").
public struct CommsTidyItem: Codable, Hashable, Sendable, Identifiable {
    public struct Handle: Codable, Hashable, Sendable {
        /// phone · email · username · userId · matrix
        public var kind: String
        public var value: String

        public init(kind: String, value: String) {
            self.kind = kind
            self.value = value
        }
    }
    public struct Suggestion: Codable, Hashable, Sendable, Identifiable {
        public var personId: String
        public var name: String
        /// `same-handle` (that person already has this number / id) or `same-name`.
        public var reason: String
        public var id: String { personId }

        public init(personId: String, name: String, reason: String) {
            self.personId = personId
            self.name = name
            self.reason = reason
        }
    }
    public var threadId: String
    public var network: CommsNetwork
    public var name: String
    public var avatar: CommsAvatar?
    public var handle: Handle?
    public var messageCount: Int
    public var lastActivityAt: Date
    public var suggestions: [Suggestion]
    public var id: String { threadId }

    public init(threadId: String, network: CommsNetwork, name: String, avatar: CommsAvatar? = nil, handle: Handle? = nil, messageCount: Int = 0, lastActivityAt: Date, suggestions: [Suggestion] = []) {
        self.threadId = threadId
        self.network = network
        self.name = name
        self.avatar = avatar
        self.handle = handle
        self.messageCount = messageCount
        self.lastActivityAt = lastActivityAt
        self.suggestions = suggestions
    }
}

public struct CommsTidyPage: Codable, Hashable, Sendable {
    public var people: [CommsTidyItem]
    public var total: Int
    public var next: String?

    public init(people: [CommsTidyItem] = [], total: Int = 0, next: String? = nil) {
        self.people = people
        self.total = total
        self.next = next
    }

    private enum CodingKeys: String, CodingKey { case people, total, next }
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        people = (try? c.decodeIfPresent(CommsLossyList<CommsTidyItem>.self, forKey: .people))?.elements ?? []
        total = (try? c.decodeIfPresent(Int.self, forKey: .total)) ?? people.count
        next = try? c.decodeIfPresent(String.self, forKey: .next)
    }
}

/// A recorded tidy action (what Undo takes).
public struct CommsTidyAction: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    /// link · create · ignore
    public var kind: String
    public var threadId: String
    public var personId: String?
    public var personName: String?
    public var undone: Bool

    public init(id: String, kind: String, threadId: String, personId: String? = nil, personName: String? = nil, undone: Bool = false) {
        self.id = id
        self.kind = kind
        self.threadId = threadId
        self.personId = personId
        self.personName = personName
        self.undone = undone
    }
}

public struct CommsTidyResult: Codable, Hashable, Sendable {
    public var action: CommsTidyAction
    public var thread: CommsThread?

    public init(action: CommsTidyAction, thread: CommsThread? = nil) {
        self.action = action
        self.thread = thread
    }
}

/// Why a tidy action was refused, in words the UI can act on.
public enum CommsTidyRefusal: Error, Hashable, Sendable {
    /// People with that name exist: link to one, or create anyway (`allowSimilar`).
    case similarPeople([CommsTidyItem.Suggestion])
    /// That number / id already belongs to someone.
    case claimedByAnotherPerson(CommsTidyItem.Suggestion)
    /// The person note changed since; undo would overwrite it.
    case changedSince
    case alreadyDone
    case invalidName
    case disabled
    case other(String)
}
