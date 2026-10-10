@preconcurrency import AVFoundation
import Foundation
import FluidAudio

public enum SpeechActivityEvent: Sendable {
    case frame(audioTime: Double, capturedAt: Double, duration: Double, isSpeech: Bool)
    case unavailable(String)
}

/// The realtime tap only copies bounded scalar PCM into a bounded stream. Model
/// inference and resampling run in a detached worker; no AVAudioPCMBuffer escapes.
final class LocalSpeechActivity: @unchecked Sendable {
    struct PCM: Sendable { let samples: [Float]; let rate: Double; let capturedAt: Double }
    private let lock = NSLock()
    private var stopped = false
    private var worker: Task<Void, Never>?
    private let continuation: AsyncStream<PCM>.Continuation
    private let receive: @Sendable (SpeechActivityEvent) -> Void

    convenience init(manager: VadManager, receive: @escaping @Sendable (SpeechActivityEvent) -> Void) {
        self.init(process: { chunk, state in try await manager.processStreamingChunk(chunk, state: state) }, receive: receive)
    }
    init(process: @escaping @Sendable ([Float], VadStreamState) async throws -> VadStreamResult,
         receive: @escaping @Sendable (SpeechActivityEvent) -> Void) {
        self.receive = receive
        let (stream, continuation) = AsyncStream<PCM>.makeStream(bufferingPolicy: .bufferingNewest(16))
        self.continuation = continuation
        worker = Task.detached(priority: .userInitiated) { [weak self] in
            guard let self else { return }
            let converter = ActivityResampler()
            var state = VadStreamState.initial()
            var pending: [Float] = []
            var previousCapture: Double?
            do {
                for await pcm in stream {
                    guard !Task.isCancelled, self.isActive else { return }
                    let inputDuration = Double(pcm.samples.count) / pcm.rate
                    // Gaps or stalled audio never become evidence of silence.
                    if let previousCapture, pcm.capturedAt - previousCapture > inputDuration + 0.15 {
                        self.stop(reason: "Automatic detection lost audio continuity. Use Send turn."); return
                    }
                    previousCapture = pcm.capturedAt
                    let values = try converter.convert(pcm.samples, rate: pcm.rate)
                    guard values.count <= 8192, pending.count + values.count <= 16_384 else {
                        self.stop(reason: "Automatic detection reached its audio buffer limit. Use Send turn."); return
                    }
                    pending += values
                    while pending.count >= VadManager.chunkSize {
                        let chunk = Array(pending.prefix(VadManager.chunkSize))
                        pending.removeFirst(VadManager.chunkSize)
                        let capturedAt = pcm.capturedAt - Double(pending.count) / 16_000
                        guard ProcessInfo.processInfo.systemUptime - capturedAt <= 0.5 else {
                            self.stop(reason: "Automatic detection fell behind. Use Send turn."); return
                        }
                        let result = try await process(chunk, state)
                        state = result.state
                        guard !Task.isCancelled, self.isActive else { return }
                        // Low-confidence speech cancels endpoints conservatively; silence
                        // hysteresis is not counted as observed speech for the minimum.
                        self.receive(.frame(audioTime: Double(state.processedSamples) / 16_000,
                                            capturedAt: capturedAt,
                                            duration: Double(VadManager.chunkSize) / 16_000,
                                            isSpeech: result.probability >= 0.5))
                    }
                }
            } catch {
                if !Task.isCancelled { self.stop(reason: "Automatic speech detection failed. Use Send turn.") }
            }
        }
    }
    private var isActive: Bool { lock.lock(); defer { lock.unlock() }; return !stopped }
    nonisolated func append(_ buffer: AVAudioPCMBuffer) {
        guard isActive else { return }
        let frames = Int(buffer.frameLength), channels = Int(buffer.format.channelCount)
        guard frames > 0, frames <= 4096, channels > 0, channels <= 8,
              buffer.format.sampleRate >= 8_000, buffer.format.sampleRate <= 192_000,
              let data = buffer.floatChannelData else {
            stop(reason: "Automatic detection cannot read this microphone format. Use Send turn."); return
        }
        var mono = [Float](repeating: 0, count: frames)
        for frame in 0..<frames {
            var value: Float = 0
            for channel in 0..<channels {
                value += buffer.format.isInterleaved ? data[0][frame * channels + channel] : data[channel][frame]
            }
            mono[frame] = value / Float(channels)
        }
        let pcm = PCM(samples: mono, rate: buffer.format.sampleRate, capturedAt: ProcessInfo.processInfo.systemUptime)
        switch continuation.yield(pcm) {
        case .dropped: stop(reason: "Automatic detection could not keep up with microphone audio. Use Send turn.")
        case .terminated: break
        case .enqueued: break
        @unknown default: stop(reason: "Automatic detection lost microphone audio. Use Send turn.")
        }
    }
    func stop(reason: String? = nil) {
        lock.lock()
        guard !stopped else { lock.unlock(); return }
        stopped = true
        let task = worker
        worker = nil
        lock.unlock()
        continuation.finish(); task?.cancel()
        if let reason { receive(.unavailable(reason)) }
    }
}

/// Keeps AVAudioConverter state across taps; inputRanDry is not endOfStream.
/// Constructed and used only inside the detached detector worker.
private final class ActivityResampler {
    private var converter: AVAudioConverter?
    private var sourceFormat: AVAudioFormat?
    private let targetFormat = AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1)!
    nonisolated func convert(_ samples: [Float], rate: Double) throws -> [Float] {
        if sourceFormat == nil {
            sourceFormat = AVAudioFormat(standardFormatWithSampleRate: rate, channels: 1)
            if let sourceFormat { converter = AVAudioConverter(from: sourceFormat, to: targetFormat) }
        }
        guard let sourceFormat, sourceFormat.sampleRate == rate, let converter,
              let input = AVAudioPCMBuffer(pcmFormat: sourceFormat, frameCapacity: AVAudioFrameCount(samples.count)),
              let output = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: AVAudioFrameCount(ceil(Double(samples.count) * 16_000 / rate) + 128)) else {
            throw VoiceFailure.unavailable("Microphone format changed during automatic detection.")
        }
        input.frameLength = AVAudioFrameCount(samples.count)
        samples.withUnsafeBufferPointer { values in
            if let base = values.baseAddress { input.floatChannelData![0].update(from: base, count: samples.count) }
        }
        var supplied = false
        var error: NSError?
        let status = converter.convert(to: output, error: &error) { _, inputStatus in
            if supplied { inputStatus.pointee = .noDataNow; return nil }
            supplied = true; inputStatus.pointee = .haveData; return input
        }
        if let error { throw error }
        guard status != .error else { throw VoiceFailure.unavailable("Automatic speech audio could not be converted.") }
        return Array(UnsafeBufferPointer(start: output.floatChannelData![0], count: Int(output.frameLength)))
    }
}
