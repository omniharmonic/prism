import OmniClient
import OmniCore
import SwiftUI

/// Today: what is next, what needs a decision, what Omni is working on, today's tasks.
/// A short read-only list (product-spec.md § 8a).
struct TodayView: View {
    let session: SessionModel
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.navigator) private var navigator

    var body: some View {
        let model = session.today
        List {
            if let failure = model.phase.failure {
                Section {
                    Label(failure, systemImage: "wifi.exclamationmark").foregroundStyle(Color.quietText)
                    Button("Try Again") { Task { await model.refresh() } }
                        .disabled(model.isRefreshing)
                }
            }
            if model.phase == .loading {
                // The first read can take a few seconds (the server reads the calendar and tasks).
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Loading Today…").foregroundStyle(Color.quietText)
                        Text("The server is reading your calendar and tasks. The first read of the day can take a little while.")
                            .font(.caption)
                            .foregroundStyle(Color.quietText)
                    }
                }
                .accessibilityElement(children: .combine)
            }
            if let notice = model.partialNotice {
                Section {
                    Label(notice, systemImage: "exclamationmark.triangle").foregroundStyle(Color.quietText)
                    Button(model.isRefreshing ? "Trying…" : "Try Again") { Task { await model.refresh() } }
                        .disabled(model.isRefreshing)
                        .accessibilityHint("Reads Today again")
                }
            }
            if model.hasContent {
            Section("Next") {
                if let problem = model.sectionProblems["agenda"] {
                    Text(problem).foregroundStyle(Color.quietText)
                } else if model.agenda.isEmpty {
                    Text("Nothing on the calendar today.").foregroundStyle(Color.quietText)
                }
                ForEach(model.agenda, id: \.noteId) { item in
                    // The time beside the title; above it at the accessibility text sizes, where
                    // a column for the time would break "9:30 AM" in two.
                    let large = typeSize.isAccessibilitySize
                    let row = large ? AnyLayout(VStackLayout(alignment: .leading, spacing: 2)) : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 10))
                    row {
                        Text(TodayModel.timeText(item.start) ?? "All day")
                            .font(.callout.monospacedDigit())
                            .foregroundStyle(Color.quietText)
                            .fixedSize()
                            .frame(minWidth: large ? nil : 64, alignment: .leading)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.title)
                            if let location = item.location, !location.isEmpty {
                                Text(location).font(.caption).foregroundStyle(Color.quietText).lineLimit(large ? 3 : 1)
                            }
                        }
                    }
                    .accessibilityElement(children: .combine)
                }
            }
            Section("Needs you") {
                let ids = model.approvalIDs.filter { session.approvals.card(for: $0)?.approval.status == .pending }
                if ids.isEmpty {
                    Text("Nothing needs a decision.").foregroundStyle(Color.quietText)
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
                    Text("Nothing in flight.").foregroundStyle(Color.quietText)
                }
                ForEach(model.inFlight, id: \.id) { item in
                    Button {
                        navigator.open(.thread(item.id))
                    } label: {
                        HStack {
                            Label(item.title ?? "Untitled thread", systemImage: StateStyle.symbol(item.state ?? .working))
                            Spacer()
                            if let state = item.state {
                                Text(ThreadGrouping.title(for: state)).font(.caption).foregroundStyle(Color.quietText)
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
                    Text(problem).foregroundStyle(Color.quietText)
                } else if model.tasks.isEmpty {
                    Text("No open tasks.").foregroundStyle(Color.quietText)
                }
                ForEach(model.tasks, id: \.noteId) { task in
                    HStack(alignment: .firstTextBaseline) {
                        Image(systemName: "circle").foregroundStyle(Color.quietText).accessibilityHidden(true)
                        Text(task.title)
                        Spacer()
                        if let due = TodayModel.dueText(task.due) ?? task.due.flatMap({ $0.isEmpty ? nil : String($0.prefix(10)) }) {
                            Text(due).font(.caption).foregroundStyle(Color.quietText)
                        }
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("Task: \(task.title)\((TodayModel.dueText(task.due) ?? task.due).map { ", due \($0)" } ?? "")")
                }
            }
            }
        }
        .navigationTitle(Date.now.formatted(.dateTime.weekday(.wide).month().day()))
        .refreshable { await model.refresh() }
        .toolbar {
            ToolbarItem {
                if model.isRefreshing, model.hasContent {
                    ProgressView().controlSize(.small).accessibilityLabel("Refreshing")
                } else {
                    Button {
                        Task { await model.refresh() }
                    } label: {
                        Label("Refresh", systemImage: "arrow.clockwise")
                    }
                    .help("Refresh (⌘R)")
                }
            }
        }
        .task { await model.refresh() }
    }
}

