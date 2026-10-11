import Foundation

public enum VoiceInterruptionResponsiveness: String, CaseIterable, Sendable {
    case quick, sustained
    public var title: String { self == .quick ? "Quick" : "Sustained" }
    public var minimumSpeechSeconds: Double { self == .quick ? 0.3 : 0.65 }
}

/// Playback-only duration filter. Detector-positive noise can still pass this gate.
/// Sustained needs three typical 256 ms frames; longer delays may exceed capture lead-in.
public struct VoiceInterruptionPolicy: Sendable {
    public let responsiveness: VoiceInterruptionResponsiveness
    public private(set) var speechDuration = 0.0
    private var lastAudioTime: Double?
    public init(responsiveness: VoiceInterruptionResponsiveness = .quick) {
        self.responsiveness = responsiveness
    }
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
        speechDuration = frame.isSpeech ? speechDuration + frame.duration : 0
        return speechDuration >= responsiveness.minimumSpeechSeconds
    }
}
