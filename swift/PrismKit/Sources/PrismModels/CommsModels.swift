import Foundation

// Swift mirrors of the Comms wire model (`apps/server/src/comms/types.ts`,
// `richtext.ts`, `room-meta.ts`) exactly as `/api/comms/*` answers it: media references
// are already `token`s (the server rewrites `mxc`). Every name carries a `Comms` prefix
// so it cannot clash with Foundation's `Thread` or the Omni models (`ThreadDetail`, …).
//
// Every enum the server owns has an `unknown(String)` case: a value added on the server
// later decodes as `.unknown` and round-trips unchanged instead of failing the page.

/// A server string enum that tolerates values it does not know.
public protocol CommsWireEnum: Codable, Hashable, Sendable {
    init(wire: String)
    var wire: String { get }
}

extension CommsWireEnum {
    public init(from decoder: any Decoder) throws {
        self.init(wire: try decoder.singleValueContainer().decode(String.self))
    }
    public func encode(to encoder: any Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(wire)
    }
}

public enum CommsNetwork: CommsWireEnum {
    case whatsapp, telegram, discord, messenger, x, imessage, sms, email, matrix
    case instagram, linkedin
    case unknown(String)

    public init(wire: String) {
        switch wire {
        case "whatsapp": self = .whatsapp
        case "telegram": self = .telegram
        case "discord": self = .discord
        case "messenger": self = .messenger
        case "x": self = .x
        case "imessage": self = .imessage
        case "sms": self = .sms
        case "email": self = .email
        case "matrix": self = .matrix
        case "instagram": self = .instagram
        case "linkedin": self = .linkedin
        default: self = .unknown(wire)
        }
    }
    public var wire: String {
        switch self {
        case .whatsapp: return "whatsapp"
        case .telegram: return "telegram"
        case .discord: return "discord"
        case .messenger: return "messenger"
        case .x: return "x"
        case .imessage: return "imessage"
        case .sms: return "sms"
        case .email: return "email"
        case .matrix: return "matrix"
        case .instagram: return "instagram"
        case .linkedin: return "linkedin"
        case .unknown(let s): return s
        }
    }
}

public enum CommsFolder: CommsWireEnum {
    case inbox, low, spam, archived
    /// The server's `unknown` folder (a stranger's first message). Named `strangers`
    /// because `.unknown(String)` is the unrecognised-value case.
    case strangers
    case unknown(String)

    public init(wire: String) {
        switch wire {
        case "inbox": self = .inbox
        case "unknown": self = .strangers
        case "low": self = .low
        case "spam": self = .spam
        case "archived": self = .archived
        default: self = .unknown(wire)
        }
    }
    public var wire: String {
        switch self {
        case .inbox: return "inbox"
        case .strangers: return "unknown"
        case .low: return "low"
        case .spam: return "spam"
        case .archived: return "archived"
        case .unknown(let s): return s
        }
    }
}

public enum CommsTitleSource: CommsWireEnum {
    /// `members`: an unnamed group titled from its members ("Ann, Bob & 3 others").
    case person, room, contact, members, email, handle
    case unknown(String)

    public init(wire: String) {
        switch wire {
        case "person": self = .person
        case "room": self = .room
        case "contact": self = .contact
        case "members": self = .members
        case "email": self = .email
        case "handle": self = .handle
        default: self = .unknown(wire)
        }
    }
    public var wire: String {
        switch self {
        case .person: return "person"
        case .room: return "room"
        case .contact: return "contact"
        case .members: return "members"
        case .email: return "email"
        case .handle: return "handle"
        case .unknown(let s): return s
        }
    }
}

public enum CommsThreadKind: CommsWireEnum {
    case dm, group
    case unknown(String)

    public init(wire: String) {
        switch wire {
        case "dm": self = .dm
        case "group": self = .group
        default: self = .unknown(wire)
        }
    }
    public var wire: String {
        switch self {
        case .dm: return "dm"
        case .group: return "group"
        case .unknown(let s): return s
        }
    }
}

public enum CommsUrgency: CommsWireEnum {
    case urgent, needsReply, fyi, low
    case unknown(String)

    public init(wire: String) {
        switch wire {
        case "urgent": self = .urgent
        case "needs-reply": self = .needsReply
        case "fyi": self = .fyi
        case "low": self = .low
        default: self = .unknown(wire)
        }
    }
    public var wire: String {
        switch self {
        case .urgent: return "urgent"
        case .needsReply: return "needs-reply"
        case .fyi: return "fyi"
        case .low: return "low"
        case .unknown(let s): return s
        }
    }
}

/// A thread's triage status: Prism's ONE classification model
/// (`packages/core/src/lib/messages/triage.ts` `threadStatus(tags)`), derived from the
/// thread's vault note tags. Labels and order are Prism's, verbatim.
public enum CommsThreadStatus: CommsWireEnum {
    case urgent, actionRequired, unclassified, triageFailed, informational, low, social, triaged, handled
    case unknown(String)

    /// Prism's `THREAD_STATUS_ORDER`: what needs you first, then the quiet ones, then the done ones.
    public static let ordered: [CommsThreadStatus] = [.urgent, .actionRequired, .unclassified, .triageFailed, .informational, .low, .social, .triaged, .handled]
    /// Prism's `NEEDS_ATTENTION`: urgent + action required, filtered together as "Needs attention".
    public static let needsAttention: [CommsThreadStatus] = [.urgent, .actionRequired]
    public static let needsAttentionLabel = "Needs attention"

