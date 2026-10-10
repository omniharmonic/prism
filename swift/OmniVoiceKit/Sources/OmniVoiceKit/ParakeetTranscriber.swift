@preconcurrency import AVFoundation
import FluidAudio
import Foundation

public actor ParakeetTranscriber: STTEngine {
    public nonisolated let name = "Parakeet 0.6B (FluidAudio)"
    private var models: AsrModels?
    private var ctc: CtcModels?
    private var vocabulary: [String] = []
    public init() {}
    public func availability() async -> String? { nil }
    public func prepare(vocabulary: [String]) async throws {
        let models = try await AsrModels.downloadAndLoad(version: .v2)
        let ctc = vocabulary.isEmpty ? nil : try await CtcModels.downloadAndLoad()
        self.models = models; self.ctc = ctc; self.vocabulary = vocabulary
    }

    public func transcribe(file: URL, speechEnd: Double, update: @escaping @Sendable (TranscriptEvent) async -> Void) async throws -> EngineResult {
        guard let models else { throw VoiceFailure.notPrepared }
        // A SlidingWindow manager owns a one-shot input stream. Use a fresh session for
        // every utterance while retaining the already-loaded model objects.
        let manager = SlidingWindowAsrManager()
        try await manager.loadModels(models)
        if let ctc {
            try await manager.configureVocabularyBoosting(
                vocabulary: CustomVocabularyContext(terms: vocabulary.map { CustomVocabularyTerm(text: $0) }), ctcModels: ctc)
        }
        let samples = try Replay.samples(file)
        try await manager.reset()
        let stream = await manager.transcriptionUpdates
        try await manager.startStreaming(source: .system)
        let started = ContinuousClock.now
        let collector = HypothesisCollector(started: started)
        let results = Task {
            for await _ in stream {
                let event = await TranscriptEvent(confirmed: manager.confirmedTranscript, volatile: manager.volatileTranscript)
                await collector.accept(event); await update(event)
            }
        }
        do {
            let format = AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1)!
            for offset in stride(from: 0, to: samples.count, by: 1600) {
                try Task.checkCancellation()
                let chunk = Array(samples[offset..<min(offset + 1600, samples.count)])
                await manager.streamAudio(try Replay.buffer(samples: chunk, format: format))
                try await Task.sleep(for: .seconds(Double(chunk.count) / 16_000))
            }
            let final = try await manager.finish()
            let answer = await collector.result(engine: name, final: final, speechEnd: speechEnd)
            await manager.cancel()
            await results.value
            return answer
        } catch { results.cancel(); await manager.cancel(); throw error }
    }
}
