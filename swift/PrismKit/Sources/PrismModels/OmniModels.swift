import Foundation

// Codable models for every `/api/omni/*` route docs/omni-module.md documents as BUILT.
// Decode with `PrismJSON.decoder()` (ISO-8601 dates with fractional seconds).
//
// Open string sets (states, statuses, kinds, ops) are `RawRepresentable` structs, not
// enums, so a value a newer server adds decodes instead of failing the whole response.

/// `GET /api/omni/version`.
public struct OmniVersion: Codable, Sendable, Equatable {
    public let api: Int
    public let minClient: String
}

public struct ThreadState: RawRepresentable, Codable, Hashable, Sendable {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public static let working = ThreadState(rawValue: "working")
    public static let needsYou = ThreadState(rawValue: "needs-you")
    public static let waiting = ThreadState(rawValue: "waiting")
    public static let scheduled = ThreadState(rawValue: "scheduled")
    public static let done = ThreadState(rawValue: "done")
    public static let allKnown: [ThreadState] = [.working, .needsYou, .waiting, .scheduled, .done]
}

/// A thread = a Hermes session (`id` is the session id) + the gateway's app-side metadata.
public struct OmniThread: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public var title: String?
    /// Derived by the server: a running turn → `working`; a pending approval → `needs-you`.
    public var state: ThreadState
    public var objective: String?
    public var taskNoteId: String?
    public var lastActivityAt: Date?
    public var unread: Int
    public var pinned: Bool
    public var archived: Bool
    public var nextCheckAt: Date?
    public var waitingOn: String?
    public var model: String?
    public var preview: String?
    public var messageCount: Int?
    public var running: Bool
    /// The newest persisted stream event (`?after=` cursor).
    public var lastSeq: Int
    /// `text | voice | nudge | prism | hermes` (a session started outside Omni).
    public var source: String?
    /// The agent no longer has this conversation: only the server's own row is left, so it
    /// cannot be opened. Show it as "no longer available" and offer to remove it
    /// (`updateThread(id, ThreadPatch(archived: true))`). False on a server that predates the flag.
    public var gone: Bool

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = try c.decodeIfPresent(String.self, forKey: .title)
        state = try c.decodeIfPresent(ThreadState.self, forKey: .state) ?? .waiting
        objective = try c.decodeIfPresent(String.self, forKey: .objective)
        taskNoteId = try c.decodeIfPresent(String.self, forKey: .taskNoteId)
        lastActivityAt = try c.decodeIfPresent(Date.self, forKey: .lastActivityAt)
        unread = try c.decodeIfPresent(Int.self, forKey: .unread) ?? 0
        pinned = try c.decodeIfPresent(Bool.self, forKey: .pinned) ?? false
        archived = try c.decodeIfPresent(Bool.self, forKey: .archived) ?? false
        nextCheckAt = try c.decodeIfPresent(Date.self, forKey: .nextCheckAt)
        waitingOn = try c.decodeIfPresent(String.self, forKey: .waitingOn)
        model = try c.decodeIfPresent(String.self, forKey: .model)
        preview = try c.decodeIfPresent(String.self, forKey: .preview)
        messageCount = try c.decodeIfPresent(Int.self, forKey: .messageCount)
        running = try c.decodeIfPresent(Bool.self, forKey: .running) ?? false
        lastSeq = try c.decodeIfPresent(Int.self, forKey: .lastSeq) ?? 0
        source = try c.decodeIfPresent(String.self, forKey: .source)
        gone = try c.decodeIfPresent(Bool.self, forKey: .gone) ?? false
    }
}

/// `GET /api/omni/threads`.
public struct ThreadList: Decodable, Sendable, Equatable {
    public let threads: [OmniThread]
    /// Pagination cursor; always nil today.
    public let next: String?
    /// `ok`, or `unavailable` when Hermes is down and only local rows are listed.
    public let hermes: String
    public var hermesAvailable: Bool { hermes == "ok" }
}

public struct MessageRole: RawRepresentable, Codable, Hashable, Sendable {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public static let user = MessageRole(rawValue: "user")
    public static let assistant = MessageRole(rawValue: "assistant")
    public static let tool = MessageRole(rawValue: "tool")
}

