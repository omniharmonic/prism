@preconcurrency import AVFoundation
import Foundation
import FluidAudio

private final class CaptureFile: @unchecked Sendable {
    private let lock = NSLock()
    private var file: AVAudioFile?
    private var failure: Error?
    init(url: URL, format: AVAudioFormat) throws { file = try AVAudioFile(forWriting: url, settings: format.settings) }
    func append(_ buffer: AVAudioPCMBuffer) {
        lock.lock(); defer { lock.unlock() }
        do { try file?.write(from: buffer) } catch { failure = error }
    }
    func close() throws { lock.lock(); defer { lock.unlock() }; file = nil; if let failure { throw failure } }
}

/// Owns exactly one engine. Voice processing provides echo cancellation; V0 never plays
/// assistant audio and never shares the microphone with another recognition engine.
@MainActor public final class AudioIO {
    private let engine = AVAudioEngine()
    private var file: CaptureFile?
    private var starting = false
    private var generation: UInt64 = 0
    private let permission: (@MainActor () async -> Bool)?
    public init() { permission = nil }
    init(permission: @escaping @MainActor () async -> Bool) { self.permission = permission }
    public func start(url: URL) async throws {
        guard file == nil, !starting else { throw VoiceFailure.unavailable("A recording is already starting or running.") }
        starting = true
        let requestGeneration = generation
        defer { starting = false }
        let granted: Bool
        if let permission { granted = await permission() }
        else {
            #if os(iOS)
            granted = await AVAudioApplication.requestRecordPermission()
            #else
            granted = await AVCaptureDevice.requestAccess(for: .audio)
            #endif
        }
        guard requestGeneration == generation, !Task.isCancelled else { throw CancellationError() }
        guard granted else { throw VoiceFailure.permission }
        var tapInstalled = false
        var capture: CaptureFile?
        do {
            #if os(iOS)
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetoothHFP])
            try session.setActive(true)
            #endif
            let input = engine.inputNode
            try input.setVoiceProcessingEnabled(true)
            let format = input.outputFormat(forBus: 0)
            guard format.sampleRate > 0 else { throw VoiceFailure.unavailable("No microphone input is available.") }
            let writer = try CaptureFile(url: url, format: format)
            capture = writer
            input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in writer.append(buffer) }
            tapInstalled = true
            engine.prepare(); try engine.start(); file = writer
        } catch {
            engine.stop()
            if tapInstalled { engine.inputNode.removeTap(onBus: 0) }
            try? capture?.close()
            #if os(iOS)
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            #endif
            throw error
        }
    }
    public func stop() throws {
        // Also cancels a pending permission prompt, even before a file/tap exists.
        generation &+= 1
        guard let capture = file else { return }
        engine.stop(); engine.inputNode.removeTap(onBus: 0); file = nil
        #if os(iOS)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        #endif
        try capture.close()
    }
}

public actor SileroVAD {
    private var manager: VadManager?
    public init() {}
    public func prepare() async throws { manager = try await VadManager() }
    public func speechEnd(file: URL) async throws -> Double {
        guard let manager else { throw VoiceFailure.notPrepared }
        let segments = try await manager.segmentSpeech(Replay.samples(file), config: VadSegmentationConfig(speechPadding: 0))
        guard let end = segments.last?.endTime else { throw VoiceFailure.unavailable("No speech was detected. Record the utterance again.") }
        return end
    }
}
