import Foundation

public enum VoiceInterruptionResponsiveness: String, CaseIterable, Sendable {
    case quick, sustained
    public var title: String { self == .quick ? "Quick" : "Sustained" }
    public var minimumSpeechSeconds: Double { self == .quick ? 0.3 : 0.65 }
}

/// Playback-only duration filter. Detector-positive noise can still pass this gate.
/// Sustained needs three typical 256 ms frames; longer delays may exceed capture lead-in.
///
/// Settling: the voice-processing echo canceller starts fresh with each reply's
/// monitor and leaks the most echo before it adapts. Speech heard in the first
/// `settlingSeconds` of monitored audio never counts toward an interruption, so a
/// run must begin after settling and then meet the responsiveness minimum.
public struct VoiceInterruptionPolicy: Sendable {
    /// Used while Omni speaks: the first three 256 ms detector frames. The owner can
    /// still interrupt from about 1.3 s (Quick) or 1.5 s (Sustained) into a reply.
    public static let echoSettlingSeconds = 1.0
    public let responsiveness: VoiceInterruptionResponsiveness
    public let settlingSeconds: Double
    public private(set) var speechDuration = 0.0
    /// True once speech was heard and ignored during settling (for one diagnostic).
    public private(set) var ignoredSpeechWhileSettling = false
    private var lastAudioTime: Double?
    private var settlingEndsAt: Double?
    public init(responsiveness: VoiceInterruptionResponsiveness = .quick, settlingSeconds: Double = 0) {
        self.responsiveness = responsiveness
        self.settlingSeconds = settlingSeconds.isFinite ? max(0, settlingSeconds) : 0
    }
    /// Breaks the current speech run. The settling period is per monitor and is not reopened.
    public mutating func reset() { speechDuration = 0; lastAudioTime = nil }
    public mutating func accept(_ frame: VoiceActivityFrame, now: Double) -> Bool {
        guard now.isFinite, frame.audioTime.isFinite, frame.capturedAt.isFinite,
              frame.duration.isFinite, frame.duration > 0, frame.duration <= 0.4,
              now - frame.capturedAt >= -0.05, now - frame.capturedAt <= 0.5 else {
            reset(); return false
        }
        if let previous = lastAudioTime {
            let advance = frame.audioTime - previous
            // Audio times denote frame ends; skipped or repeated frames break the run.
            guard advance > 0, abs(advance - frame.duration) <= 0.001 else {
                reset(); return false
            }
        }
        lastAudioTime = frame.audioTime
        let settlingEnd = settlingEndsAt ?? (frame.audioTime - frame.duration + settlingSeconds)
        settlingEndsAt = settlingEnd
        if frame.audioTime <= settlingEnd + 0.001 {
            if frame.isSpeech { ignoredSpeechWhileSettling = true }
            speechDuration = 0
            return false
        }
        speechDuration = frame.isSpeech ? speechDuration + frame.duration : 0
        return speechDuration >= responsiveness.minimumSpeechSeconds
    }
}