/// One Hermes message. Tool rows carry only the tool's name — a tool's raw output is
/// never forwarded.
public struct OmniMessage: Decodable, Sendable, Equatable {
    /// Hermes' id (a string or a number on the wire), as text.
    public let id: String?
    public let role: MessageRole
    public let text: String?
    public let toolName: String?
    public let at: Date?

    enum CodingKeys: String, CodingKey { case id, role, text, toolName, at }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        if let s = try? c.decodeIfPresent(String.self, forKey: .id) {
            id = s
        } else if let n = try? c.decodeIfPresent(Int64.self, forKey: .id) {
            id = String(n)
        } else {
            id = nil
        }
        role = try c.decode(MessageRole.self, forKey: .role)
        text = try c.decodeIfPresent(String.self, forKey: .text)
        toolName = try c.decodeIfPresent(String.self, forKey: .toolName)
        at = try? c.decodeIfPresent(Date.self, forKey: .at)
    }
}

/// `GET /api/omni/threads/:id` (reading it clears `unread`).
public struct ThreadDetail: Decodable, Sendable, Equatable {
    public let thread: OmniThread
    /// Newest 200.
    public let messages: [OmniMessage]
    /// Newest first.
    public let cards: [RecordCard]
    public let approvals: [Approval]
    /// Attach to it with the thread stream when non-nil.
    public let activeTurnId: String?

    public init(thread: OmniThread, messages: [OmniMessage], cards: [RecordCard], approvals: [Approval], activeTurnId: String?) {
        self.thread = thread
        self.messages = messages
        self.cards = cards
        self.approvals = approvals
        self.activeTurnId = activeTurnId
    }
}

/// `POST /api/omni/threads` body.
public struct NewThread: Encodable, Sendable, Equatable {
    public var prompt: String
    public var title: String?
    public var objective: String?
    public var taskNoteId: String?
    /// Up to 20 Prism note ids the agent should read.
    public var noteIds: [String]?
    /// `text | voice | nudge | prism` (the server defaults to `text`).
    public var source: String?

    public init(prompt: String, title: String? = nil, objective: String? = nil, taskNoteId: String? = nil, noteIds: [String]? = nil, source: String? = nil) {
        self.prompt = prompt
        self.title = title
        self.objective = objective
        self.taskNoteId = taskNoteId
        self.noteIds = noteIds
        self.source = source
    }
}

public struct CreatedThread: Decodable, Sendable, Equatable {
    public let thread: OmniThread
    public let turnId: String?
}

/// `PATCH /api/omni/threads/:id` body: only the fields you set are sent (unknown keys → 400).
public struct ThreadPatch: Encodable, Sendable, Equatable {
    public var title: String?
    public var pinned: Bool?
    public var archived: Bool?
    public var state: ThreadState?
    /// `false` marks read; `true` marks unread.
    public var unread: Bool?

    public init(title: String? = nil, pinned: Bool? = nil, archived: Bool? = nil, state: ThreadState? = nil, unread: Bool? = nil) {
        self.title = title
        self.pinned = pinned
        self.archived = archived
        self.state = state
        self.unread = unread
    }
}

// MARK: - Record cards

public struct CardOp: RawRepresentable, Codable, Hashable, Sendable {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public static let created = CardOp(rawValue: "created")
    public static let updated = CardOp(rawValue: "updated")
    public static let deleted = CardOp(rawValue: "deleted")
    public static let commented = CardOp(rawValue: "commented")
    public static let suggested = CardOp(rawValue: "suggested")
}

/// A record the agent changed; tapping it opens the note in Prism.
public struct RecordCard: Codable, Sendable, Equatable {
    public struct Writer: Codable, Sendable, Equatable {
        /// `agent` (a Prism MCP write) or `external`; treat anything else as `external`.
        public let kind: String
        public let label: String?
        public var isAgent: Bool { kind == "agent" }
    }
    public struct Links: Codable, Sendable, Equatable {
        /// `https://<prism-origin>/page/<id>` (a universal link).
        public let prism: String?
        /// `prism://page/<id>`.
        public let prismApp: String?
        /// `omni://record/<id>`.
        public let omni: String?
    }
    public struct BodyDelta: Codable, Sendable, Equatable {
        public let chars: Int?
    }

