import Foundation

/// Only the duplex PCM producer needs short synthesis requests. Preserve every
/// word and its order while avoiding a full long reply being generated at once.
public enum SpeechUtteranceSegments {
    public static func split(_ text: String, maximumCharacters: Int = 160) -> [String] {
        var segments: [String] = []
        var current = ""
        for word in text.split(whereSeparator: { $0.isWhitespace }) {
            if !current.isEmpty, current.count + word.count + 1 > maximumCharacters {
                segments.append(current); current = ""
            }
            if !current.isEmpty { current += " " }
            current += word
        }
        if !current.isEmpty { segments.append(current) }
        return segments
    }
}
