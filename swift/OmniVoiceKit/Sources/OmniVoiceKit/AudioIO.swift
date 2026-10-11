@preconcurrency import AVFoundation
import Foundation
import FluidAudio

final class CaptureFile: @unchecked Sendable {
    private let lock = NSLock()
    private var file: AVAudioFile?
    private var failure: Error?
    private var reportedFirstTap = false
    private let url: URL
    private let format: AVAudioFormat
    private let chunkFrames: AVAudioFramePosition?
    private var frames: AVAudioFramePosition = 0
    private var urls: [URL]
    private var tail: [AVAudioPCMBuffer] = []
    private let chunkClosed: (@Sendable (URL) -> Void)?
    private var tailFrames: AVAudioFramePosition = 0
    init(url: URL, format: AVAudioFormat, chunkSeconds: Double? = nil, chunkClosed: (@Sendable (URL) -> Void)? = nil) throws {
        self.chunkClosed = chunkClosed
        self.url = url; self.format = format; urls = [url]
        chunkFrames = chunkSeconds.map {
            let bytesPerFrame = max(1, Int(format.streamDescription.pointee.mBytesPerFrame))
            // Even a high-rate multichannel route cannot grow a single CAF
            // beyond the disk budget before its first rotation callback.
            return min(AVAudioFramePosition($0 * format.sampleRate), AVAudioFramePosition(16 * 1024 * 1024 / bytesPerFrame))
        }
        file = try AVAudioFile(forWriting: url, settings: format.settings)
    }
    func recordings() -> [URL] { lock.lock(); defer { lock.unlock() }; return urls }
    /// Build outside AudioIO's main-actor context. The AVAudioEngine callback runs on
    /// its realtime thread; do not capture an actor executor or escape its PCM buffer.
    nonisolated static func tap(for writer: CaptureFile, activity: LocalSpeechActivity? = nil, firstTap: (@Sendable () -> Void)? = nil) -> @Sendable (AVAudioPCMBuffer, AVAudioTime) -> Void {
        { buffer, time in
            if buffer.frameLength > 0 { writer.reportFirstTap(firstTap) }
            writer.append(buffer)
            // Convert host-time evidence to a scalar before leaving this callback.
            let capturedEnd = time.isHostTimeValid ? AVAudioTime.seconds(forHostTime: time.hostTime) + Double(buffer.frameLength) / buffer.format.sampleRate : nil
            activity?.append(buffer, capturedEnd: capturedEnd)
        }
    }
    private func reportFirstTap(_ receive: (@Sendable () -> Void)?) {
        guard let receive else { return }
        lock.lock()
        let report = file != nil && !reportedFirstTap
        if report { reportedFirstTap = true }
        lock.unlock()
        // The callback cannot receive PCM, paths or timing metadata. It runs once
        // per installed capture tap and never while holding the file lock.
        if report { receive() }
    }
    func append(_ buffer: AVAudioPCMBuffer) {
        lock.lock(); defer { lock.unlock() }
        guard file != nil, failure == nil else { return }
        do {
            if let chunkFrames, frames >= chunkFrames {
                file = nil
                chunkClosed?(urls.last!)
                let next = url.deletingPathExtension().appendingPathExtension("chunk-\(urls.count).caf")
                file = try AVAudioFile(forWriting: next, settings: format.settings)
                urls.append(next); frames = 0
                for retained in tail { try file?.write(from: retained); frames += AVAudioFramePosition(retained.frameLength) }
            }
            try file?.write(from: buffer)
            frames += AVAudioFramePosition(buffer.frameLength)
            if chunkFrames != nil, let retained = AVAudioPCMBuffer(pcmFormat: buffer.format, frameCapacity: buffer.frameLength) {
                retained.frameLength = buffer.frameLength
                let source = UnsafeMutableAudioBufferListPointer(buffer.mutableAudioBufferList)
                let destination = UnsafeMutableAudioBufferListPointer(retained.mutableAudioBufferList)
                for index in 0..<source.count {
                    if let from = source[index].mData, let to = destination[index].mData { memcpy(to, from, Int(source[index].mDataByteSize)) }
                }
                tail.append(retained); tailFrames += AVAudioFramePosition(buffer.frameLength)
                while tail.count > 1, tailFrames - AVAudioFramePosition(tail[0].frameLength) >= AVAudioFramePosition(format.sampleRate) {
                    tailFrames -= AVAudioFramePosition(tail.removeFirst().frameLength)
                }
            }
        } catch { failure = error }
    }
    func retainLeadIn() throws {
        lock.lock(); defer { lock.unlock() }
        guard file != nil else { throw VoiceFailure.unavailable("Interruption capture is no longer active.") }
        file = nil
        urls.forEach { try? FileManager.default.removeItem(at: $0) }
        urls = [url]; frames = 0
        file = try AVAudioFile(forWriting: url, settings: format.settings)
        for retained in tail { try file?.write(from: retained); frames += AVAudioFramePosition(retained.frameLength) }
    }
    func close() throws { lock.lock(); defer { lock.unlock() }; file = nil; if let failure { throw failure } }
}