    public let kind: String
    public let noteId: String
    public let op: CardOp
    /// Prism's `inferContentType`.
    public let type: String?
    public let title: String?
    public let path: String?
    public let tags: [String]?
    public let icon: String?
    public let summary: String?
    public let changedKeys: [String]?
    public let bodyDelta: BodyDelta?
    public let writer: Writer?
    /// The vault's own timestamp text (not always ISO-8601).
    public let updatedAt: String?
    public let threadId: String?
    public let links: Links?
    public let `private`: Bool?
}

// MARK: - Approvals

public struct ApprovalKind: RawRepresentable, Codable, Hashable, Sendable {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public static let email = ApprovalKind(rawValue: "email")
    public static let emailReply = ApprovalKind(rawValue: "email-reply")
    public static let message = ApprovalKind(rawValue: "message")
    public static let calendarInvite = ApprovalKind(rawValue: "calendar-invite")
    public static let tweet = ApprovalKind(rawValue: "tweet")
    public static let walletProposal = ApprovalKind(rawValue: "wallet-proposal")
    /// Not a draft to send: one tool call of a running turn that Hermes paused for the person
    /// (a shell command that would reach the network, a write outside the workspace, a
    /// scheduled job…). "Send" on it means "Approve once"; the turn then runs exactly it.
    public static let command = ApprovalKind(rawValue: "command")
}

/// `pending → approved (claimed) → sent | failed | unknown`, or `expired`, `cancelled`,
/// `revised`. `unknown` = the executor may have acted — check before sending again.
public struct ApprovalStatus: RawRepresentable, Codable, Hashable, Sendable {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public static let pending = ApprovalStatus(rawValue: "pending")
    public static let approved = ApprovalStatus(rawValue: "approved")
    public static let sent = ApprovalStatus(rawValue: "sent")
    public static let failed = ApprovalStatus(rawValue: "failed")
    public static let unknown = ApprovalStatus(rawValue: "unknown")
    public static let expired = ApprovalStatus(rawValue: "expired")
    public static let cancelled = ApprovalStatus(rawValue: "cancelled")
    public static let revised = ApprovalStatus(rawValue: "revised")
}

/// A proposed outward action. The payload is the FULL draft: show it untruncated.
public struct Approval: Codable, Sendable, Equatable, Identifiable {
    public struct Executor: Codable, Sendable, Equatable {
        public let name: String
        /// An executor is wired for this kind.
        public let available: Bool
        /// …and switched on. `send` is refused (`executor_disabled`) while false.
        public let enabled: Bool
        public var canSend: Bool { available && enabled }
    }

    public let id: String
    public let threadId: String?
    public let kind: ApprovalKind
    /// Per kind — email `{to, cc?, subject, body}`; email-reply `{noteId, expectTo, cc?,
    /// body}`; message `{roomId, body}`; calendar-invite `{title, start, end, attendees?,
    /// location?, description?}`; tweet `{text}`; wallet-proposal `{to, amount, token?,
    /// chain, purpose}`; command `{tool, command?, cwd?, input?, reason, rule, title?, origin?}`.
    public let payload: JSONValue
    /// The server's digest of `{kind, payload}`; echoed back on a decision.
    public let digest: String
    public let summary: String?
    public let status: ApprovalStatus
    public let createdAt: Date?
    public let expiresAt: Date?
    public let decidedAt: Date?
    /// How it was decided: `session` / `device` (the person), or — for a `command` the
    /// gateway closed itself — `turn-ended` / `withdrawn`.
    public let decidedVia: String?
    /// The executor's outcome (`error`, `messageId`, …) once decided.
    public let result: JSONValue?
    public let supersededBy: String?
    public let revises: String?
    public let executor: Executor?

    /// The digest of what this object actually holds, computed locally.
    public var computedDigest: String { ApprovalDigest.digest(kind: kind.rawValue, payload: payload) }

    /// Does the payload on screen hash to the digest the server stated? Check before
    /// offering Send: a mismatch means the draft shown is not the one that would be sent.
    public var digestMatchesPayload: Bool { computedDigest == digest }

    public var isPending: Bool { status == .pending }
}

