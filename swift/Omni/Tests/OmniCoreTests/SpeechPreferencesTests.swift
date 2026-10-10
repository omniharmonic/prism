import XCTest
@testable import OmniCore

@MainActor final class SpeechPreferencesTests: XCTestCase {
    private func voice(_ id: String, _ quality: SpeechVoice.Quality, _ language: String = "en-US") -> SpeechVoice {
        SpeechVoice(id: id, name: id, language: language, quality: quality)
    }
    func testAutomaticQualityAndSystemTieBreakPreserveRequestedRegion() {
        let voices = [voice("novelty", .standard), voice("system", .standard), voice("enhanced", .enhanced), voice("premium", .premium), voice("other-region", .premium, "en-GB")]
        XCTAssertEqual(SpeechVoiceSelection.resolve(voices: voices, identifier: nil, language: "en-US", systemIdentifier: "system")?.id, "premium")
        XCTAssertEqual(SpeechVoiceSelection.resolve(voices: Array(voices.prefix(2)), identifier: nil, language: "en-US", systemIdentifier: "system")?.id, "system")
        XCTAssertEqual(SpeechVoiceSelection.resolve(voices: Array(voices.prefix(3)), identifier: nil, language: "en-US", systemIdentifier: "system")?.id, "enhanced")
    }
    func testExplicitSelectionAndMissingVoiceFallback() {
        let voices = [voice("chosen", .standard), voice("premium", .premium)]
        XCTAssertEqual(SpeechVoiceSelection.resolve(voices: voices, identifier: "chosen", language: "en-US", systemIdentifier: nil)?.id, "chosen")
        XCTAssertEqual(SpeechVoiceSelection.resolve(voices: voices, identifier: "removed", language: "en-US", systemIdentifier: nil)?.id, "premium")
        XCTAssertEqual(SpeechVoiceSelection.resolve(voices: voices, identifier: nil, language: "en-GB", systemIdentifier: nil)?.id, "premium")
        XCTAssertNil(SpeechVoiceSelection.resolve(voices: voices, identifier: nil, language: "fr-FR", systemIdentifier: nil))
    }
    func testPreferencesRoundTripLanguageSelectionAndInvalidRates() {
        let name = "SpeechPreferencesTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        let preferences = SpeechPreferences(defaults: defaults)
        preferences.select(voice("picked", .enhanced, "en-GB")); preferences.rate = 0.6
        let restored = SpeechPreferences(defaults: defaults)
        XCTAssertEqual(restored.identifier, "picked"); XCTAssertEqual(restored.language, "en-GB"); XCTAssertEqual(restored.rate, 0.6)
        restored.selectLanguage("fr-FR")
        XCTAssertNil(SpeechPreferences(defaults: defaults).identifier)
        restored.rate = .nan
        XCTAssertEqual(restored.rate, SpeechPreferences.defaultRate)
        restored.rate = 100
        XCTAssertEqual(restored.rate, SpeechPreferences.rateRange.upperBound)
        defaults.set(-2, forKey: "omni.speech.rate")
        XCTAssertEqual(SpeechPreferences(defaults: defaults).rate, SpeechPreferences.rateRange.lowerBound)
        restored.select(nil)
        XCTAssertEqual(SpeechPreferences(defaults: defaults).language, "fr-FR")
    }
}
