import OmniClient
import OmniCore
import SwiftUI

struct SkillsView: View {
    let model: SkillsModel
    var body: some View {
        List {
            if model.phase == .loading && model.items.isEmpty { ProgressView().accessibilityLabel("Loading skills") }
            if let failure=model.phase.failure {
                Text(failure).foregroundStyle(Color.warningText)
                Button("Try Again") {Task{await model.refresh()}}
            }
            if model.phase == .loaded && model.items.isEmpty {Text("No installed skills.").foregroundStyle(.secondary)}
            ForEach(model.items) {skill in
                NavigationLink {SkillEditor(model:model,summary:skill)} label: {
                    VStack(alignment:.leading,spacing:4) {
                        Text(skill.name)
                        Text(skill.location).font(.caption).foregroundStyle(.secondary)
                        if !skill.editable {Label("Read-only source",systemImage:"lock").font(.caption).foregroundStyle(.secondary)}
                    }
                }
            }
        }
        .navigationTitle("Skills")
        .task {await model.refresh()}
        .refreshable {await model.refresh()}
    }
}
private struct SkillEditor: View {
    let model: SkillsModel
    let summary: OmniSkill
    @State private var loaded: OmniSkill?
    @State private var draft=""
    @State private var loading=true
    @State private var reloadConfirmation=false
    var body: some View {
        Form {
            Section {
                Text(summary.location).font(.caption).foregroundStyle(.secondary)
                if loading {ProgressView().accessibilityLabel("Loading skill")}
                if let loaded {
                    if let reason=loaded.reason {Text(reason).foregroundStyle(.secondary)}
                    if let text=loaded.text {
                        if loaded.editable {
                            TextEditor(text:$draft).font(.body.monospaced()).frame(minHeight:300)
                                .accessibilityLabel("Skill instructions")
                        } else {Text(text).font(.body.monospaced()).textSelection(.enabled)}
                    }
                }
                if let problem=model.problem {Text(problem).foregroundStyle(Color.warningText)}
                Button("Reload Current Version") {
                    if loaded?.text != draft && loaded?.editable == true {reloadConfirmation=true}
                    else {Task{await reload()}}
                }.disabled(model.busy || loading)
            }
            Section {
                Text("Only this SKILL.md is saved. Other files are preserved. Linked repository skills are read-only.").font(.caption).foregroundStyle(.secondary)
            }
        }
        .navigationTitle(summary.name)
        .scrollDismissesKeyboard(.interactively)
        .task(id:summary.id) {await reload()}
        .toolbar {
            if loaded?.editable == true {
                Button("Save") {
                    Task {
                        guard let loaded,let updated=await model.save(loaded,text:draft) else {return}
                        self.loaded=updated;draft=updated.text ?? draft
                    }
                }.disabled(model.busy || loading || draft == loaded?.text || draft.utf8.count > 65536)
            }
        }
        .confirmationDialog("Reload and discard your unsaved draft?",isPresented:$reloadConfirmation,titleVisibility:.visible) {
            Button("Reload",role:.destructive){Task{await reload()}}
        }
    }
    private func reload() async {
        loading=true;defer{loading=false}
        if let value=await model.read(summary.id){loaded=value;draft=value.text ?? ""}
    }
}