public struct ApprovalList: Decodable, Sendable, Equatable {
    public let approvals: [Approval]
}

public struct ApprovalDecisionKind: RawRepresentable, Codable, Hashable, Sendable {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public static let send = ApprovalDecisionKind(rawValue: "send")
    public static let cancel = ApprovalDecisionKind(rawValue: "cancel")
    /// With `feedback`, a new turn asks the agent for a new draft.
    public static let revise = ApprovalDecisionKind(rawValue: "revise")
}

// MARK: - Change channel

/// One ids-only notice from `GET /api/omni/events`. Re-read the named resource.
public struct OmniNotice: Codable, Sendable, Equatable {
    /// `thread | approval | card`.
    public let type: String
    public let id: String
    /// thread: `created|working|done|needs-you|waiting|message`; approval:
    /// `pending|sent|failed|unknown|cancelled|revised`; card: the card op.
    public let op: String
    public let threadId: String?
}

// MARK: - Jobs (Hermes cron)

public struct OmniJob: Decodable, Sendable, Equatable, Identifiable {
    /// 12 hex characters.
    public let id: String
    public let name: String?
    /// Hermes' own shape (a string or an object).
    public let schedule: JSONValue?
    public let enabled: Bool?
    public let paused: Bool?
    public let nextRunAt: JSONValue?
    public let lastRunAt: JSONValue?
    public let lastStatus: String?
    /// ≤ 300 characters.
    public let lastError: String?
    public let deliver: JSONValue?
    public let skill: JSONValue?
    public let skills: JSONValue?
    public let `repeat`: JSONValue?
    public let state: JSONValue?

    enum CodingKeys: String, CodingKey {
        case id, name, schedule, enabled, paused, deliver, skill, skills, state
        case `repeat`
        case nextRunAt = "next_run_at"
        case lastRunAt = "last_run_at"
        case lastStatus = "last_status"
        case lastError = "last_error"
    }
}

public struct JobList: Decodable, Sendable, Equatable {
    public let jobs: [OmniJob]
}

/// `POST /api/omni/jobs` body: a `prompt` (≤ 5000) or a `skill` is required.
public struct NewJob: Encodable, Sendable, Equatable {
    public var name: String
    public var schedule: String
    public var prompt: String?
    public var skill: String?
    public var deliver: String?

    public init(name: String, schedule: String, prompt: String? = nil, skill: String? = nil, deliver: String? = nil) {
        self.name = name
        self.schedule = schedule
        self.prompt = prompt
        self.skill = skill
        self.deliver = deliver
    }
}

public enum JobAction: String, Sendable {
    case pause, resume, run
}

// MARK: - Today

/// `GET /api/omni/today`. A section that failed on the server is nil and named in `errors`.
public struct OmniToday: Codable, Sendable, Equatable {
    public struct AgendaItem: Codable, Sendable, Equatable {
        public let noteId: String
        public let title: String
        /// As stored on the meeting note (normally RFC 3339).
        public let start: String?
        public let end: String?
        public let location: String?
        public let meetLink: String?
        public let link: String?
    }
    public struct TaskItem: Codable, Sendable, Equatable {
        public let noteId: String
        public let title: String
        public let status: String?
        public let due: String?
        public let priority: String?
        /// The thread working on this task, if one is bound.
        public let threadId: String?
        public let link: String?
    }
    public struct NeedsYou: Codable, Sendable, Equatable {
        public let approvals: [Approval]
        /// TODO(M3): nudges are not built; always empty today.
        public let nudges: [JSONValue]
    }
    public struct InFlight: Codable, Sendable, Equatable {
        public let id: String
        public let title: String?
        public let state: ThreadState?
        public let lastActivityAt: Date?
    }

    public let date: String
    public let agenda: [AgendaItem]?
    public let tasks: [TaskItem]?
    /// `person | account | unset` — how "assigned to me" was resolved.
    public let taskIdentity: String?
    public let needsYou: NeedsYou
    public let inFlight: [InFlight]
    /// TODO(M3): not built; always nil today.
    public let openLoops: JSONValue?
    /// TODO(M3): not built; always nil today.
    public let brief: JSONValue?
    /// Section name → error code (`{"agenda": "query_502"}`).
    public let errors: [String: String]
}
