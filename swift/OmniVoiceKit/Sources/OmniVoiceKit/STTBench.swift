import SwiftUI

public struct STTBench: View {
    @State private var store = BenchStore()
    @State private var availability: [String] = []
    @Environment(\.scenePhase) private var phase
    @State private var condition: SpeechCondition = .quiet
    public init() {}
    public var body: some View {
        List {
            Section("Local speech benchmark") {
                Text(store.status).font(.callout)
                ForEach(availability, id: \.self) { Text($0).font(.footnote) }
                Text("Aim for 20 corrected utterances in each setting (60 total). Include your names and organisations. Never record while driving.").font(.footnote)
                Button("Prepare Local Models") { Task { await store.prepare() } }
                    .disabled(store.busy || store.recording)
                TextField("Names and organisations, comma separated", text: Binding(
                    get: { store.vocabulary.joined(separator: ", ") },
                    set: { store.vocabulary = $0.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty } }))
                    .disabled(store.busy || store.recording)
                Text("After changing vocabulary, prepare again before benchmarking.").font(.footnote)
                Picker("Recording setting", selection: $condition) {
                    ForEach(SpeechCondition.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                }
                if store.recording { Button("Stop Recording") { store.stop() } }
                else { Button("Record Utterance") { Task { await store.start(condition: condition) } }.disabled(store.busy) }
                if !store.liveTranscript.isEmpty { Text(store.liveTranscript).textSelection(.enabled) }
            }
            Section("Report") {
                Text("\(store.utterances.filter { !$0.reference.isEmpty }.count)/60 corrected utterances. Personal acceptance is pending until the complete set is recorded and reviewed.")
                ForEach(SpeechCondition.allCases, id: \.self) { condition in
                    let items = store.utterances.filter { $0.condition == condition && !$0.reference.isEmpty }
                    Text("\(condition.rawValue): \(items.count)/20 corrected").font(.headline)
                    ForEach(Array(Set(items.flatMap { $0.results.map(\.engine) })).sorted(), id: \.self) { engine in
                        Text(report(items, engine: engine)).font(.callout).textSelection(.enabled)
                    }
                }
                Text("Targets: quiet WER ≤5%, seeded name error ≤5%, and no worse than Apple in every setting. Missing engine results are not a pass.").font(.footnote)
            }
            ForEach(store.utterances) { item in
                Section("\(item.condition.rawValue) · \(item.id.uuidString.prefix(8))") {
                    TextField("Corrected words you actually said", text: Binding(
                        get: { store.utterances.first(where: { $0.id == item.id })?.reference ?? "" },
                        set: { store.updateReference(id: item.id, text: $0) }), axis: .vertical)
                        .disabled(store.busy || store.recording)
                    Button("Run Both Engines") { Task { await store.evaluate(id: item.id) } }
                        .disabled(!store.prepared || store.busy || store.recording)
                    ForEach(item.results, id: \.engine) { result in
                        Text(result.engine).font(.headline)
                        Text(result.text).textSelection(.enabled)
                    }
                    Button("Delete Recording and Transcript", role: .destructive) { store.delete(id: item.id) }
                        .disabled(store.busy || store.recording)
                }
            }
        }
        .navigationTitle("Speech Benchmark")
        .task { availability = await store.probe() }
        .onDisappear { if store.recording { store.stop() } }
        .onChange(of: phase) { _, phase in
            #if os(macOS)
            if phase != .active && store.recording { store.stop() }
            #else
            if phase == .background && store.recording { store.stop() }
            #endif
        }
    }
    private func report(_ items: [BenchUtterance], engine: String) -> String {
        var errors = 0, words = 0, nameErrors = 0, names = 0
        var first: [Double] = [], final: [Double] = []
        for item in items {
            guard let result = item.results.first(where: { $0.engine == engine }) else { continue }
            let reference = BenchMetrics.words(item.reference)
            words += reference.count; errors += BenchMetrics.distance(reference, BenchMetrics.words(result.text))
            let name = BenchMetrics.nameCounts(reference: item.reference, hypothesis: result.text, vocabulary: item.evaluatedVocabulary)
            names += name.count; nameErrors += name.errors
            if let time = result.firstWordMilliseconds { first.append(time) }; final.append(result.finalMilliseconds)
        }
        func mean(_ values: [Double]) -> String { values.isEmpty ? "unavailable" : String(format: "%.0f ms", values.reduce(0, +) / Double(values.count)) }
        let wer = words > 0 ? String(format: "%.1f%%", Double(errors) / Double(words) * 100) : "unavailable"
        let nameRate = names > 0 ? String(format: "%.1f%%", Double(nameErrors) / Double(names) * 100) : "no reference names"
        return "\(engine): WER \(wer), names \(nameRate); mean first word \(mean(first)), speech-end → final \(mean(final)). \(final.count)/\(items.count) results."
    }
}
