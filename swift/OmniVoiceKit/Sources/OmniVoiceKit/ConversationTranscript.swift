import Foundation

/// Adjacent capture chunks share one second of audio so a boundary cannot clip a
/// word. Remove only a matching word sequence at that boundary, retaining punctuation.
public enum ConversationTranscript {
    public static func join(_ previous: String, _ next: String) -> String {
        let left = previous.split(whereSeparator: { $0.isWhitespace })
        let right = next.split(whereSeparator: { $0.isWhitespace })
        func key(_ word: Substring) -> String {
            word.lowercased().trimmingCharacters(in: .punctuationCharacters)
        }
        var overlap = 0
        let limit = min(12, left.count, right.count)
        if limit >= 2 {
            for count in 2...limit {
                if left.suffix(count).map(key) == right.prefix(count).map(key) { overlap = count }
            }
        }
        return (left.map(String.init) + right.dropFirst(overlap).map(String.init)).joined(separator: " ")
    }
}
