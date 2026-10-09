import Foundation
import Observation
import PrismTransport

/// The last requests the app made, for the development build's Settings → Diagnostics, so a
/// failure can be pasted instead of read out of a terminal.
///
/// It holds what a server log line holds and nothing more: time, method, path, status, the
/// server's `error` code — never a token, a header, a query string or a body — plus a few
/// notes the app writes itself ("sign-in: finished"). Kept in memory only.
@MainActor
@Observable
public final class DiagnosticsLog {
    public struct Entry: Identifiable, Equatable, Sendable {
        public let id: UUID
        public let at: Date
        /// One line, as it is shown and copied.
        public let line: String
        public let isFailure: Bool
    }

    public private(set) var entries: [Entry] = []
    public let capacity: Int

    public init(capacity: Int = 200) {
        self.capacity = max(1, capacity)
    }

    public var failureCount: Int { entries.reduce(0) { $0 + ($1.isFailure ? 1 : 0) } }

    public func record(_ request: RequestRecord) {
        append(Entry(id: request.id, at: request.at, line: Self.line(for: request), isFailure: request.isFailure))
    }

    /// A note from the app itself. Callers pass plain words and codes — never a URL with a
    /// query, a token or a server's raw text.
    public func note(_ text: String, isFailure: Bool = false, at: Date = Date()) {
        append(Entry(id: UUID(), at: at, line: "\(Self.clock(at))  ·  \(text)", isFailure: isFailure))
    }

    public func clear() {
        entries.removeAll()
    }

    /// Everything, oldest first, ready to paste.
    public var text: String {
        entries.isEmpty ? "No requests yet." : entries.map(\.line).joined(separator: "\n")
    }

    /// The observer to hand to `PrismClient(onRequest:)`. Safe from any thread.
    public nonisolated var observer: PrismClient.RequestObserver {
        { [weak self] record in
            Task { @MainActor in self?.record(record) }
        }
    }

    private func append(_ entry: Entry) {
        entries.append(entry)
        if entries.count > capacity { entries.removeFirst(entries.count - capacity) }
    }

    /// `14:03:07  GET /api/omni/threads/omni_ab12 → 404 not_found  (12 ms)`
    public static func line(for r: RequestRecord) -> String {
        var out = "\(clock(r.at))  \(r.method) \(r.path)\(r.isStream ? " [stream]" : "") → "
        if let status = r.status {
            out += "\(status)"
            if let code = r.serverCode { out += " \(code)" }
        } else {
            out += "no answer (\(r.failure ?? "network error"))"
        }
        return out + "  (\(r.durationMs) ms)"
    }

    /// `14:03:07`, in the device's time zone.
    static func clock(_ date: Date) -> String {
        let c = Calendar.current.dateComponents([.hour, .minute, .second], from: date)
        return String(format: "%02d:%02d:%02d", c.hour ?? 0, c.minute ?? 0, c.second ?? 0)
    }
}