    public init(wire: String) {
        switch wire {
        case "urgent": self = .urgent
        case "action-required": self = .actionRequired
        case "unclassified": self = .unclassified
        case "triage-failed": self = .triageFailed
        case "informational": self = .informational
        case "low": self = .low
        case "social": self = .social
        case "triaged": self = .triaged
        case "handled": self = .handled
        default: self = .unknown(wire)
        }
    }
    public var wire: String {
        switch self {
        case .urgent: return "urgent"
        case .actionRequired: return "action-required"
        case .unclassified: return "unclassified"
        case .triageFailed: return "triage-failed"
        case .informational: return "informational"
        case .low: return "low"
        case .social: return "social"
        case .triaged: return "triaged"
        case .handled: return "handled"
        case .unknown(let s): return s
        }
    }
    /// Prism's `THREAD_STATUS_LABELS` (sentence case).
    public var label: String {
        switch self {
        case .urgent: return "Urgent"
        case .actionRequired: return "Action required"
        case .unclassified: return "Needs triage"
        case .triageFailed: return "Couldn\u{2019}t classify"
        case .informational: return "Informational"
        case .low: return "Low priority"
        case .social: return "Social"
        case .triaged: return "Reviewed"
        case .handled: return "Handled"
        case .unknown(let s): return s
        }
    }
    /// Prism's `needsAttention(status)`.
    public var needsAttention: Bool { Self.needsAttention.contains(self) }
}

public enum CommsAttachmentKind: CommsWireEnum {
    case image, video, audio, voice, file, sticker, location
    case unknown(String)

    public init(wire: String) {
        switch wire {
        case "image": self = .image
        case "video": self = .video
        case "audio": self = .audio
        case "voice": self = .voice
        case "file": self = .file
        case "sticker": self = .sticker
        case "location": self = .location
        default: self = .unknown(wire)
        }
    }
    public var wire: String {
        switch self {
        case .image: return "image"
        case .video: return "video"
        case .audio: return "audio"
        case .voice: return "voice"
        case .file: return "file"
        case .sticker: return "sticker"
        case .location: return "location"
        case .unknown(let s): return s
        }
    }
}

public enum CommsDelivery: CommsWireEnum {
    case pending, sent, delivered, read, failed
    case unknown(String)

    public init(wire: String) {
        switch wire {
        case "pending": self = .pending
        case "sent": self = .sent
        case "delivered": self = .delivered
        case "read": self = .read
        case "failed": self = .failed
        default: self = .unknown(wire)
        }
    }
    public var wire: String {
        switch self {
        case .pending: return "pending"
        case .sent: return "sent"
        case .delivered: return "delivered"
        case .read: return "read"
        case .failed: return "failed"
        case .unknown(let s): return s
        }
    }
}

// MARK: Avatars

/// `{token}` (a media token), `{mxc}` (never on the wire), or `{monogram, members?}`.
public indirect enum CommsAvatar: Codable, Hashable, Sendable {
    case token(String)
    case mxc(String)
    case monogram(String, members: [CommsAvatar])
    /// A shape this client does not know: render a placeholder.
    case unknown

    private enum Keys: String, CodingKey { case token, mxc, monogram, members }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        if let t = try? c.decode(String.self, forKey: .token) { self = .token(t) }
        else if let m = try? c.decode(String.self, forKey: .monogram) {
            self = .monogram(m, members: (try? c.decode([CommsAvatar].self, forKey: .members)) ?? [])
        } else if let x = try? c.decode(String.self, forKey: .mxc) { self = .mxc(x) }
        else { self = .unknown }
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        switch self {
        case .token(let t): try c.encode(t, forKey: .token)
        case .mxc(let x): try c.encode(x, forKey: .mxc)
        case .monogram(let m, let members):
            try c.encode(m, forKey: .monogram)
            if !members.isEmpty { try c.encode(members, forKey: .members) }
        case .unknown: break
        }
    }
}

// MARK: Rich text

