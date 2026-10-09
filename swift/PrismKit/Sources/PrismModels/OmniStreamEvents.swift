import Foundation

/// One event of a thread's stream (`GET /api/omni/threads/:id/stream`).
public enum OmniStreamEvent: Sendable, Equatable {
    /// The Hermes run started.
    case initialized(runId: String?)
    /// Live tokens for a block. Never persisted, never carries a `seq`.
    case textDelta(blockId: String, text: String)
    /// The final text of a block — REPLACES everything its deltas built.
    case text(blockId: String, text: String)
    /// `name` has no `mcp__server__` prefix; `input` is redacted and truncated.
    case toolUse(id: String, name: String, input: JSONValue)
    case toolResult(toolUseId: String, ok: Bool, summary: String)
    case card(RecordCard)
    /// A draft was proposed, or a decision finished.
    case approval(Approval)
    /// Thread state; `reason` = an error code, `queued`, `agent_message`,
    /// `hermes_approval_requested`.
    case status(state: ThreadState, reason: String?)
    /// Exactly one per turn. `errorCode`: `cancelled`, `auth`, `usage_limit`, `budget`,
    /// `timeout`, `iteration_limit`, `agent_failed`, `stream_ended`, `hermes_*`,
    /// `internal_error`.
    case result(ok: Bool, durationMs: Int, errorCode: String?)
    /// A type this build does not know (or a known type with an unexpected shape).
    case unknown(type: String, payload: JSONValue)
}

public struct OmniStreamEnvelope: Sendable, Equatable {
    /// The per-thread sequence number of a PERSISTED event; nil for live-only deltas.
    public let seq: Int?
    public let turnId: String?
    public let event: OmniStreamEvent

    public init(seq: Int?, turnId: String?, event: OmniStreamEvent) {
        self.seq = seq
        self.turnId = turnId
        self.event = event
    }

    public var isPersisted: Bool { seq != nil }

    /// Decode one SSE frame: `eventName` is the `event:` field, `data` the JSON in
    /// `data:`. Returns nil when `data` is not a JSON object.
    public static func decode(eventName: String, data: String) -> OmniStreamEnvelope? {
        let raw = Data(data.utf8)
        guard let value = try? PrismJSON.decoder().decode(JSONValue.self, from: raw), let obj = value.objectValue else { return nil }
        let t = obj["t"]?.stringValue ?? eventName
        let seq = obj["seq"]?.intValue
        let turnId = obj["turnId"]?.stringValue
        func sub<T: Decodable>(_ key: String, _ type: T.Type) -> T? {
            guard let v = obj[key], let d = try? PrismJSON.encoder().encode(v) else { return nil }
            return try? PrismJSON.decoder().decode(T.self, from: d)
        }
        let event: OmniStreamEvent? = {
            switch t {
            case "init":
                return .initialized(runId: obj["runId"]?.stringValue)
            case "text_delta":
                guard let b = obj["blockId"]?.stringValue, let text = obj["text"]?.stringValue else { return nil }
                return .textDelta(blockId: b, text: text)
            case "text":
                guard let b = obj["blockId"]?.stringValue, let text = obj["text"]?.stringValue else { return nil }
                return .text(blockId: b, text: text)
            case "tool_use":
                guard let id = obj["id"]?.stringValue, let name = obj["name"]?.stringValue else { return nil }
                return .toolUse(id: id, name: name, input: obj["input"] ?? .null)
            case "tool_result":
                guard let id = obj["toolUseId"]?.stringValue, let ok = obj["ok"]?.boolValue else { return nil }
                return .toolResult(toolUseId: id, ok: ok, summary: obj["summary"]?.stringValue ?? "")
            case "card":
                return sub("card", RecordCard.self).map(OmniStreamEvent.card)
            case "approval":
                return sub("approval", Approval.self).map(OmniStreamEvent.approval)
            case "status":
                guard let s = obj["state"]?.stringValue else { return nil }
                return .status(state: ThreadState(rawValue: s), reason: obj["reason"]?.stringValue)
            case "result":
                guard let ok = obj["ok"]?.boolValue else { return nil }
                return .result(ok: ok, durationMs: obj["durationMs"]?.intValue ?? 0, errorCode: obj["errorCode"]?.stringValue)
            default:
                return nil
            }
        }()
        return OmniStreamEnvelope(seq: seq, turnId: turnId, event: event ?? .unknown(type: t, payload: value))
    }
}

