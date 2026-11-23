import Foundation

// Phase 2b: the new-message sheet's "To:" field and starting an iMessage/SMS conversation
// (server-2b-report.md §1–2).

/// `GET /api/comms/recipients?q=&limit=`: people and existing conversations matching what
/// was typed in the To: field, and the typed text itself when it is a sendable address.
public struct CommsRecipients: Codable, Hashable, Sendable {
    public var query: String
    /// The query as a sendable address (`+…` phone → E.164, or an email); nil otherwise.
    public var handle: CommsRecipientHandle?
    public var people: [CommsRecipient]
    /// Existing conversations (any network, any folder), newest first.
    public var threads: [CommsThread]
    /// The people directory could not be loaded in time (threads were still searched).
    public var partial: Bool

    private enum CodingKeys: String, CodingKey { case query, handle, people, threads, partial }

    public init(query: String, handle: CommsRecipientHandle? = nil, people: [CommsRecipient] = [], threads: [CommsThread] = [], partial: Bool = false) {
        self.query = query
        self.handle = handle
        self.people = people
        self.threads = threads
        self.partial = partial
    }

    /// Lenient: a person or thread that does not decode is skipped, not fatal.
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        query = (try? c.decodeIfPresent(String.self, forKey: .query)) ?? ""
        handle = try? c.decodeIfPresent(CommsRecipientHandle.self, forKey: .handle)
        people = (try? c.decodeIfPresent(CommsLossyList<CommsRecipient>.self, forKey: .people))?.elements ?? []
        threads = (try? c.decodeIfPresent(CommsLossyList<CommsThread>.self, forKey: .threads))?.elements ?? []
        partial = (try? c.decodeIfPresent(Bool.self, forKey: .partial)) ?? false
    }
}

/// The To: text as an address the server can start a conversation with.
public struct CommsRecipientHandle: Codable, Hashable, Sendable {
    public enum Kind: String, Codable, Sendable { case phone, email }
    public var kind: Kind
    /// E.164 for a phone, lowercased for an email.
    public var value: String
    /// An existing iMessage/SMS one-to-one conversation with this address.
    public var threadId: String?

    public init(kind: Kind, value: String, threadId: String? = nil) {
        self.kind = kind
        self.value = value
        self.threadId = threadId
    }
}

/// One person (a vault person note, or a Mac Contacts entry) the To: field suggests.
public struct CommsRecipient: Codable, Hashable, Sendable, Identifiable {
    /// Stable for a session: `p_<personId>` or `c_<hex>` (Contacts only).
    public var id: String
    public var personId: String?
    public var name: String
    public var avatar: CommsAvatar?
    public var phones: [Address]
    public var emails: [Address]
    /// `"person"` or `"contact"`.
    public var source: String?

    public struct Address: Codable, Hashable, Sendable {
        public var value: String
        /// An existing iMessage/SMS one-to-one conversation with this address.
        public var threadId: String?

        public init(value: String, threadId: String? = nil) {
            self.value = value
            self.threadId = threadId
        }
    }

    private enum CodingKeys: String, CodingKey { case id, personId, name, avatar, phones, emails, source }

    public init(id: String, personId: String? = nil, name: String, avatar: CommsAvatar? = nil, phones: [Address] = [], emails: [Address] = [], source: String? = nil) {
        self.id = id
        self.personId = personId
        self.name = name
        self.avatar = avatar
        self.phones = phones
        self.emails = emails
        self.source = source
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        personId = try? c.decodeIfPresent(String.self, forKey: .personId)
        avatar = try? c.decodeIfPresent(CommsAvatar.self, forKey: .avatar)
        phones = (try? c.decodeIfPresent(CommsLossyList<Address>.self, forKey: .phones))?.elements ?? []
        emails = (try? c.decodeIfPresent(CommsLossyList<Address>.self, forKey: .emails))?.elements ?? []
        source = try? c.decodeIfPresent(String.self, forKey: .source)
    }
}

/// `POST /api/comms/conversations` answered 200: the conversation already existed (nothing
/// was sent: open it and send there), or it was started with the message.
public struct CommsNewConversation: Codable, Hashable, Sendable {
    /// An existing conversation with that address: NOTHING was sent.
    public var existing: Bool
    public var threadId: String
    /// The thread when the server has it (absent while `pending`).
    public var thread: CommsThread?
    public var clientId: String?
    /// The sent message's event id (its echo's `source.eventId`).
    public var eventId: String?
    public var status: String?
    /// The chat was not projected yet: `threadId` is the id it WILL have (a `thread.updated`
    /// on the stream announces it; `GET /threads/{id}` is 404 until then).
    public var pending: Bool
    /// The address as the server normalised it (`{kind, value}`; additive, may be absent).
    public var handle: CommsRecipientHandle?

    private enum CodingKeys: String, CodingKey { case existing, threadId, thread, clientId, eventId, status, pending, handle }

    public init(existing: Bool, threadId: String, thread: CommsThread? = nil, clientId: String? = nil, eventId: String? = nil, status: String? = nil, pending: Bool = false, handle: CommsRecipientHandle? = nil) {
        self.existing = existing
        self.threadId = threadId
        self.thread = thread
        self.clientId = clientId
        self.eventId = eventId
        self.status = status
        self.pending = pending
        self.handle = handle
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        existing = (try? c.decodeIfPresent(Bool.self, forKey: .existing)) ?? false
        threadId = try c.decode(String.self, forKey: .threadId)
        // A thread that does not decode is dropped: the id is what matters.
        thread = try? c.decodeIfPresent(CommsThread.self, forKey: .thread)
        clientId = try? c.decodeIfPresent(String.self, forKey: .clientId)
        eventId = try? c.decodeIfPresent(String.self, forKey: .eventId)
        status = try? c.decodeIfPresent(String.self, forKey: .status)
        pending = (try? c.decodeIfPresent(Bool.self, forKey: .pending)) ?? false
        handle = try? c.decodeIfPresent(CommsRecipientHandle.self, forKey: .handle)
    }
}