/// Recurring jobs: what runs on a schedule, with pause and resume.
struct JobsView: View {
    let model: JobsModel
    @State private var adding = false
    @State private var editing: OmniJob?

    var body: some View {
        List {
            if let failure = model.phase.failure {
                Section {
                    Label(failure, systemImage: "wifi.exclamationmark").foregroundStyle(Color.quietText)
                    Button("Try Again") { Task { await model.refresh() } }
                }
            }
            if let problem = model.actionProblem {
                Label(problem, systemImage: "exclamationmark.triangle").foregroundStyle(Color.quietText)
            }
            if model.phase == .loading, model.jobs.isEmpty {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Loading recurring jobs…").foregroundStyle(Color.quietText)
                }
                .accessibilityElement(children: .combine)
            }
            if model.phase == .loaded, model.jobs.isEmpty {
                Text("No recurring jobs.").foregroundStyle(Color.quietText)
            }
            ForEach(model.jobs) { job in
                VStack(alignment: .leading, spacing: 8) {
                    JobRow(job: job, busy: model.busyJobID == job.id) {
                        Task { await model.toggle(job) }
                    }
                    if model.canManage {
                        Button(job.noAgent == true || job.script != nil || job.monitorScript != nil || (job.monitor != nil && job.monitor?.isNull != true) ? "View Script Schedule" : "Edit Job") { editing = job }
                            .accessibilityLabel("View \(JobPresentation.name(job))")
                    }
                }
            }
        }
        .navigationTitle("Recurring")
        .sheet(isPresented: $adding) { JobEditor(model: model, job: nil) }
        .sheet(item: $editing) { JobEditor(model: model, job: $0) }
        .toolbar { if model.canManage { Button("Add Job", systemImage: "plus") { adding = true } } }
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
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let paused = JobPresentation.isPaused(job)
        // The button beside the text; under it at the accessibility text sizes, where side by
        // side leaves the name a column one syllable wide.
        let row = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8)) : AnyLayout(HStackLayout(alignment: .center, spacing: 10))
        row {
            Image(systemName: paused ? "pause.circle" : "arrow.triangle.2.circlepath")
                .foregroundStyle(Color.quietText)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(JobPresentation.name(job)).foregroundStyle(paused ? Color.quietText : Color.primary)
                Text(details(paused)).font(.caption).foregroundStyle(Color.quietText).fixedSize(horizontal: false, vertical: true)
                if let error = job.lastError, !error.isEmpty {
                    Text(error).font(.caption).foregroundStyle(Color.warningText).fixedSize(horizontal: false, vertical: true)
                }
            }
            .accessibilityElement(children: .combine)
            if !typeSize.isAccessibilitySize { Spacer(minLength: 8) }
            if busy {
                ProgressView().controlSize(.small).accessibilityLabel("Working")
            } else {
                Button(paused ? "Resume" : "Pause", action: toggle)
                    #if os(iOS)
                    .buttonStyle(.bordered) // its own target: a tap on the row's text pauses nothing
                    #else
                    .controlSize(.small)
                    #endif
                    .fixedSize()
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
