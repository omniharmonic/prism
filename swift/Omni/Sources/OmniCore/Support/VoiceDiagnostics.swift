import Foundation

/// Bounded, device-local event trace. The API cannot accept speech, paths, IDs,
/// credentials or raw errors. Coarse lifecycle events only; never per audio frame.
public enum VoiceDiagnosticEvent: String, Codable, Sendable {
    case sessionStart, captureReady, transcribing, emptyCapture, emptyRetry, sending
    case sendAccepted, sendFailed, paused, resumed, cancelled, staleCallback
    case captureFailed, playbackStarted, playbackFinished, playbackFailed
    case acousticInterruption, synthesisStarted, synthesisFinished, synthesisFailed
    case appleFallback, playbackDrain, listeningAgain
    case activityFirstFrame, activityUnavailable, activityWatchdog, microphoneFirstTap
    case replyCompletionReceived, replyTextQueued, pauseRequested
    case playbackRouteLost, playbackEngineInactive, playbackCaptureMissing, playbackBufferBudget
    case playbackDecodeFailed, playbackOtherFailure

}
public enum VoiceDiagnostics {
    // Package tests and command-line tools must not pollute the installed app's
    // trace. Explicit VoiceEventLog instances still support temporary test files.
    private static let sink = VoiceEventLog(url: Bundle.main.bundleIdentifier == "com.benjaminlife.omni"
        ? FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?
            .appending(path: "OmniVoiceDiagnostics/events.json") : nil)
    public static func record(_ event: VoiceDiagnosticEvent) { sink.record(event) }
}

/// All mutable state and disk access are confined to queue, off the audio/UI thread.
public final class VoiceEventLog: @unchecked Sendable {
    private struct Entry: Codable { let at: Date; let event: VoiceDiagnosticEvent }
    private let queue = DispatchQueue(label: "com.benjaminlife.omni.voice-diagnostics", qos: .utility)
    private let url: URL?
    private let capacity: Int
    private var entries: [Entry] = []
    private var loaded = false
    public init(url: URL?, capacity: Int = 256) { self.url = url; self.capacity = min(256, max(1, capacity)) }
    public func record(_ event: VoiceDiagnosticEvent) {
        let at = Date()
        queue.async { [self] in
            guard let url else { return }
            if !loaded {
                loaded = true
                if let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= 65536,
                   let data = try? Data(contentsOf: url), let saved = try? JSONDecoder().decode([Entry].self, from: data) {
                    entries = Array(saved.filter { at.timeIntervalSince($0.at) < 86400 }.suffix(capacity))
                }
            }
            entries.removeAll { at.timeIntervalSince($0.at) >= 86400 }
            entries.append(Entry(at: at, event: event))
            if entries.count > capacity { entries.removeFirst(entries.count - capacity) }
            do {
                try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
                let data = try JSONEncoder().encode(entries)
                guard data.count <= 65536 else { return }
                try data.write(to: url, options: .atomic)
                try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
            } catch { /* Diagnostics never change the conversation's behavior. */ }
        }
    }
    public func flush() async { await withCheckedContinuation { continuation in queue.async { continuation.resume() } } }
}