/// One portable span. `quote` / `li` hold spans; `unknown` keeps the kind (and the
/// children) of a span a newer server sent. A KNOWN kind with a malformed payload (text
/// without `v`, a link without `href`, …) also decodes as `unknown` — one bad span never
/// fails the message. Children arrays are decoded element-wise: a bad child is dropped.
public indirect enum CommsSpan: Codable, Hashable, Sendable {
    case text(String)
    case bold([CommsSpan])
    case italic([CommsSpan])
    case strike([CommsSpan])
    case code([CommsSpan])
    case pre(String)
    case link(href: String, [CommsSpan])
    case mention(id: String, name: String)
    case quote([CommsSpan])
    case listItem([CommsSpan])
    case br
    /// A kind this client does not know, or a known kind it could not read; render the
    /// children (if any) as plain inline text.
    case unknown(String, children: [CommsSpan] = [])

    private enum Keys: String, CodingKey { case t, v, c, href, id, name }

    public init(from decoder: any Decoder) throws {
        let k = try decoder.container(keyedBy: Keys.self)
        let t = (try? k.decode(String.self, forKey: .t)) ?? ""
        func children() -> [CommsSpan] { (try? k.decodeIfPresent(CommsLossyList<CommsSpan>.self, forKey: .c))?.elements ?? [] }
        do {
            switch t {
            case "text": self = .text(try k.decode(String.self, forKey: .v))
            case "bold": self = .bold(children())
            case "italic": self = .italic(children())
            case "strike": self = .strike(children())
            case "code": self = .code(children())
            case "pre": self = .pre(try k.decode(String.self, forKey: .v))
            case "link": self = .link(href: try k.decode(String.self, forKey: .href), children())
            case "mention": self = .mention(id: try k.decode(String.self, forKey: .id), name: try k.decode(String.self, forKey: .name))
            case "quote": self = .quote(children())
            case "li": self = .listItem(children())
            case "br": self = .br
            default: self = .unknown(t, children: children())
            }
        } catch {
            self = .unknown(t, children: children())
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var k = encoder.container(keyedBy: Keys.self)
        switch self {
        case .text(let v): try k.encode("text", forKey: .t); try k.encode(v, forKey: .v)
        case .bold(let c): try k.encode("bold", forKey: .t); try k.encode(c, forKey: .c)
        case .italic(let c): try k.encode("italic", forKey: .t); try k.encode(c, forKey: .c)
        case .strike(let c): try k.encode("strike", forKey: .t); try k.encode(c, forKey: .c)
        case .code(let c): try k.encode("code", forKey: .t); try k.encode(c, forKey: .c)
        case .pre(let v): try k.encode("pre", forKey: .t); try k.encode(v, forKey: .v)
        case .link(let href, let c): try k.encode("link", forKey: .t); try k.encode(href, forKey: .href); try k.encode(c, forKey: .c)
        case .mention(let id, let name): try k.encode("mention", forKey: .t); try k.encode(id, forKey: .id); try k.encode(name, forKey: .name)
        case .quote(let c): try k.encode("quote", forKey: .t); try k.encode(c, forKey: .c)
        case .listItem(let c): try k.encode("li", forKey: .t); try k.encode(c, forKey: .c)
        case .br: try k.encode("br", forKey: .t)
        case .unknown(let t, let c):
            try k.encode(t, forKey: .t)
            if !c.isEmpty { try k.encode(c, forKey: .c) }
        }
    }
}

/// An array decoded element by element: an element that does not decode is skipped and
/// counted in `dropped` instead of failing the whole array ("no blank screens").
public struct CommsLossyList<Element: Decodable>: Decodable {
    public var elements: [Element]
    public var dropped: Int

    private struct Skip: Decodable { init(from decoder: any Decoder) throws {} }

    public init(from decoder: any Decoder) throws {
        var c = try decoder.unkeyedContainer()
        var out: [Element] = []
        var dropped = 0
        while !c.isAtEnd {
            let before = c.currentIndex
            if let e = try? c.decode(Element.self) {
                out.append(e)
            } else {
                dropped += 1
                if c.currentIndex == before { _ = try? c.decode(Skip.self) }
                if c.currentIndex == before { break } // cannot advance: stop rather than spin
            }
        }
        elements = out
        self.dropped = dropped
    }
}

/// An Int field read leniently: a fractional number is rounded, anything that is not a
/// finite number in Int range (a string, 1e300) reads as nil. Never throws.
func commsLenientInt<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ key: K) -> Int? {
    if let i = try? c.decodeIfPresent(Int.self, forKey: key) { return i }
    guard let d = try? c.decodeIfPresent(Double.self, forKey: key), d.isFinite else { return nil }
    let r = d.rounded()
    return r >= Double(Int.min) && r <= Double(Int.max) ? Int(r) : nil
}

public struct CommsRichText: Codable, Hashable, Sendable {
    public var spans: [CommsSpan]
    /// The same text with no markup (previews, search, copy).
    public var plain: String
    public var jumboEmoji: Bool
    public var truncated: Bool

    public init(spans: [CommsSpan], plain: String, jumboEmoji: Bool = false, truncated: Bool = false) {
        self.spans = spans
        self.plain = plain
        self.jumboEmoji = jumboEmoji
        self.truncated = truncated
    }

    /// Spans decoded element-wise; missing flags read false.
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        spans = (try? c.decodeIfPresent(CommsLossyList<CommsSpan>.self, forKey: .spans))?.elements ?? []
        plain = try c.decodeIfPresent(String.self, forKey: .plain) ?? ""
        jumboEmoji = (try? c.decodeIfPresent(Bool.self, forKey: .jumboEmoji)) ?? false
        truncated = (try? c.decodeIfPresent(Bool.self, forKey: .truncated)) ?? false
    }
}

// MARK: Parts of a message

public struct CommsChannelCapabilities: Codable, Hashable, Sendable {
    public var react, edit, unsend, reply, typing, receipts, attachments: Bool
    /// The owner can send into this channel from Comms (`POST /threads/:id/messages` and
    /// `/attachments`): sending is enabled on the server AND the network is supported.
    public var send: Bool
    /// An end-to-end encrypted room (the server then never declares `send`).
    public var encrypted: Bool
    /// `@Name` mentions can be sent (a bridged network whose bridge turns pills into mentions).
    public var mentions: Bool

    public init(react: Bool = false, edit: Bool = false, unsend: Bool = false, reply: Bool = false, typing: Bool = false, receipts: Bool = false, attachments: Bool = false, send: Bool = false, encrypted: Bool = false, mentions: Bool = false) {
        self.react = react
        self.edit = edit
        self.unsend = unsend
        self.reply = reply
        self.typing = typing
        self.receipts = receipts
        self.attachments = attachments
        self.send = send
        self.encrypted = encrypted
        self.mentions = mentions
    }

