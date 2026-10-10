@preconcurrency import AVFoundation
import FluidAudio
import Foundation

/// Both engines receive the identical captured audio at its original wall-clock pace.
/// Model preparation is excluded from latency. No recording is sent over the network.
enum Replay {
    static func buffer(samples: [Float], format: AVAudioFormat) throws -> AVAudioPCMBuffer {
        let sourceFormat = AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1)!
        let source = AVAudioPCMBuffer(pcmFormat: sourceFormat, frameCapacity: AVAudioFrameCount(samples.count))!
        source.frameLength = source.frameCapacity
        samples.withUnsafeBufferPointer { source.floatChannelData![0].update(from: $0.baseAddress!, count: samples.count) }
        guard format != sourceFormat else { return source }
        guard let converter = AVAudioConverter(from: sourceFormat, to: format),
              let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(Double(samples.count) * format.sampleRate / 16_000 + 32)) else {
            throw VoiceFailure.unavailable("The speech audio format cannot be converted on this device.")
        }
        var supplied = false
        var error: NSError?
        converter.convert(to: output, error: &error) { _, status in
            if supplied { status.pointee = .endOfStream; return nil }
            supplied = true; status.pointee = .haveData; return source
        }
        if let error { throw error }
        return output
    }
    static func samples(_ file: URL) throws -> [Float] {
        let values = try AudioConverter().resampleAudioFile(file)
        guard !values.isEmpty, values.count <= 16_000 * 120 else { throw VoiceFailure.unavailable("Record between one and 120 seconds for each benchmark utterance.") }
        return values
    }
}
actor HypothesisCollector {
    private var stabiliser = TranscriptStabiliser()
    private var first: Double?
    private let started: ContinuousClock.Instant
    init(started: ContinuousClock.Instant) { self.started = started }
    func accept(_ event: TranscriptEvent) {
        stabiliser.update(confirmed: event.confirmed, volatile: event.volatile)
        if first == nil, !stabiliser.text.isEmpty { first = milliseconds(started.duration(to: .now)) }
    }
    func result(engine: String, final: String?, speechEnd: Double) -> EngineResult {
        EngineResult(engine: engine, text: final ?? stabiliser.text, firstWordMilliseconds: first,
                     finalMilliseconds: max(0, milliseconds(started.duration(to: .now)) - speechEnd * 1000))
    }
}
func milliseconds(_ duration: Duration) -> Double {
    let values = duration.components
    return Double(values.seconds) * 1000 + Double(values.attoseconds) / 1e15
}
