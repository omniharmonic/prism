import Foundation

/// One dispatched server-sent event.
public struct SSEEvent: Sendable, Equatable {
    /// The `event:` field (`message` when absent).
    public var event: String
    /// The `data:` lines joined with `\n`.
    public var data: String
    /// The `id:` field OF THIS EVENT, or nil when it had none. Persisted events carry an
    /// id; live-only events (token deltas) do not, and must not move a resume cursor.
    public var id: String?

    public init(event: String = "message", data: String, id: String? = nil) {
        self.event = event
        self.data = data
        self.id = id
    }
}

public enum SSEItem: Sendable, Equatable {
    case event(SSEEvent)
    /// A `: comment` line (the server's `: ping` keepalive). Proof of life only.
    case comment(String)
    /// `retry: <ms>` — the server's reconnect hint.
    case retry(milliseconds: Int)
}

/// An incremental `text/event-stream` parser (WHATWG HTML § 9.2.6). Pure: feed it bytes
/// in any chunking, get items out. Handles LF / CRLF / CR line ends (also split across
/// chunks), a leading BOM, multi-line `data`, comments, `retry`, and UTF-8 sequences cut
/// by a chunk boundary.
public struct SSEParser: Sendable {
    /// The last `id` seen on a dispatched event — what `Last-Event-ID` should carry.
    public private(set) var lastEventID: String?

    private var line: [UInt8] = []
    private var pendingCR = false
    private var atStart = true
    private var dataLines: [String] = []
    private var eventName = ""
    private var eventID: String?
    private var sawData = false
    /// A line longer than this is dropped (a hostile or broken stream cannot grow memory).
    public var maxLineBytes: Int

    public init(lastEventID: String? = nil, maxLineBytes: Int = 4 * 1024 * 1024) {
        self.lastEventID = lastEventID
        self.maxLineBytes = maxLineBytes
    }

    public mutating func feed(_ data: Data) -> [SSEItem] {
        var out: [SSEItem] = []
        for byte in data { feed(byte, into: &out) }
        return out
    }

    public mutating func feed(_ text: String) -> [SSEItem] { feed(Data(text.utf8)) }

    private mutating func feed(_ byte: UInt8, into out: inout [SSEItem]) {
        if pendingCR {
            pendingCR = false
            if byte == 0x0A { return } // the LF of a CRLF
        }
        switch byte {
        case 0x0D:
            pendingCR = true
            endLine(&out)
        case 0x0A:
            endLine(&out)
        default:
            if line.count < maxLineBytes { line.append(byte) }
        }
    }

    private mutating func endLine(_ out: inout [SSEItem]) {
        var bytes = line
        line.removeAll(keepingCapacity: true)
        if atStart {
            atStart = false
            if bytes.starts(with: [0xEF, 0xBB, 0xBF]) { bytes.removeFirst(3) }
        }
        if bytes.isEmpty {
            dispatch(&out)
            return
        }
        if bytes[0] == 0x3A { // ":" comment
            var rest = bytes.dropFirst()
            if rest.first == 0x20 { rest = rest.dropFirst() }
            out.append(.comment(String(decoding: rest, as: UTF8.self)))
            return
        }
        let name: String, value: String
        if let colon = bytes.firstIndex(of: 0x3A) {
            name = String(decoding: bytes[..<colon], as: UTF8.self)
            var v = bytes[(colon + 1)...]
            if v.first == 0x20 { v = v.dropFirst() }
            value = String(decoding: v, as: UTF8.self)
        } else {
            name = String(decoding: bytes, as: UTF8.self)
            value = ""
        }
        switch name {
        case "event": eventName = value
        case "data":
            dataLines.append(value)
            sawData = true
        case "id":
            if !value.unicodeScalars.contains("\u{0}") { eventID = value }
        case "retry":
            if !value.isEmpty, value.utf8.allSatisfy({ $0 >= 0x30 && $0 <= 0x39 }), let ms = Int(value) { out.append(.retry(milliseconds: ms)) }
        default: break
        }
    }

    private mutating func dispatch(_ out: inout [SSEItem]) {
        defer {
            dataLines.removeAll(keepingCapacity: true)
            eventName = ""
            eventID = nil
            sawData = false
        }
        if let id = eventID { lastEventID = id.isEmpty ? nil : id }
        guard sawData else { return } // no data → nothing is dispatched
        out.append(.event(SSEEvent(event: eventName.isEmpty ? "message" : eventName, data: dataLines.joined(separator: "\n"), id: eventID.flatMap { $0.isEmpty ? nil : $0 })))
    }
}
