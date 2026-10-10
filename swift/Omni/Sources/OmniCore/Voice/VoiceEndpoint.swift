import Foundation
import Observation

public enum VoiceTurnMode: String, CaseIterable, Sendable {
    case thinkAloud, automatic
    public var title: String { self == .thinkAloud ? "Think aloud" : "Automatic" }
}

@MainActor @Observable public final class VoiceTurnPreferences {
    nonisolated public static let pauseChoices: [Double] = [8, 12, 20]
    public var mode: VoiceTurnMode { didSet { defaults.set(mode.rawValue, forKey: "omni.voice.turnMode") } }
    public var pauseSeconds: Double {
        didSet {
            if !Self.pauseChoices.contains(pauseSeconds) { pauseSeconds = 12 }
            defaults.set(pauseSeconds, forKey: "omni.voice.pauseSeconds")
        }
    }
    private let defaults: UserDefaults
    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        mode = VoiceTurnMode(rawValue: defaults.string(forKey: "omni.voice.turnMode") ?? "") ?? .thinkAloud
        let stored = defaults.double(forKey: "omni.voice.pauseSeconds")
        pauseSeconds = Self.pauseChoices.contains(stored) ? stored : 12
    }
}

/// Detector evidence refers to actual processed microphone audio, never wall silence.
public struct VoiceActivityFrame: Sendable {
    public let audioTime: Double
    public let capturedAt: Double
    public let duration: Double
    public let isSpeech: Bool
    public init(audioTime: Double, capturedAt: Double, duration: Double, isSpeech: Bool) {
        self.audioTime = audioTime; self.capturedAt = capturedAt; self.duration = duration; self.isSpeech = isSpeech
    }
}
public enum VoiceActivityEvent: Sendable {
    case frame(VoiceActivityFrame)
    case unavailable(String)
}

/// A generous pause heuristic, not a semantic claim that someone finished thinking.
/// Every countdown step needs fresh, continuous local detector evidence.
public struct VoiceEndpointPolicy: Sendable {
    public enum Decision: Equatable { case none, countdown(Int), send, unavailable }
    public let pauseSeconds: Double
    public let graceSeconds = 3.0
    private var lastAudioTime: Double?
    private var lastSpeechTime: Double?
    private var speechDuration = 0.0
    private var hasSpeech = false
    private var committed = false
    public private(set) var healthy = true
    public init(pauseSeconds: Double = 12) { self.pauseSeconds = VoiceTurnPreferences.pauseChoices.contains(pauseSeconds) ? pauseSeconds : 12 }
    public mutating func disable() { healthy = false }
    public mutating func keepListening() {
        lastSpeechTime = lastAudioTime
        committed = false
    }
    public mutating func accept(_ frame: VoiceActivityFrame, now: Double) -> Decision {
        guard healthy else { return .unavailable }
        guard frame.audioTime.isFinite, frame.capturedAt.isFinite, frame.duration.isFinite,
              frame.duration > 0, frame.duration <= 0.4,
              now - frame.capturedAt >= -0.05, now - frame.capturedAt <= 0.5,
              lastAudioTime.map({ frame.audioTime > $0 && frame.audioTime - $0 <= 0.4 }) ?? true else {
            healthy = false; return .unavailable
        }
        lastAudioTime = frame.audioTime
        if frame.isSpeech {
            speechDuration += frame.duration
            if speechDuration >= 0.3 { hasSpeech = true }
            lastSpeechTime = frame.audioTime
            committed = false
            return .none
        }
        if !hasSpeech { speechDuration = 0 }
        guard hasSpeech, !committed, let lastSpeechTime else { return .none }
        let silence = frame.audioTime - lastSpeechTime
        guard silence >= pauseSeconds else { return .none }
        if silence >= pauseSeconds + graceSeconds { committed = true; return .send }
        return .countdown(max(1, Int(ceil(pauseSeconds + graceSeconds - silence))))
    }
}
