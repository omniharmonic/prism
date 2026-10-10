import Foundation
import Observation
import OmniClient

/// Today: what is next, what needs a decision, what Omni is working on, today's tasks.
/// Read-only. A section the server could not build is nil and named in ``sectionProblems``.
@MainActor
@Observable
public final class TodayModel {
    public private(set) var today: OmniToday?
    public private(set) var phase: LoadPhase = .idle
    /// A read is in flight (the first one, or a refresh over what is already shown).
    public private(set) var isRefreshing = false

    private let service: any OmniService
    private let sink: ErrorSink
    private let approvals: ApprovalCenter
    private let calendar: @Sendable () -> Calendar
    private let now: @Sendable () -> Date

    public init(
        service: any OmniService,
        sink: ErrorSink,
        approvals: ApprovalCenter,
        calendar: @escaping @Sendable () -> Calendar = { .current },
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.service = service
        self.sink = sink
        self.approvals = approvals
        self.calendar = calendar
        self.now = now
    }

    /// The day asked for is the PERSON's day (this device's time zone), not the server's.
    public static func dayString(_ date: Date, calendar: Calendar) -> String {
        var gregorian = Calendar(identifier: .gregorian)
        gregorian.timeZone = calendar.timeZone
        let c = gregorian.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    public func refresh() async {
        // One read at a time (the screen appearing, ⌘R and a reconnect can coincide).
        guard !isRefreshing else { return }
        isRefreshing = true
        defer { isRefreshing = false }
        if today == nil { phase = .loading }
        do {
            let fresh = try await service.today(date: Self.dayString(now(), calendar: calendar()))
            today = fresh
            approvals.ingest(fresh.needsYou.approvals)
            phase = .loaded
        } catch {
            guard let message = sink.describe(error, reading: true) else {
                if today == nil { phase = .idle }
                return
            }
            // What was already shown stays; the message says it may be out of date.
            phase = .failed(today == nil ? message : "Couldn't refresh Today. \(message)")
        }
    }

    /// Something has been read at least once (an older answer stays up when a refresh fails).
    public var hasContent: Bool { today != nil }
    /// One plain line when some sections are missing: "Some of Today couldn't be loaded: the agenda."
    public var partialNotice: String? {
        guard let errors = today?.errors, !errors.isEmpty else { return nil }
        let names = errors.keys.sorted().map(Self.sectionName)
        return "Some of Today couldn't be loaded: \(names.joined(separator: ", ")). The rest is up to date."
    }

    public var agenda: [OmniToday.AgendaItem] { today?.agenda ?? [] }
    public var tasks: [OmniToday.TaskItem] { today?.tasks ?? [] }
    public var inFlight: [OmniToday.InFlight] { today?.inFlight ?? [] }
    public var approvalIDs: [String] { today?.needsYou.approvals.map(\.id) ?? [] }

    /// "Couldn't load the agenda." for each section the server reported as failed.
    public var sectionProblems: [String: String] {
        guard let errors = today?.errors else { return [:] }
        var out: [String: String] = [:]
        for name in errors.keys { out[name] = "Couldn't load \(Self.sectionName(name)) just now. The server couldn't read it from the vault." }
        return out
    }

    static func sectionName(_ key: String) -> String {
        switch key {
        case "agenda": return "the agenda"
        case "tasks": return "your tasks"
        default: return key
        }
    }

    /// "Today", "Tomorrow", "Oct 14" (with the year when it is not this one) from a task's
    /// stored due date (`YYYY-MM-DD`, or a full RFC 3339 moment). nil when it is neither.
    public static func dueText(_ stored: String?, now: Date = Date(), calendar: Calendar = .current, locale: Locale = .current) -> String? {
        guard let stored, !stored.isEmpty else { return nil }
        var day: Date?
        let parts = stored.prefix(10).split(separator: "-").compactMap { Int($0) }
        if stored.count >= 10, parts.count == 3 {
            day = calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
        }
        guard let day else { return nil }
        let today = calendar.startOfDay(for: now)
        let days = calendar.dateComponents([.day], from: today, to: calendar.startOfDay(for: day)).day ?? 0
        switch days {
        case 0: return "Today"
        case 1: return "Tomorrow"
        case -1: return "Yesterday"
        default:
            var style = Date.FormatStyle.dateTime.month(.abbreviated).day()
            if calendar.component(.year, from: day) != calendar.component(.year, from: now) { style = style.year() }
            style.timeZone = calendar.timeZone
            style.locale = locale
            return day.formatted(style)
        }
    }

    /// "10:30" from an agenda item's stored start (RFC 3339), in the device's zone.
    public static func timeText(_ stored: String?, timeZone: TimeZone = .current, locale: Locale = .current) -> String? {
        guard let stored, let date = PrismJSON.parseDate(stored) else { return nil }
        var style = Date.FormatStyle(date: .omitted, time: .shortened)
        style.timeZone = timeZone
        style.locale = locale
        return date.formatted(style)
    }
}
