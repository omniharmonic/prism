import OmniClient
import OmniCore
import PrismTransport
import SwiftUI

struct JobEditor: View {
    let model: JobsModel
    let job: OmniJob?
    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var schedule: String
    @State private var prompt: String
    @State private var key = IdempotencyKey.random()
    @State private var confirmDelete = false
    private var scriptJob: Bool { job?.noAgent == true || job?.script != nil || job?.monitorScript != nil || (job?.monitor != nil && job?.monitor?.isNull != true) }
    init(model: JobsModel, job: OmniJob?) {
        self.model = model; self.job = job
        _name = State(initialValue: job.map(JobPresentation.name) ?? "")
        let raw = job?.schedule
        _schedule = State(initialValue: raw?.stringValue ?? raw?["expr"]?.stringValue ?? raw?["value"]?.stringValue ?? "0 8 * * *")
        _prompt = State(initialValue: job?.prompt ?? "")
    }
    var body: some View {
        NavigationStack {
            Form {
                if scriptJob {
                    Section {
                        Text("Script job").font(.headline)
                        Text("This existing runner is read-only. You can pause, resume or delete its schedule from Recurring.").foregroundStyle(.secondary)
                        Text(name)
                        Text(JobPresentation.schedule(job!) ?? "Schedule unavailable")
                    }
                } else {
                    Section("Agent job") {
                        TextField("Name", text: $name)
                        TextField("Schedule (cron or interval)", text: $schedule)
                        TextField("Instructions", text: $prompt, axis: .vertical).lineLimit(5...12)
                    }
                    Section {
                        if let job {
                            Text("Delivery: \(job.deliver?.stringValue ?? job.deliver?.canonicalJSON ?? "not reported")")
                            Text("Editing these fields preserves delivery, skills and other runner settings.").foregroundStyle(.secondary)
                        } else {
                            Text("Runs locally. Outward actions become drafts for your approval.").foregroundStyle(.secondary)
                        }
                    }
                }
                if let problem = model.actionProblem { Text(problem).foregroundStyle(Color.warningText) }
                if let job {
                    Section {
                        if !scriptJob {
                            Button("Run Now") { Task { await model.run(job) } }
                                .disabled(model.busyJobID != nil)
                            Text("Run Now dispatches a background run; it does not confirm completion.").font(.caption).foregroundStyle(.secondary)
                        }
                        Button("Delete Schedule", role: .destructive) { confirmDelete = true }
                    }
                }
            }
            .navigationTitle(job == nil ? "New Recurring Job" : "Recurring Job")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
                if !scriptJob {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Save") {
                            Task {
                                let new = NewJob(name: name, schedule: schedule, prompt: prompt, deliver: job == nil ? "local" : nil)
                                if await model.save(new: new, key: key, editing: job) { dismiss() }
                            }
                        }
                        .disabled(model.busyJobID != nil || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || schedule.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || (job == nil && prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
                    }
                }
            }
            .confirmationDialog("Delete this recurring schedule? Its conversation and history will remain.", isPresented: $confirmDelete, titleVisibility: .visible) {
                if let job { Button("Delete Schedule", role: .destructive) { Task { if await model.remove(job) { dismiss() } } } }
            }
        }
    }
}
