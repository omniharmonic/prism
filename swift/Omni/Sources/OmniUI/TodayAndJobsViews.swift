import OmniClient
import OmniCore
import SwiftUI

/// Today: what is next, what needs a decision, what Omni is working on, today's tasks.
/// A short read-only list (product-spec.md § 8a).
struct TodayView: View {
    let session: SessionModel
    @Environment(\.navigator) private var navigator

    var body: some View {
        let model = session.today
        List {
            if let failure = model.phase.failure {
                Section {
                    Label(failure, systemImage: "wifi.exclamationmark").foregroundStyle(.secondary)
                    Button("Try Again") { Task { await model.refresh() } }
                }
            }
            Section("Next") {
                if let problem = model.sectionProblems["agenda"] {
                    Text(problem).foregroundStyle(.secondary)
                } else if model.agenda.isEmpty {
                    Text(model.phase == .loaded ? "Nothing on the calendar today." : " ").foregroundStyle(.secondary)
                }
                ForEach(model.agenda, id: \.noteId) { item in
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Text(TodayModel.timeText(item.start) ?? "All day")
                            .font(.callout.monospacedDigit())
                            .foregroundStyle(.secondary)
                            .frame(minWidth: 64, alignment: .leading)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.title)
                            if let location = item.location, !location.isEmpty {
                                Text(location).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                            }
                        }
                    }
                    .accessibilityElement(children: .combine)
                }
            }
            Section("Needs you") {
                let ids = model.approvalIDs.filter { session.approvals.card(for: $0)?.approval.status == .pending }
                if ids.isEmpty {
                    Text(model.phase == .loaded ? "Nothing needs a decision." : " ").foregroundStyle(.secondary)
                }
                ForEach(ids, id: \.self) { id in
                    if let card = session.approvals.card(for: id) {
                        Button {
                            navigator.open(.needsYou)
                        } label: {
                            Label("Approve: \(card.content.headline)", systemImage: "hand.raised")
                        }
                        .buttonStyle(.plain)
                        .accessibilityHint("Opens Needs you")
                    }
                }
            }
            Section("Omni is working on") {
                if model.inFlight.isEmpty {
                    Text(model.phase == .loaded ? "Nothing in flight." : " ").foregroundStyle(.secondary)
                }
                ForEach(model.inFlight, id: \.id) { item in
                    Button {
                        navigator.open(.thread(item.id))
                    } label: {
                        HStack {
                            Label(item.title ?? "Untitled thread", systemImage: StateStyle.symbol(item.state ?? .working))
                            Spacer()
                            if let state = item.state {
                                Text(ThreadGrouping.title(for: state)).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint("Opens the thread")
                }
            }
            Section("Tasks today") {
                if let problem = model.sectionProblems["tasks"] {
                    Text(problem).foregroundStyle(.secondary)
                } else if model.tasks.isEmpty {
                    Text(model.phase == .loaded ? "No open tasks." : " ").foregroundStyle(.secondary)
                }
                ForEach(model.tasks, id: \.noteId) { task in
                    HStack(alignment: .firstTextBaseline) {
                        Image(systemName: "circle").foregroundStyle(.secondary).accessibilityHidden(true)
                        Text(task.title)
                        Spacer()
                        if let due = task.due, !due.isEmpty {
                            Text(due.prefix(10)).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                        }
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("Task: \(task.title)\(task.due.map { ", due \($0.prefix(10))" } ?? "")")
                }
            }
        }
        .navigationTitle(Date.now.formatted(.dateTime.weekday(.wide).month().day()))
        .refreshable { await model.refresh() }
        .toolbar {
            ToolbarItem {
                Button {
                    Task { await model.refresh() }
                } label: {
                    Label("Refresh", systemImage: "arrow.clockwise")
                }
            }
        }
        .task { await model.refresh() }
    }
}

/// Recurring jobs: what runs on a schedule, with pause and resume.
struct JobsView: View {
    let model: JobsModel

    var body: some View {
        List {
            if let failure = model.phase.failure {
                Section {
                    Label(failure, systemImage: "wifi.exclamationmark").foregroundStyle(.secondary)
                    Button("Try Again") { Task { await model.refresh() } }
                }
            }
            if let problem = model.actionProblem {
                Label(problem, systemImage: "exclamationmark.triangle").foregroundStyle(.secondary)
            }
            if model.phase == .loaded, model.jobs.isEmpty {
                Text("No recurring jobs.").foregroundStyle(.secondary)
            }
            ForEach(model.jobs) { job in
                JobRow(job: job, busy: model.busyJobID == job.id) {
                    Task { await model.toggle(job) }
                }
            }
        }
        .navigationTitle("Recurring")
        .refreshable { await model.refresh() }
        .toolbar {
            ToolbarItem {
                Button {
                    Task { await model.refresh() }
                } label: {
                    Label("Refresh", systemImage: "arrow.clockwise")
                }
            }
        }
        .task { await model.refresh() }
    }
}

struct JobRow: View {
    let job: OmniJob
    let busy: Bool
    let toggle: () -> Void

    var body: some View {
        let paused = JobPresentation.isPaused(job)
        HStack(alignment: .center, spacing: 10) {
            Image(systemName: paused ? "pause.circle" : "arrow.triangle.2.circlepath")
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(JobPresentation.name(job)).foregroundStyle(paused ? .secondary : .primary)
                Text(details(paused)).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                if let error = job.lastError, !error.isEmpty {
                    Text(error).font(.caption).foregroundStyle(.orange).lineLimit(2)
                }
            }
            Spacer(minLength: 8)
            if busy {
                ProgressView().controlSize(.small).accessibilityLabel("Working")
            } else {
                Button(paused ? "Resume" : "Pause", action: toggle)
                    .controlSize(.small)
                    .accessibilityLabel("\(paused ? "Resume" : "Pause") \(JobPresentation.name(job))")
            }
        }
    }

    private func details(_ paused: Bool) -> String {
        var parts: [String] = []
        if paused { parts.append("Paused") }
        if let schedule = JobPresentation.schedule(job) { parts.append(schedule) }
        if !paused, let next = JobPresentation.date(job.nextRunAt) {
            parts.append("next \(next.formatted(date: .abbreviated, time: .shortened))")
        }
        if let last = JobPresentation.lastRun(job) { parts.append(last) }
        return parts.joined(separator: " · ")
    }
}