    /// A flag the server did not send is off: the UI never offers what is not declared.
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func flag(_ k: CodingKeys) throws -> Bool { try c.decodeIfPresent(Bool.self, forKey: k) ?? false }
        self.init(react: try flag(.react), edit: try flag(.edit), unsend: try flag(.unsend), reply: try flag(.reply), typing: try flag(.typing), receipts: try flag(.receipts), attachments: try flag(.attachments), send: try flag(.send), encrypted: try flag(.encrypted), mentions: try flag(.mentions))
    }
}

/// A send target: one network account a thread can be answered through.
public struct CommsChannelRef: Codable, Hashable, Sendable {
    public var network: CommsNetwork
    /// "Work WhatsApp"; nil = the only account on that network.
    public var accountLabel: String?
    public var capabilities: CommsChannelCapabilities?

    public init(network: CommsNetwork, accountLabel: String? = nil, capabilities: CommsChannelCapabilities? = nil) {
        self.network = network
        self.accountLabel = accountLabel
        self.capabilities = capabilities
    }
}

public struct CommsMessagePreview: Codable, Hashable, Sendable {
    public var text: String
    /// Email only: the latest message's subject (shown semibold above the snippet, PRD §5.8).
    public var subject: String?
    public var senderName: String?
    public var isSelf: Bool
    public var sentAt: Date
}

public struct CommsAttachment: Codable, Hashable, Sendable {
    public var kind: CommsAttachmentKind
    public var mime: String?
    public var size: Int?
    public var w: Int?
    public var h: Int?
    public var durationMs: Int?
    public var name: String?
    public var geo: String?
    /// Fetch with ``CommsClient/media(token:)``.
    public var mediaToken: String?
    public var thumbToken: String?

    public init(kind: CommsAttachmentKind, mime: String? = nil, size: Int? = nil, w: Int? = nil, h: Int? = nil, durationMs: Int? = nil, name: String? = nil, geo: String? = nil, mediaToken: String? = nil, thumbToken: String? = nil) {
        self.kind = kind
        self.mime = mime
        self.size = size
        self.w = w
        self.h = h
        self.durationMs = durationMs
        self.name = name
        self.geo = geo
        self.mediaToken = mediaToken
        self.thumbToken = thumbToken
    }

    /// Numbers are read leniently (``commsLenientInt``): a `w` of 1.5 must not fail the page.
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = try c.decode(CommsAttachmentKind.self, forKey: .kind)
        mime = try? c.decodeIfPresent(String.self, forKey: .mime)
        size = commsLenientInt(c, .size)
        w = commsLenientInt(c, .w)
        h = commsLenientInt(c, .h)
        durationMs = commsLenientInt(c, .durationMs)
        name = try? c.decodeIfPresent(String.self, forKey: .name)
        geo = try? c.decodeIfPresent(String.self, forKey: .geo)
        mediaToken = try? c.decodeIfPresent(String.self, forKey: .mediaToken)
        thumbToken = try? c.decodeIfPresent(String.self, forKey: .thumbToken)
    }
}

public struct CommsLinkPreview: Codable, Hashable, Sendable {
    public var url: String
    public var title: String?
    public var description: String?
    public var siteName: String?
    public var imageToken: String?
}

public struct CommsReaction: Codable, Hashable, Sendable {
    public struct Sender: Codable, Hashable, Sendable {
        public var id: String
        public var name: String
        /// The reaction event (what an un-react would redact).
        public var eventId: String?

        public init(id: String, name: String, eventId: String? = nil) {
            self.id = id
            self.name = name
            self.eventId = eventId
        }
    }
    public var key: String
    public var count: Int
    public var mine: Bool
    public var senders: [Sender]

    public init(key: String, count: Int, mine: Bool, senders: [Sender] = []) {
        self.key = key
        self.count = count
        self.mine = mine
        self.senders = senders
    }
}

// MARK: Threads and messages

public struct CommsThread: Codable, Hashable, Sendable, Identifiable {
    public struct Unread: Codable, Hashable, Sendable {
        public var count: Int
        public var trusted: Bool
        public init(count: Int, trusted: Bool) {
            self.count = count
            self.trusted = trusted
        }
    }
    public var id: String
    public var title: String
    public var titleSource: CommsTitleSource
    public var avatar: CommsAvatar?
    public var kind: CommsThreadKind
    public var networks: [CommsNetwork]
    public var personId: String?
    public var lastMessage: CommsMessagePreview?
    public var lastActivityAt: Date
    public var unread: Unread
    public var folder: CommsFolder
    public var urgency: CommsUrgency?
    /// The triage status (Prism's classification). Nil from a server that predates it.
    public var status: CommsThreadStatus?
    public var pinned: Bool
    /// Position in the owner's pinned grid (0 = first), shared by every device. Nil on an
    /// unpinned thread or from a server that predates pins.
    public var pinOrder: Int?
    public var muted: Bool
    public var channels: [CommsChannelRef]
    /// Contact tidy-up: a DM whose counterpart is linked to no person yet ("Who is this?").
    public var needsTidy: Bool?
    /// The vault `message-thread` note it is projected from (the row's Status writes its tags).
    /// Nil for sources without one (iMessage / SMS) or from an older server.
    public var noteId: String?
    /// The owner folders holding this thread (sprint Task 9). Nil = none, or folders are off.
    public var folderIds: [String]?
    /// A Telegram forum: ONE thread whose topics are sub-conversations (the thread detail lists
    /// them; messages carry their topic; a send names one). Nil for every other thread.
    public var forum: Forum?

