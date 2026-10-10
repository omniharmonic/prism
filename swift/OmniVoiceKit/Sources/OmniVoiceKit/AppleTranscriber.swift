@preconcurrency import AVFoundation
import Speech
import Foundation

public actor AppleTranscriber: ConversationSTTEngine {
    public nonisolated let name = "Apple SpeechAnalyzer"
    private var vocabulary: [String] = []
    private var locale: Locale?
    public init() {}
    public func availability() async -> String? {
        guard SpeechTranscriber.isAvailable else { return "Apple on-device SpeechTranscriber is unavailable on this device." }
        guard await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: "en-US")) != nil else {
            return "Apple on-device English transcription is unavailable."
        }
        return nil
    }
    public func prepare(vocabulary: [String]) async throws {
        if let reason = await availability() { throw VoiceFailure.unavailable(reason) }
        guard await Self.permission() else { throw VoiceFailure.permission }
        guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: "en-US")) else { throw VoiceFailure.notPrepared }
        let transcriber = SpeechTranscriber(locale: locale, preset: .progressiveTranscription)
        if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) { try await request.downloadAndInstall() }
        self.locale = locale; self.vocabulary = vocabulary
    }
    private static func permission() async -> Bool {
        await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0 == .authorized) }
        }
    }
    public func transcribe(file: URL, speechEnd: Double, update: @escaping @Sendable (TranscriptEvent) async -> Void) async throws -> EngineResult {
        try await transcribe(file: file, speechEnd: speechEnd, paced: true, update: update)
    }
    /// Conversation input is already captured; feed it without benchmark replay delays.
    public func transcribeConversation(file: URL, update: @escaping @Sendable (TranscriptEvent) async -> Void) async throws -> String {
        try await transcribe(file: file, speechEnd: 0, paced: false, update: update).text
    }
    private func transcribe(file: URL, speechEnd: Double, paced: Bool, update: @escaping @Sendable (TranscriptEvent) async -> Void) async throws -> EngineResult {
        guard let locale else { throw VoiceFailure.notPrepared }
        let transcriber = SpeechTranscriber(locale: locale, preset: .progressiveTranscription)
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        let context = AnalysisContext(); context.contextualStrings[.general] = vocabulary
        try await analyzer.setContext(context)
        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else { throw VoiceFailure.notPrepared }
        let samples = try Replay.samples(file)
        try await analyzer.prepareToAnalyze(in: format)
        let started = ContinuousClock.now
        let collector = HypothesisCollector(started: started)
        let results = Task {
            var confirmed = ""
            for try await result in transcriber.results {
                let text = String(result.text.characters)
                if result.isFinal { confirmed = [confirmed, text].filter { !$0.isEmpty }.joined(separator: " ") }
                let event = TranscriptEvent(confirmed: confirmed, volatile: result.isFinal ? "" : text)
                await collector.accept(event); await update(event)
            }
        }
        let (input, continuation) = AsyncStream<AnalyzerInput>.makeStream()
        do {
            // Apple's autonomous start returns immediately; unlike analyzeSequence,
            // it does not wait for the producer to finish supplying input.
            try await analyzer.start(inputSequence: input)
            for offset in stride(from: 0, to: samples.count, by: 1600) {
                try Task.checkCancellation()
                let chunk = Array(samples[offset..<min(offset + 1600, samples.count)])
                continuation.yield(AnalyzerInput(buffer: try Replay.buffer(samples: chunk, format: format)))
                if paced { try await Task.sleep(for: .seconds(Double(chunk.count) / 16_000)) }
            }
            continuation.finish()
            try await analyzer.finalizeAndFinishThroughEndOfInput()
            try await results.value
            return await collector.result(engine: name, final: nil, speechEnd: speechEnd)
        } catch {
            continuation.finish(); results.cancel(); await analyzer.cancelAndFinishNow(); throw error
        }
    }
}
