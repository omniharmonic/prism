import Foundation

/// Matches whole words in a bounded local preview. The recognizer's text is never
/// retained; callers discard it after matching. A truncated first word cannot wake.
public enum WakePhraseMatcher {
    public static let maximumCharacters = 4096
    public static func matches(_ text: String) -> Bool {
        let clipped = text.count > maximumCharacters
        let preview = text.suffix(maximumCharacters)
        var words = preview.lowercased().split(whereSeparator: { !$0.isLetter })
        if clipped, preview.first?.isLetter == true, !words.isEmpty { words.removeFirst() }
        return zip(words, words.dropFirst()).contains { $0.0 == "hey" && $0.1 == "omni" }
    }
}