    public struct Forum: Codable, Hashable, Sendable {
        public var topicCount: Int
        public init(topicCount: Int) { self.topicCount = topicCount }
    }
}

/// A forum topic as a message names it.
public struct CommsTopicRef: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var title: String
    public init(id: String, title: String) {
        self.id = id
        self.title = title
    }
}

/// One topic of a forum thread (`GET /threads/:id` → `topics`, newest activity first).
public struct CommsTopic: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var title: String
    public var lastActivityAt: Date
    public var lastMessage: CommsMessagePreview?
    /// Unread messages in this topic (after the forum's read marker).
    public var unread: Int
    public var capabilities: CommsChannelCapabilities?

    public init(id: String, title: String, lastActivityAt: Date, lastMessage: CommsMessagePreview? = nil, unread: Int = 0, capabilities: CommsChannelCapabilities? = nil) {
        self.id = id
        self.title = title
        self.lastActivityAt = lastActivityAt
        self.lastMessage = lastMessage
        self.unread = unread
        self.capabilities = capabilities
    }

    public var ref: CommsTopicRef { CommsTopicRef(id: id, title: title) }
}

public struct CommsMessage: Codable, Hashable, Sendable, Identifiable {
    public struct Source: Codable, Hashable, Sendable {
        public var network: CommsNetwork
        public var eventId: String
        public var ref: String

        public init(network: CommsNetwork, eventId: String, ref: String) {
            self.network = network
            self.eventId = eventId
            self.ref = ref
        }
    }
    public struct Sender: Codable, Hashable, Sendable {
        public var id: String
        public var name: String
        public var avatar: CommsAvatar?
        public var isSelf: Bool
        public var isOmni: Bool
        public var personId: String?

        public init(id: String, name: String, avatar: CommsAvatar? = nil, isSelf: Bool, isOmni: Bool = false, personId: String? = nil) {
            self.id = id
            self.name = name
            self.avatar = avatar
            self.isSelf = isSelf
            self.isOmni = isOmni
            self.personId = personId
        }
    }
    public struct Email: Codable, Hashable, Sendable {
        public var subject: String
        public var from: String
        public var to: [String]
        public var cc: [String]
        public var quotedCollapsed: Bool
        public var hasHtml: Bool

        public init(subject: String, from: String, to: [String] = [], cc: [String] = [], quotedCollapsed: Bool = false, hasHtml: Bool = false) {
            self.subject = subject
            self.from = from
            self.to = to
            self.cc = cc
            self.quotedCollapsed = quotedCollapsed
            self.hasHtml = hasHtml
        }
    }
    public struct Reply: Codable, Hashable, Sendable {
        public var messageId: String
        public var snippet: String
        public var senderName: String

        public init(messageId: String, snippet: String, senderName: String) {
            self.messageId = messageId
            self.snippet = snippet
            self.senderName = senderName
        }
    }
    public struct System: Codable, Hashable, Sendable {
        public var kind: String
        public var text: String
    }
    /// One person who read the owner's message (group "Read by", DM "Read <time>").
    public struct Reader: Codable, Hashable, Sendable, Identifiable {
        public var id: String
        public var name: String
        public var readAt: Date

        public init(id: String, name: String, readAt: Date) {
            self.id = id
            self.name = name
            self.readAt = readAt
        }
    }

    public var id: String
    public var threadId: String
    public var channel: CommsChannelRef
    public var source: Source
    public var sender: Sender
    public var sentAt: Date
    public var editedAt: Date?
    public var body: CommsRichText?
    public var email: Email?
    public var attachments: [CommsAttachment]
    public var linkPreviews: [CommsLinkPreview]
    public var replyTo: Reply?
    public var threadRoot: String?
    public var replyCount: Int?
    public var reactions: [CommsReaction]
    public var delivery: CommsDelivery?
    public var deliveryError: String?
    /// When the other side read it (delivery `.read`), when the network says.
    public var readAt: Date?
    /// Who has read it (Matrix bridges with read receipts); nil when nobody / unknown.
    public var readBy: [Reader]?
    public var redacted: Bool
    public var system: System?
    /// A Telegram forum message: the topic it was posted in.
    public var topic: CommsTopicRef?
    /// The `clientId` this message was sent with from Comms (the server keeps it 90 days):
    /// the client reconciles its pending bubble by it as well as by `source.eventId`.
    public var clientId: String?

    /// A message built on the client (an outgoing message not yet echoed by the server).
    public init(id: String, threadId: String, channel: CommsChannelRef, source: Source, sender: Sender, sentAt: Date, editedAt: Date? = nil, body: CommsRichText? = nil, email: Email? = nil, attachments: [CommsAttachment] = [], linkPreviews: [CommsLinkPreview] = [], replyTo: Reply? = nil, threadRoot: String? = nil, replyCount: Int? = nil, reactions: [CommsReaction] = [], delivery: CommsDelivery? = nil, deliveryError: String? = nil, readAt: Date? = nil, readBy: [Reader]? = nil, redacted: Bool = false, system: System? = nil, clientId: String? = nil, topic: CommsTopicRef? = nil) {
        self.topic = topic
        self.id = id
        self.threadId = threadId
        self.channel = channel
        self.source = source
        self.sender = sender
        self.sentAt = sentAt
        self.editedAt = editedAt
        self.body = body
        self.email = email
        self.attachments = attachments
        self.linkPreviews = linkPreviews
        self.replyTo = replyTo
        self.threadRoot = threadRoot
        self.replyCount = replyCount
        self.reactions = reactions
        self.delivery = delivery
        self.deliveryError = deliveryError
        self.readAt = readAt
        self.readBy = readBy
        self.redacted = redacted
        self.system = system
        self.clientId = clientId
    }
}