/// Folds a thread's stream into what a transcript view shows.
///
/// - **Apply once by seq:** a persisted event whose `seq` is not newer than ``lastSeq`` is
///   ignored, so a replay after reconnect (`?after=`) never duplicates anything.
/// - **Delta then final:** `text_delta`s build a provisional block; the block's `text`
///   event REPLACES it. A delta that arrives after its block is final is ignored.
public struct TurnTranscript: Sendable, Equatable {
    public struct ToolCall: Sendable, Equatable {
        public let id: String
        public let name: String
        public let input: JSONValue
        public var ok: Bool?
        public var summary: String?
    }
    public struct TurnResult: Sendable, Equatable {
        public let ok: Bool
        public let durationMs: Int
        public let errorCode: String?
    }
    public enum Item: Sendable, Equatable {
        case text(blockId: String, text: String, isFinal: Bool)
        case tool(ToolCall)
        case card(RecordCard)
        case approval(Approval)
    }

    public private(set) var items: [Item] = []
    /// The resume cursor: pass it as `after` when re-attaching.
    public private(set) var lastSeq: Int
    public private(set) var state: ThreadState?
    public private(set) var statusReason: String?
    public private(set) var runId: String?
    /// The most recent turn's result.
    public private(set) var result: TurnResult?

    public init(lastSeq: Int = 0) {
        self.lastSeq = lastSeq
    }

    /// Returns false when the event was a duplicate (already applied) or a stale delta.
    @discardableResult
    public mutating func apply(_ envelope: OmniStreamEnvelope) -> Bool {
        if let seq = envelope.seq {
            guard seq > lastSeq else { return false }
            lastSeq = seq
        }
        switch envelope.event {
        case .initialized(let runId):
            self.runId = runId
            self.result = nil
        case .textDelta(let blockId, let text):
            if let i = textIndex(blockId) {
                guard case .text(_, let current, let isFinal) = items[i], !isFinal else { return false }
                items[i] = .text(blockId: blockId, text: current + text, isFinal: false)
            } else {
                items.append(.text(blockId: blockId, text: text, isFinal: false))
            }
        case .text(let blockId, let text):
            if let i = textIndex(blockId) {
                items[i] = .text(blockId: blockId, text: text, isFinal: true)
            } else {
                items.append(.text(blockId: blockId, text: text, isFinal: true))
            }
        case .toolUse(let id, let name, let input):
            items.append(.tool(ToolCall(id: id, name: name, input: input)))
        case .toolResult(let toolUseId, let ok, let summary):
            if let i = items.lastIndex(where: { if case .tool(let c) = $0 { return c.id == toolUseId } else { return false } }), case .tool(var call) = items[i] {
                call.ok = ok
                call.summary = summary
                items[i] = .tool(call)
            }
        case .card(let card):
            items.append(.card(card))
        case .approval(let approval):
            // A decision that finished updates the card already shown.
            if let i = items.firstIndex(where: { if case .approval(let a) = $0 { return a.id == approval.id } else { return false } }) {
                items[i] = .approval(approval)
            } else {
                items.append(.approval(approval))
            }
        case .status(let state, let reason):
            self.state = state
            self.statusReason = reason
        case .result(let ok, let durationMs, let errorCode):
            self.result = TurnResult(ok: ok, durationMs: durationMs, errorCode: errorCode)
        case .unknown:
            break
        }
        return true
    }

    private func textIndex(_ blockId: String) -> Int? {
        items.lastIndex { if case .text(let b, _, _) = $0 { return b == blockId } else { return false } }
    }
}
