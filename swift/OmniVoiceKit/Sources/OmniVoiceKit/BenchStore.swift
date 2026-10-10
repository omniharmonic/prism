import Foundation
import Observation

public struct BenchUtterance: Codable, Identifiable, Sendable {
    public let id: UUID
    public let condition: SpeechCondition
    public let filename: String
    public var reference: String
    public var results: [EngineResult]
    public var evaluatedVocabulary: [String] = []
}

@MainActor @Observable public final class BenchStore {
    public private(set) var utterances: [BenchUtterance] = []
    public var vocabulary = ["Benjamin Life", "Omniharmonic", "Prism", "Hermes", "Parachute", "Dana", "Kevin", "Tim"] { didSet { prepared = false; try? JSONEncoder().encode(vocabulary).write(to: directory.appending(path: "vocabulary.json"), options: .atomic) } }
    public private(set) var recording = false
    public private(set) var busy = false
    public private(set) var prepared = false
    public private(set) var status = "Recordings and transcripts stay on this device. Prepare downloads local speech models; it does not upload audio."
    public private(set) var liveTranscript = ""
    private let directory: URL
    private let audio = AudioIO()
    private let vad = SileroVAD()
    private let engines: [any STTEngine] = [AppleTranscriber(), ParakeetTranscriber()]
    private var readyEngines: [any STTEngine] = []
    private var pending: BenchUtterance?
    private var stopTimer: Task<Void, Never>?
    public init() {
        directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appending(path: "OmniSpeechBench", directoryHint: .isDirectory)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            var local = directory; var values = URLResourceValues(); values.isExcludedFromBackup = true; try local.setResourceValues(values)
            if let seeds = try? Data(contentsOf: directory.appending(path: "vocabulary.json")) { vocabulary = try JSONDecoder().decode([String].self, from: seeds) }
            if let data = try? Data(contentsOf: directory.appending(path: "set.json")) { utterances = try JSONDecoder().decode([BenchUtterance].self, from: data) }
        } catch { status = "The local benchmark folder could not be opened." }
    }
    public func probe() async -> [String] {
        var lines: [String] = []
        for engine in engines { lines.append(await engine.availability() ?? "\(engine.name): supported; local models require preparation.") }
        return lines
    }
    public func prepare() async {
        guard !busy, !recording else { return }
        busy = true; defer { busy = false }
        prepared = false; readyEngines = []
        status = "Preparing local models. This may download large model files."
        do {
            try await vad.prepare()
            var failures: [String] = []
            for engine in engines {
                if let unavailable = await engine.availability() { failures.append(unavailable); continue }
                do { try await engine.prepare(vocabulary: vocabulary); readyEngines.append(engine) }
                catch { failures.append("\(engine.name): \(error.localizedDescription)") }
            }
            prepared = !readyEngines.isEmpty
            status = (["Ready engines: " + readyEngines.map(\.name).joined(separator: ", ")] + failures).joined(separator: "\n")
        } catch { status = error.localizedDescription }
    }
    public func start(condition: SpeechCondition) async {
        guard !busy, !recording else { return }
        let id = UUID(), filename = "\(UUID().uuidString).caf"
        do {
            try await audio.start(url: directory.appending(path: filename))
            pending = BenchUtterance(id: id, condition: condition, filename: filename, reference: "", results: [])
            recording = true; status = "Recording. Stop after the utterance, then correct the reference once."
            stopTimer = Task { try? await Task.sleep(for: .seconds(120)); if !Task.isCancelled { stop() } }
        } catch { status = error.localizedDescription; try? FileManager.default.removeItem(at: directory.appending(path: filename)) }
    }
    public func stop() {
        guard recording else { return }
        stopTimer?.cancel(); stopTimer = nil; recording = false
        do {
            try audio.stop()
            if let pending {
                #if os(iOS)
                try FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: directory.appending(path: pending.filename).path)
                #endif
                utterances.append(pending); try persist()
            }
            status = "Add the exact words you said, then run both engines."
        } catch { status = error.localizedDescription }
        pending = nil
    }
    public func updateReference(id: UUID, text: String) {
        guard let index = utterances.firstIndex(where: { $0.id == id }) else { return }
        utterances[index].reference = text
        do { try persist() } catch { status = error.localizedDescription }
    }
    public func evaluate(id: UUID) async {
        guard prepared, !busy, !recording, let index = utterances.firstIndex(where: { $0.id == id }) else { return }
        guard !utterances[index].reference.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { status = "Correct the ground truth before evaluating."; return }
        busy = true; defer { busy = false; liveTranscript = "" }
        let file = directory.appending(path: utterances[index].filename)
        do {
            let end = try await vad.speechEnd(file: file)
            var results: [EngineResult] = []
            for engine in readyEngines {
                status = "Replaying identical audio locally: \(engine.name)"
                let result = try await engine.transcribe(file: file, speechEnd: end) { [weak self] event in
                    await self?.show(event)
                }
                results.append(result)
            }
            utterances[index].results = results; utterances[index].evaluatedVocabulary = vocabulary; try persist(); status = "Finished. Compare the transcript and per-engine report."
        } catch { status = error.localizedDescription }
    }
    private func show(_ event: TranscriptEvent) { liveTranscript = [event.confirmed, event.volatile].filter { !$0.isEmpty }.joined(separator: " ") }
    public func delete(id: UUID) {
        guard !busy, !recording, let item = utterances.first(where: { $0.id == id }) else { return }
        do { try FileManager.default.removeItem(at: directory.appending(path: item.filename)); utterances.removeAll { $0.id == id }; try persist() }
        catch { status = error.localizedDescription }
    }
    private func persist() throws { try JSONEncoder().encode(utterances).write(to: directory.appending(path: "set.json"), options: [.atomic]) }
}