// MARK: Route answers

/// `GET /threads` → `{threads, next}`; `next` is the cursor for the following page.
/// `threads` is decoded element-wise: a thread that does not decode is left out and
/// counted in `dropped` (client-side only, never on the wire).
public struct CommsThreadPage: Codable, Hashable, Sendable {
    public var threads: [CommsThread]
    public var next: String?
    public var dropped: Int = 0

    private enum CodingKeys: String, CodingKey { case threads, next }

    public init(threads: [CommsThread], next: String?, dropped: Int = 0) {
        self.threads = threads
        self.next = next
        self.dropped = dropped
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let list = try c.decode(CommsLossyList<CommsThread>.self, forKey: .threads)
        threads = list.elements
        dropped = list.dropped
        next = try c.decodeIfPresent(String.self, forKey: .next)
    }
}

public struct CommsMember: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var avatar: CommsAvatar?
    /// The vault person the member resolves to (opens their contact card), when known.
    public var personId: String?

    public init(id: String, name: String, avatar: CommsAvatar? = nil, personId: String? = nil) {
        self.id = id
        self.name = name
        self.avatar = avatar
        self.personId = personId
    }
}

/// `GET /threads/:id` → `{thread, capabilities, members, contact?}`. `capabilities` is the
/// first channel's, nil when the thread has none. `contact` (DMs only): how to reach the
/// other person, so calls can be routed without a second request.
/// Email threads: the account the thread arrived at and what a reply would be — the composer
/// shows `reply` or, when the owner chooses Reply All, `replyAll` (To/Cc/Subject) and echoes it on Send; the server refuses a reply whose
/// recipients or subject changed since (409 `target_changed`). `reply` nil = this thread can't be
/// answered from Comms (`replyUnavailable`: `account` = another account, `no_inbound`).
public struct CommsEmailDetail: Codable, Hashable, Sendable {
    public struct Reply: Codable, Hashable, Sendable {
        public var to: [String]
        public var cc: [String]
        public var subject: String
        public init(to: [String], cc: [String] = [], subject: String) {
            self.to = to
            self.cc = cc
            self.subject = subject
        }
    }
    public var account: String?
    /// Reply (Mail's default): the sender (or Reply-To) only.
    public var reply: Reply?
    /// Reply All: plus everyone else on the email's To/Cc (nil when it adds nobody or is too large).
    public var replyAll: Reply?
    public var replyUnavailable: String?
    public init(account: String?, reply: Reply?, replyAll: Reply? = nil, replyUnavailable: String? = nil) {
        self.account = account
        self.reply = reply
        self.replyAll = replyAll
        self.replyUnavailable = replyUnavailable
    }
}

/// "View full email" (`GET /threads/:id/messages/:messageId/original`). `html` is present only
/// when the server holds an HTML part; render it sandboxed (no scripts, no remote loads).
public struct CommsEmailOriginal: Codable, Hashable, Sendable {
    public var subject: String
    public var from: String
    public var to: String
    public var cc: String
    public var date: String
    public var text: String
    public var html: String?
    public init(subject: String, from: String, to: String, cc: String, date: String, text: String, html: String? = nil) {
        self.subject = subject
        self.from = from
        self.to = to
        self.cc = cc
        self.date = date
        self.text = text
        self.html = html
    }
}

public struct CommsThreadDetail: Codable, Hashable, Sendable {
    public var thread: CommsThread
    public var capabilities: CommsChannelCapabilities?
    public var members: [CommsMember]
    public var contact: CommsContact?
    public var email: CommsEmailDetail?
    /// A Telegram forum's topics, newest activity first. Nil for every other thread.
    public var topics: [CommsTopic]?

    private enum CodingKeys: String, CodingKey { case thread, capabilities, members, contact, email, topics }

    public init(thread: CommsThread, capabilities: CommsChannelCapabilities? = nil, members: [CommsMember] = [], contact: CommsContact? = nil, email: CommsEmailDetail? = nil, topics: [CommsTopic]? = nil) {
        self.topics = topics
        self.thread = thread
        self.capabilities = capabilities
        self.members = members
        self.contact = contact
        self.email = email
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        thread = try c.decode(CommsThread.self, forKey: .thread)
        capabilities = try c.decodeIfPresent(CommsChannelCapabilities.self, forKey: .capabilities)
        members = try c.decodeIfPresent(CommsLossyList<CommsMember>.self, forKey: .members)?.elements ?? []
        // A contact block that does not decode is dropped, never the thread.
        contact = (try? c.decodeIfPresent(CommsContact.self, forKey: .contact)) ?? nil
        email = (try? c.decodeIfPresent(CommsEmailDetail.self, forKey: .email)) ?? nil
        topics = try c.decodeIfPresent(CommsLossyList<CommsTopic>.self, forKey: .topics)?.elements
    }
}

// MARK: People

