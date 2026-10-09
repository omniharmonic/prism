import Foundation
import Observation
import OmniClient

/// Recurring jobs (Hermes cron), read-only plus pause / resume.
@MainActor
@Observable
public final class JobsModel {
    public private(set) var jobs: [OmniJob] = []
    public private(set) var phase: LoadPhase = .idle
    /// The job a pause/resume is running for.
    public private(set) var busyJobID: String?
    public private(set) var actionProblem: String?

    private let service: any OmniService
    private let sink: ErrorSink

    public init(service: any OmniService, sink: ErrorSink) {
        self.service = service
        self.sink = sink
    }

    public func refresh() async {
        if jobs.isEmpty { phase = .loading }
        do {
            jobs = try await service.jobs()
            phase = .loaded
        } catch {
            guard let message = sink.describe(error, reading: true) else { return }
            phase = .failed(message)
        }
    }

    /// Pause a running job, or resume a paused one.
    public func toggle(_ job: OmniJob) async {
        guard busyJobID == nil else { return }
        busyJobID = job.id
        actionProblem = nil
        defer { busyJobID = nil }
        do {
            let updated = try await service.job(job.id, JobPresentation.isPaused(job) ? .resume : .pause)
            if let index = jobs.firstIndex(where: { $0.id == updated.id }) { jobs[index] = updated }
        } catch {
            guard let message = sink.describe(error) else { return }
            actionProblem = message
            // Pause and resume are safe to read back: show what the server has now.
            await refresh()
        }
    }
}

/// A job's Hermes-shaped fields as text.
public enum JobPresentation {
    public static func isPaused(_ job: OmniJob) -> Bool {
        if job.paused == true { return true }
        if job.enabled == false { return true }
        return job.state?.stringValue == "paused"
    }

    public static func name(_ job: OmniJob) -> String {
        if let name = job.name?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty { return name }
        return "Job \(job.id)"
    }

    /// The schedule in Hermes' own words: a string as it is, or an object's `display` /
    /// `expr` / `value`.
    public static func schedule(_ job: OmniJob) -> String? {
        guard let schedule = job.schedule, !schedule.isNull else { return nil }
        if let text = schedule.stringValue { return cronInWords(text) ?? text }
        for key in ["display", "expr", "expression", "cron", "value", "kind"] {
            if let text = schedule[key]?.stringValue, !text.isEmpty { return cronInWords(text) ?? text }
        }
        return schedule.canonicalJSON
    }

    /// The common five-field cron lines in words ("0 7 * * *" → "Every day at 7:00 AM").
    /// nil for anything else: the line is then shown as Hermes wrote it, never guessed at.
    public static func cronInWords(_ text: String, locale: Locale = .current) -> String? {
        let f = text.split(separator: " ", omittingEmptySubsequences: true).map(String.init)
        guard f.count == 5, f[2] == "*", f[3] == "*" else { return nil }
        func step(_ field: String) -> Int? {
            guard field.hasPrefix("*/"), let n = Int(field.dropFirst(2)), n > 0 else { return nil }
            return n
        }
        if f[1] == "*", f[4] == "*" {
            if f[0] == "*" { return "Every minute" }
            if let n = step(f[0]) { return n == 1 ? "Every minute" : "Every \(n) minutes" }
            if let minute = Int(f[0]), (0..<60).contains(minute) { return minute == 0 ? "Every hour" : "Every hour at :\(String(format: "%02d", minute))" }
            return nil
        }
        guard let minute = Int(f[0]), (0..<60).contains(minute) else { return nil }
        if let n = step(f[1]), f[4] == "*", minute == 0 { return n == 1 ? "Every hour" : "Every \(n) hours" }
        guard let hour = Int(f[1]), (0..<24).contains(hour) else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC") ?? .current
        guard let date = calendar.date(from: DateComponents(year: 2001, month: 1, day: 1, hour: hour, minute: minute)) else { return nil }
        var style = Date.FormatStyle(date: .omitted, time: .shortened)
        style.timeZone = calendar.timeZone
        style.locale = locale
        let time = date.formatted(style)
        switch f[4] {
        case "*": return "Every day at \(time)"
        case "1-5": return "Weekdays at \(time)"
        case "0,6", "6,0": return "Weekends at \(time)"
        default:
            let names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
            guard let day = Int(f[4]), names.indices.contains(day) else { return nil }
            return "Every \(names[day]) at \(time)"
        }
    }

    /// A time Hermes gave (ISO-8601 text, or seconds / milliseconds since 1970).
    public static func date(_ value: JSONValue?) -> Date? {
        guard let value, !value.isNull else { return nil }
        if let text = value.stringValue { return PrismJSON.parseDate(text) }
        guard let number = value.doubleValue, number > 0 else { return nil }
        return Date(timeIntervalSince1970: number > 100_000_000_000 ? number / 1000 : number)
    }

    public static func lastRun(_ job: OmniJob) -> String? {
        guard let status = job.lastStatus, !status.isEmpty else { return nil }
        switch status {
        case "ok", "success", "completed": return "Last run worked"
        case "error", "failed", "failure": return "Last run failed"
        default: return "Last run: \(status)"
        }
    }
}