/// Owns exactly one engine. Voice processing provides echo cancellation; V0 never plays
/// assistant audio and never shares the microphone with another recognition engine.
@MainActor public final class AudioIO {
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let playbackQueue = SpeechPlaybackQueue()
    private var playbackFormat: AVAudioFormat?
    private var file: CaptureFile?
    private var speechActivity: LocalSpeechActivity?
    private var vadManager: VadManager?
    private var starting = false
    private var generation: UInt64 = 0
    private let permission: (@MainActor () async -> Bool)?
    public init() { permission = nil; engine.attach(player) }
    init(permission: @escaping @MainActor () async -> Bool) { self.permission = permission; engine.attach(player) }
    public func start(url: URL, chunkSeconds: Double? = nil, chunkClosed: (@Sendable (URL) -> Void)? = nil, activity: (@Sendable (SpeechActivityEvent) -> Void)? = nil, firstTap: (@Sendable () -> Void)? = nil) async throws {
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
        var monitor: LocalSpeechActivity?
        if let activity {
            do {
                if vadManager == nil { vadManager = try await VadManager() }
                guard requestGeneration == generation, !Task.isCancelled else { throw CancellationError() }
                if let vadManager { monitor = LocalSpeechActivity(manager: vadManager, receive: activity) }
            } catch {
                guard requestGeneration == generation, !Task.isCancelled else { throw CancellationError() }
                activity(.unavailable("The local speech detector could not be prepared. Use Send turn. Automatic mode may need a model download."))
            }
        }
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
            let writer = try CaptureFile(url: url, format: format, chunkSeconds: chunkSeconds, chunkClosed: chunkClosed)
            capture = writer
            input.installTap(onBus: 0, bufferSize: 1024, format: format, block: CaptureFile.tap(for: writer, activity: monitor, firstTap: firstTap))
            tapInstalled = true
            engine.prepare(); try engine.start(); completedRecordings = []; file = writer; speechActivity = monitor
        } catch {
            monitor?.stop()
            engine.stop()
            if tapInstalled { engine.inputNode.removeTap(onBus: 0) }
            try? capture?.close()
            #if os(iOS)
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            #endif
            throw error
        }
    }
    /// Synthesized PCM shares the voice-processing engine's output reference.
    /// This is only valid while explicitly opted-in microphone capture is active.
    public func play(_ buffer: AVAudioPCMBuffer, completion: @escaping @Sendable () -> Void) async throws {
        guard engine.isRunning, file != nil else { throw VoiceFailure.unavailable("The conversation microphone is not active.") }
        if playbackFormat != buffer.format {
            player.stop()
            engine.disconnectNodeOutput(player)
            engine.connect(player, to: engine.mainMixerNode, format: buffer.format)
            playbackFormat = buffer.format
        }
        try await playbackQueue.schedule(buffer) { [self] pcm, release in
            guard engine.isRunning, file != nil else { throw VoiceFailure.unavailable("The conversation playback route ended.") }
            player.scheduleBuffer(pcm, completionCallbackType: .dataPlayedBack, completionHandler: Self.playbackCallback(release: release, completion: completion))
            if !player.isPlaying { player.play() }
        }
    }
    nonisolated private static func playbackCallback(release: @escaping @Sendable () -> Void,
                                                    completion: @escaping @Sendable () -> Void) -> @Sendable (AVAudioPlayerNodeCompletionCallbackType) -> Void {
        { _ in release(); completion() }
    }
    public func retainInterruptionLeadIn() throws { try file?.retainLeadIn() }
    public func silencePlayback() { playbackQueue.cancel(); player.stop() }
    public func recordings() -> [URL] { file?.recordings() ?? completedRecordings }
    private var completedRecordings: [URL] = []
    public func stop() throws {
        // Also cancels a pending permission prompt, even before a file/tap exists.
        generation &+= 1
        speechActivity?.stop(); speechActivity = nil
        guard let capture = file else { return }
        playbackQueue.cancel(); player.stop(); engine.stop(); engine.inputNode.removeTap(onBus: 0); completedRecordings = capture.recordings(); file = nil
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