/// A phone number (E.164) or an email address, with the vault's label ("mobile", "work").
public struct CommsContactPoint: Codable, Hashable, Sendable {
    public var label: String?
    public var value: String

    public init(label: String? = nil, value: String) {
        self.label = label
        self.value = value
    }
}

public enum CommsHandleKind: CommsWireEnum {
    case phone, username, userId
    case unknown(String)

    public init(wire: String) {
        switch wire {
        case "phone": self = .phone
        case "username": self = .username
        case "userId": self = .userId
        default: self = .unknown(wire)
        }
    }
    public var wire: String {
        switch self {
        case .phone: return "phone"
        case .username: return "username"
        case .userId: return "userId"
        case .unknown(let s): return s
        }
    }
}

/// The person's identity on one network: a phone (WhatsApp, Signal), a username (Telegram,
/// X) or a network user id (Discord, Slack, Messenger).
public struct CommsHandle: Codable, Hashable, Sendable {
    public var network: CommsNetwork
    public var value: String
    public var kind: CommsHandleKind

    public init(network: CommsNetwork, value: String, kind: CommsHandleKind) {
        self.network = network
        self.value = value
        self.kind = kind
    }
}

/// How to reach someone: phones, emails and network handles. Each list is decoded
/// element-wise (an entry that does not decode is left out); a missing list is empty.
public struct CommsContact: Codable, Hashable, Sendable {
    public var phones: [CommsContactPoint]
    public var emails: [CommsContactPoint]
    public var handles: [CommsHandle]

    private enum CodingKeys: String, CodingKey { case phones, emails, handles }

    public init(phones: [CommsContactPoint] = [], emails: [CommsContactPoint] = [], handles: [CommsHandle] = []) {
        self.phones = phones
        self.emails = emails
        self.handles = handles
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        phones = (try? c.decodeIfPresent(CommsLossyList<CommsContactPoint>.self, forKey: .phones))??.elements ?? []
        emails = (try? c.decodeIfPresent(CommsLossyList<CommsContactPoint>.self, forKey: .emails))??.elements ?? []
        handles = (try? c.decodeIfPresent(CommsLossyList<CommsHandle>.self, forKey: .handles))??.elements ?? []
    }

    public var isEmpty: Bool { phones.isEmpty && emails.isEmpty && handles.isEmpty }
}

/// `GET /people/:id` → a vault person and every projected conversation shared with them
/// (DMs on each network and the groups they are in), newest activity first.
public struct CommsPerson: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var avatar: CommsAvatar?
    public var noteId: String?
    public var contact: CommsContact
    public var threads: [CommsThread]
    /// Threads that did not decode (client-side only, never on the wire).
    public var droppedThreads: Int = 0

    public var phones: [CommsContactPoint] { contact.phones }
    public var emails: [CommsContactPoint] { contact.emails }
    public var handles: [CommsHandle] { contact.handles }

    private enum CodingKeys: String, CodingKey { case id, name, avatar, noteId, phones, emails, handles, threads }

    public init(id: String, name: String, avatar: CommsAvatar? = nil, noteId: String? = nil, contact: CommsContact = CommsContact(), threads: [CommsThread] = []) {
        self.id = id
        self.name = name
        self.avatar = avatar
        self.noteId = noteId
        self.contact = contact
        self.threads = threads
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        avatar = try c.decodeIfPresent(CommsAvatar.self, forKey: .avatar)
        noteId = try c.decodeIfPresent(String.self, forKey: .noteId)
        contact = try CommsContact(from: decoder)
        let list = try c.decodeIfPresent(CommsLossyList<CommsThread>.self, forKey: .threads)
        threads = list?.elements ?? []
        droppedThreads = list?.dropped ?? 0
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(name, forKey: .name)
        try c.encodeIfPresent(avatar, forKey: .avatar)
        try c.encodeIfPresent(noteId, forKey: .noteId)
        try c.encode(contact.phones, forKey: .phones)
        try c.encode(contact.emails, forKey: .emails)
        try c.encode(contact.handles, forKey: .handles)
        try c.encode(threads, forKey: .threads)
    }
}

/// `GET /threads/:id/messages` → newest LAST; pass `before` back for older ones while `hasMore`.
/// `messages` is decoded element-wise: a message that does not decode is left out and
/// counted in `dropped` (client-side only, never on the wire).
public struct CommsMessagePage: Codable, Hashable, Sendable {
    public var messages: [CommsMessage]
    public var before: String?
    public var hasMore: Bool
    public var dropped: Int = 0

    private enum CodingKeys: String, CodingKey { case messages, before, hasMore }

    public init(messages: [CommsMessage], before: String?, hasMore: Bool, dropped: Int = 0) {
        self.messages = messages
        self.before = before
        self.hasMore = hasMore
        self.dropped = dropped
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let list = try c.decode(CommsLossyList<CommsMessage>.self, forKey: .messages)
        messages = list.elements
        dropped = list.dropped
        before = try c.decodeIfPresent(String.self, forKey: .before)
        hasMore = try c.decode(Bool.self, forKey: .hasMore)
    }
}

/// `GET /api/integrations/comms/capabilities`: what the server declares it can do.
public struct CommsCapabilities: Codable, Hashable, Sendable {
    public var integration: String
    public var clientId: String
    public var restricted: Bool
    public var schemaVersions: [Int]
    public var operations: [String]
    public var networks: [CommsNetwork]
    /// Sending (Phase 2). Nil from a server that predates it: read as "cannot send".
    public var send: CommsSendCapabilities?
    /// Omni in Comms (Phase 4). Nil from a server that predates it: read as "off".
    public var omni: CommsOmniCapabilities?

