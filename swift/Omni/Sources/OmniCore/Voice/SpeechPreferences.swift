import Foundation
import Observation

/// Installed voice metadata, independent of Apple's playback adapter.
public struct SpeechVoice: Identifiable, Equatable, Sendable {
    public enum Quality: Int, Comparable, Sendable {
        case standard = 1, enhanced, premium
        public static func < (lhs: Self, rhs: Self) -> Bool { lhs.rawValue < rhs.rawValue }
        public var label: String {
            switch self { case .standard: "Standard"; case .enhanced: "Enhanced"; case .premium: "Premium" }
        }
    }
    public let id: String
    public let name: String
    public let language: String
    public let quality: Quality
    public init(id: String, name: String, language: String, quality: Quality) {
        self.id = id; self.name = name; self.language = language; self.quality = quality
    }
}

public enum SpeechVoiceSelection {
    /// Prefer the requested region before considering another region of that language.
    /// Apple's system choice breaks quality ties, avoiding an alphabetic novelty default.
    public static func resolve(voices: [SpeechVoice], identifier: String?, language: String, systemIdentifier: String?) -> SpeechVoice? {
        if let identifier, let chosen = voices.first(where: { $0.id == identifier && $0.language == language }) { return chosen }
        let exact = voices.filter { $0.language == language }
        let candidates = exact.isEmpty ? voices.filter { languageCode($0.language) == languageCode(language) } : exact
        return candidates.sorted {
            if $0.quality != $1.quality { return $0.quality > $1.quality }
            if ($0.id == systemIdentifier) != ($1.id == systemIdentifier) { return $0.id == systemIdentifier }
            return $0.id < $1.id
        }.first
    }
    private static func languageCode(_ language: String) -> String {
        language.replacingOccurrences(of: "_", with: "-").split(separator: "-").first.map(String.init) ?? language
    }
}

/// Device-local preferences: voice assets and identifiers differ between devices.
@MainActor @Observable public final class SpeechPreferences {
    public static let defaultRate: Float = 0.5
    public static let rateRange: ClosedRange<Float> = 0.35...0.65
    public private(set) var language: String
    public private(set) var identifier: String?
    public var rate: Float {
        didSet {
            let valid = Self.validRate(rate)
            if valid != rate { rate = valid }
            defaults.set(valid, forKey: "omni.speech.rate")
        }
    }
    private let defaults: UserDefaults
    public init(defaults: UserDefaults = .standard, defaultLanguage: String = "en-US") {
        self.defaults = defaults
        language = defaults.string(forKey: "omni.speech.language") ?? defaultLanguage
        identifier = defaults.string(forKey: "omni.speech.voice")
        rate = Self.validRate((defaults.object(forKey: "omni.speech.rate") as? NSNumber)?.floatValue ?? Self.defaultRate)
    }
    public func selectLanguage(_ language: String) {
        guard self.language != language else { return }
        self.language = language; identifier = nil
        defaults.set(language, forKey: "omni.speech.language")
        defaults.removeObject(forKey: "omni.speech.voice")
    }
    public func select(_ voice: SpeechVoice?) {
        identifier = voice?.id
        if let voice { language = voice.language; defaults.set(language, forKey: "omni.speech.language") }
        if let identifier { defaults.set(identifier, forKey: "omni.speech.voice") }
        else { defaults.removeObject(forKey: "omni.speech.voice") }
    }
    private static func validRate(_ value: Float) -> Float {
        value.isFinite ? min(max(value, rateRange.lowerBound), rateRange.upperBound) : defaultRate
    }
}
