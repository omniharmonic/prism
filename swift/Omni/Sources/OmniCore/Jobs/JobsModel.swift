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
            guard let message = sink.describe(error) else { return }
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
        if let text = schedule.stringValue { return text }
        for key in ["display", "expr", "expression", "cron", "value", "kind"] {
            if let text = schedule[key]?.stringValue, !text.isEmpty { return text }
        }
        return schedule.canonicalJSON
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
