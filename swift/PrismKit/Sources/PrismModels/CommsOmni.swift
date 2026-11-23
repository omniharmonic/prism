import Foundation

// Omni in Comms (Phase 4, PRD §5.7, DECISIONS D9). Wire shapes of
//   GET  /api/comms/threads/:id/omni
//   POST /api/comms/threads/:id/assist | /catch-up
// A draft is an Omni ``Approval`` of kind `message` whose payload is
// `{commsThreadId, roomId, body}`; Approve & Send / Refine / Discard go through the Omni approval
// routes (``OmniClient/decide(shown:_:feedback:idempotencyKey:)``).

/// `capabilities.omni`: Omni in Comms is switched on (nil from an older server = off).
public struct CommsOmniCapabilities: Codable, Hashable, Sendable {
    public var enabled: Bool
    public init(enabled: Bool) { self.enabled = enabled }
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        enabled = (try? c.decodeIfPresent(Bool.self, forKey: .enabled)) ?? false
    }
}

/// What the last Omni turn of a conversation was for.
public enum CommsOmniTurnKind: String, Codable, Hashable, Sendable {
    case draft
    case catchUp = "catch-up"
}

public struct CommsOmniTurn: Codable, Hashable, Sendable {
    public var id: String
    public var kind: CommsOmniTurnKind
    /// `running` · `done` · `error` · `cancelled` · `interrupted`.
    public var status: String
    public var startedAt: Date?
    public var endedAt: Date?
    public var errorCode: String?

    public init(id: String, kind: CommsOmniTurnKind, status: String, startedAt: Date? = nil, endedAt: Date? = nil, errorCode: String? = nil) {
        self.id = id
        self.kind = kind
        self.status = status
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.errorCode = errorCode
    }
    public var isRunning: Bool { status == "running" }
    public var failed: Bool { status == "error" || status == "interrupted" }
}

/// Omni's private answer to the owner (never a message in the chat).
public struct CommsOmniReply: Codable, Hashable, Sendable {
    public var text: String
    public var at: Date?
    public init(text: String, at: Date? = nil) {
        self.text = text
        self.at = at
    }
}

/// `GET /threads/:id/omni`.
public struct CommsOmniState: Codable, Sendable, Equatable {
    public var enabled: Bool
    /// An Omni turn is running for this conversation ("Omni is drafting…").
    public var drafting: Bool
    public var turn: CommsOmniTurn?
    public var reply: CommsOmniReply?
    /// Pending drafts and those decided in the last day, newest first.
    public var drafts: [Approval]

    public init(enabled: Bool = true, drafting: Bool = false, turn: CommsOmniTurn? = nil, reply: CommsOmniReply? = nil, drafts: [Approval] = []) {
        self.enabled = enabled
        self.drafting = drafting
        self.turn = turn
        self.reply = reply
        self.drafts = drafts
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        enabled = (try? c.decodeIfPresent(Bool.self, forKey: .enabled)) ?? false
        drafting = (try? c.decodeIfPresent(Bool.self, forKey: .drafting)) ?? false
        turn = try? c.decodeIfPresent(CommsOmniTurn.self, forKey: .turn)
        reply = try? c.decodeIfPresent(CommsOmniReply.self, forKey: .reply)
        // A draft this client cannot read is left out (never shown half-understood).
        drafts = ((try? c.decodeIfPresent([LenientApproval].self, forKey: .drafts)) ?? []).compactMap(\.value)
    }

    /// The drafts still waiting for the owner.
    public var pendingDrafts: [Approval] { drafts.filter(\.isPending) }
}

private struct LenientApproval: Decodable {
    let value: Approval?
    init(from decoder: any Decoder) throws { value = try? Approval(from: decoder) }
}

/// `202 {omniThreadId, turnId, kind}` from `/assist` and `/catch-up`.
public struct CommsOmniStart: Codable, Hashable, Sendable {
    public var omniThreadId: String
    public var turnId: String
    public var kind: CommsOmniTurnKind
    public init(omniThreadId: String, turnId: String, kind: CommsOmniTurnKind) {
        self.omniThreadId = omniThreadId
        self.turnId = turnId
        self.kind = kind
    }
}

/// A Comms reply draft's fields, read from an Omni approval (nil when it is not one).
public struct CommsDraft: Hashable, Sendable {
    public var threadID: String
    public var body: String
    /// A Telegram forum draft: the topic it is bound to (`commsTopicTitle`, set by the server).
    public var topic: String?

    public init(threadID: String, body: String, topic: String? = nil) {
        self.threadID = threadID
        self.body = body
        self.topic = topic
    }

    public init?(_ approval: Approval) {
        guard approval.kind == .message,
              let t = approval.payload["commsThreadId"]?.stringValue, !t.isEmpty,
              let b = approval.payload["body"]?.stringValue else { return nil }
        threadID = t
        body = b
        topic = approval.payload["commsTopicTitle"]?.stringValue
    }
}
