import Foundation
public enum BenchMetrics {
    public static func words(_ text: String) -> [String] {
        text.lowercased().split(whereSeparator: { !$0.isLetter && !$0.isNumber }).map(String.init)
    }
    public static func distance(_ expected: [String], _ actual: [String]) -> Int {
        var previous = Array(0...actual.count)
        for (i, word) in expected.enumerated() {
            var current = [i + 1]
            for (j, candidate) in actual.enumerated() {
                current.append(min(previous[j + 1] + 1, current[j] + 1, previous[j] + (word == candidate ? 0 : 1)))
            }
            previous = current
        }
        return previous.last ?? 0
    }
    public static func wordErrorRate(reference: String, hypothesis: String) -> Double? {
        let expected = words(reference)
        guard !expected.isEmpty else { return nil }
        return Double(distance(expected, words(hypothesis))) / Double(expected.count)
    }
    /// Count occurrences of each seeded name in the reference. Missed/repeated occurrences
    /// count as errors; unrelated names absent from the reference do not create a denominator.
    public static func nameCounts(reference: String, hypothesis: String, vocabulary: [String]) -> (errors: Int, count: Int) {
        func occurrences(_ term: [String], in words: [String]) -> Int {
            guard !term.isEmpty, words.count >= term.count else { return 0 }
            return (0...(words.count - term.count)).filter { Array(words[$0..<($0 + term.count)]) == term }.count
        }
        let referenceWords = words(reference), hypothesisWords = words(hypothesis)
        return vocabulary.reduce(into: (errors: 0, count: 0)) { total, name in
            let expected = occurrences(words(name), in: referenceWords)
            guard expected > 0 else { return }
            total.count += expected
            total.errors += abs(expected - occurrences(words(name), in: hypothesisWords))
        }
    }
}
