import Foundation
import OmniClient

/// Exactly what an approval would send, laid out for reading. Every key of the payload is
/// shown: the ones this build knows get a label, anything else is listed as it is, so a
/// field can never ride along unseen.
public struct ApprovalContent: Equatable, Sendable {
    public struct Field: Equatable, Sendable, Identifiable {
        public let key: String
        public let label: String
        public let value: String
        public var id: String { key }
    }

    /// "Email", "Reply", "Message", …
    public let kindLabel: String
    /// Recipients, subject, times, amounts — the short fields, in reading order.
    public let fields: [Field]
    /// The long text (an email's body, a tweet's text), untruncated.
    public let body: String?
    /// The payload key ``body`` came from.
    public let bodyKey: String?

    /// One line for a list row: "Email to kevin@example.com".
    public var headline: String {
        if let to = fields.first(where: { ["to", "expectTo", "attendees", "roomId"].contains($0.key) }) {
            return "\(kindLabel) to \(to.value)"
        }
        return kindLabel
    }

    public init(_ approval: Approval) {
        self.init(kind: approval.kind, payload: approval.payload)
    }

    public init(kind: ApprovalKind, payload: JSONValue) {
        let spec = Self.spec(for: kind)
        kindLabel = spec.label
        let object = payload.objectValue ?? [:]
        var fields: [Field] = []
        var seen = Set<String>()
        for (key, label) in spec.fields {
            seen.insert(key)
            guard let value = object[key], !value.isNull else { continue }
            let text = Self.text(value)
            fields.append(Field(key: key, label: label, value: Self.timeKeys.contains(key) ? Self.momentText(text) ?? text : text))
        }
        var body: String?
        if let key = spec.body {
            seen.insert(key)
            if let value = object[key], !value.isNull { body = Self.text(value) }
        }
        // Whatever else the payload carries is shown too.
        for key in object.keys.sorted() where !seen.contains(key) {
            fields.append(Field(key: key, label: key, value: Self.text(object[key] ?? .null)))
        }
        if payload.objectValue == nil {
            fields.append(Field(key: "payload", label: "Content", value: Self.text(payload)))
        }
        self.fields = fields
        self.body = body
        self.bodyKey = body == nil ? nil : spec.body
    }

    struct Spec {
        let label: String
        let fields: [(key: String, label: String)]
        let body: String?
    }

    static func spec(for kind: ApprovalKind) -> Spec {
        switch kind {
        case .email:
            return Spec(label: "Email", fields: [("to", "To"), ("cc", "Cc"), ("subject", "Subject")], body: "body")
        case .emailReply:
            return Spec(label: "Reply", fields: [("expectTo", "To"), ("cc", "Cc"), ("noteId", "In reply to")], body: "body")
        case .message:
            return Spec(label: "Message", fields: [("roomId", "Room")], body: "body")
        case .calendarInvite:
            return Spec(label: "Invite", fields: [("title", "Title"), ("start", "Starts"), ("end", "Ends"), ("attendees", "Attendees"), ("location", "Where")], body: "description")
        case .tweet:
            return Spec(label: "Tweet", fields: [], body: "text")
        case .walletProposal:
            return Spec(label: "Wallet proposal", fields: [("to", "To"), ("amount", "Amount"), ("token", "Token"), ("chain", "Chain")], body: "purpose")
        default:
            let words = kind.rawValue.replacingOccurrences(of: "-", with: " ")
            return Spec(label: words.prefix(1).uppercased() + words.dropFirst(), fields: [], body: nil)
        }
    }

    /// The payload keys this build gives a label to, for a kind.
    public static func shownKeys(for kind: ApprovalKind) -> [String] {
        let spec = spec(for: kind)
        return spec.fields.map(\.key) + (spec.body.map { [$0] } ?? [])
    }

    /// The payload keys that hold a moment (RFC 3339) and are shown as a date and time.
    static let timeKeys: Set<String> = ["start", "end"]

    /// "Wed, Oct 14, 2026 at 10:00 AM MDT" for a stored RFC 3339 moment: the same instant,
    /// in this device's zone, with the zone named. nil when the text is not a moment — it is
    /// then shown exactly as stored.
    public static func momentText(_ stored: String, timeZone: TimeZone = .current, locale: Locale = .current) -> String? {
        guard let date = PrismJSON.parseDate(stored) else { return nil }
        var style = Date.FormatStyle.dateTime.weekday(.abbreviated).month(.abbreviated).day().year().hour().minute().timeZone()
        style.timeZone = timeZone
        style.locale = locale
        return date.formatted(style)
    }

    /// A value as text: strings as they are, lists of strings joined, anything else as its
    /// canonical JSON (never dropped).
    static func text(_ value: JSONValue) -> String {
        if let s = value.stringValue { return s }
        if let list = value.stringArrayValue { return list.joined(separator: ", ") }
        return value.canonicalJSON
    }
}

/// Editing a pending draft. Only the text a person would reword is editable; recipients,
/// times and amounts are not (a changed recipient is a new request to the agent, made with
/// Revise). The gateway validates the result per kind.
public struct ApprovalDraft: Equatable, Sendable, Identifiable {
    /// Stable while one draft is being edited (a sheet's identity).
    public var id: String { fields.map(\.key).joined(separator: ",") }

    public struct TextField: Equatable, Sendable, Identifiable {
        public let key: String
        public let label: String
        public let multiline: Bool
        public var text: String
        public var id: String { key }
    }

    public var fields: [TextField]
    private let original: JSONValue

    public static func editableKeys(for kind: ApprovalKind) -> [(key: String, label: String, multiline: Bool)] {
        switch kind {
        case .email: return [("subject", "Subject", false), ("body", "Body", true)]
        case .emailReply, .message: return [("body", "Body", true)]
        case .calendarInvite: return [("title", "Title", false), ("location", "Where", false), ("description", "Description", true)]
        case .tweet: return [("text", "Text", true)]
        default: return []
        }
    }

    /// nil when this kind has nothing editable here.
    public init?(_ approval: Approval) {
        guard let object = approval.payload.objectValue else { return nil }
        let fields = Self.editableKeys(for: approval.kind).compactMap { spec -> TextField? in
            guard let text = object[spec.key]?.stringValue else { return nil }
            return TextField(key: spec.key, label: spec.label, multiline: spec.multiline, text: text)
        }
        guard !fields.isEmpty else { return nil }
        self.fields = fields
        self.original = approval.payload
    }

    /// The payload with the edited text put back; every other key untouched.
    public var payload: JSONValue {
        guard var object = original.objectValue else { return original }
        for field in fields { object[field.key] = .string(field.text) }
        return .object(object)
    }

    public var hasChanges: Bool { payload != original }
}