    /// `@Omni`, drafts and Needs you are offered.
    public var omniEnabled: Bool { omni?.enabled ?? false }

    /// Whether the server lets this client send at all (per thread, see
    /// ``CommsChannelCapabilities/send``).
    public var canSend: Bool { send?.enabled ?? false }
}

/// `capabilities.send`: the server's kill switch and the attachment size cap.
public struct CommsSendCapabilities: Codable, Hashable, Sendable {
    public var enabled: Bool
    /// The largest attachment `POST /threads/:id/attachments` accepts, in bytes (0 = none).
    public var maxAttachmentBytes: Int

    public init(enabled: Bool, maxAttachmentBytes: Int) {
        self.enabled = enabled
        self.maxAttachmentBytes = maxAttachmentBytes
    }

    /// Missing fields read as "off" / 0; a fractional size is rounded.
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        enabled = (try? c.decodeIfPresent(Bool.self, forKey: .enabled)) ?? false
        maxAttachmentBytes = max(0, commsLenientInt(c, .maxAttachmentBytes) ?? 0)
    }
}

/// One `@Name` in an outgoing text: the member's id and the UTF-16 range of `text` naming them.
public struct CommsMention: Codable, Hashable, Sendable {
    public var userId: String
    public var start: Int
    public var length: Int

    public init(userId: String, start: Int, length: Int) {
        self.userId = userId
        self.start = start
        self.length = length
    }
}

/// `200 {clientId, eventId, status}` from a send (`status` is `"sent"`).
public struct CommsSendResult: Codable, Hashable, Sendable {
    public var clientId: String
    /// The network event id: the echoed message's `source.eventId`.
    public var eventId: String
    public var status: String

    public init(clientId: String, eventId: String, status: String = "sent") {
        self.clientId = clientId
        self.eventId = eventId
        self.status = status
    }
}

// MARK: Live events

public enum CommsEventKind: CommsWireEnum {
    case threadUpdated, messageCreated, messageUpdated, messageDeleted, reactionChanged
    /// The server cannot replay from the given `Last-Event-ID`: refetch what is on screen.
    case reset
    case unknown(String)

    public init(wire: String) {
        switch wire {
        case "thread.updated": self = .threadUpdated
        case "message.created": self = .messageCreated
        case "message.updated": self = .messageUpdated
        case "message.deleted": self = .messageDeleted
        case "reaction.changed": self = .reactionChanged
        case "reset": self = .reset
        default: self = .unknown(wire)
        }
    }
    public var wire: String {
        switch self {
        case .threadUpdated: return "thread.updated"
        case .messageCreated: return "message.created"
        case .messageUpdated: return "message.updated"
        case .messageDeleted: return "message.deleted"
        case .reactionChanged: return "reaction.changed"
        case .reset: return "reset"
        case .unknown(let s): return s
        }
    }
}

/// One SSE frame of `GET /api/comms/stream` (`id`, `event`, `data`).
public struct CommsEvent: Sendable, Hashable {
    /// The persisted event id (the resume cursor). On `reset` it is the server's newest
    /// event id (resume from there after refetching); nil only if the frame had none.
    public var id: String?
    public var kind: CommsEventKind
    /// The frame's JSON `data`, untouched (`.null` when it was not JSON).
    public var payload: JSONValue

    public init(id: String?, kind: CommsEventKind, payload: JSONValue) {
        self.id = id
        self.kind = kind
        self.payload = payload
    }

    /// `payload.threadId`, when the frame names a thread.
    public var threadID: String? { payload["threadId"]?.stringValue }
    /// A `thread.updated` that names no thread (`threadId: null`, e.g. `reason: "status"`
    /// after a burst of triage changes): refetch the whole thread list.
    public var refreshesThreadList: Bool { kind == .threadUpdated && threadID == nil }
}


// MARK: - Owner folders + row actions (sprint Task 9)

/// One of the owner's folders (`GET /api/comms/folders`): a second grouping over the list,
/// shared by every device. Not ``CommsFolder`` (the system folders: inbox, archived…).
public struct CommsChatFolder: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var position: Int
    public var count: Int

    public init(id: String, name: String, position: Int, count: Int = 0) {
        self.id = id
        self.name = name
        self.position = position
        self.count = count
    }
}

/// `POST /threads/:id/status`: the thread as it now is, and the undo of the write (nil when
/// nothing changed).
public struct CommsStatusChange: Codable, Hashable, Sendable {
    public struct Undo: Codable, Hashable, Sendable {
        public var id: String
        /// The status before the change (what Undo brings back).
        public var status: CommsThreadStatus
        public init(id: String, status: CommsThreadStatus) {
            self.id = id
            self.status = status
        }
    }
    public var thread: CommsThread
    public var undo: Undo?

    public init(thread: CommsThread, undo: Undo?) {
        self.thread = thread
        self.undo = undo
    }
}

extension CommsThreadStatus {
    /// The statuses a person may set (Prism's `TRIAGE_TAGS`), in the Status menu's order.
    public static let settable: [CommsThreadStatus] = [.urgent, .actionRequired, .informational, .low, .social, .triaged, .handled]
}
