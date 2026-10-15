import Foundation

/// Decides whether an automatically captured transcript is Omni hearing its own
/// reply rather than the owner. Text only: the caller decides when the capture is
/// close enough to playback for the question to matter.
///
/// The transcript is compared with what Omni spoke, after normalisation, by the
/// longest in-order run of fuzzily equal words (an LCS). ASR on echo residue drops,
/// merges and misspells words, so an exact substring test would miss most echoes.
public enum VoiceSelfEcho {
    /// Speech starting this soon after playback ends is still treated as possible echo
    /// (output latency on Bluetooth and AirPlay routes, room reverberation).
    public static let windowSeconds = 1.5
    /// Below three words, a repeat of Omni's words is as likely to be a real answer
    /// ("send it", "Sarah") as an echo. The loop breaker covers short echoes instead.
    public static let minimumWords = 3
    /// At least this share of the transcript's words must align, in order, with Omni's
    /// words. Echo residue typically aligns at 0.8 or more even at a 30% word error
    /// rate; a real interruption that reuses Omni's phrasing adds its own words.
    public static let echoMatchRatio = 0.7
    /// Words that mark a barge-in or an answer. If one is in the transcript but not in
    /// the aligned echo, the owner said it, so the turn is kept.
    static let ownerCues: Set<String> = [
        "stop", "wait", "no", "nope", "yes", "yeah", "yep", "hold", "hang", "actually",
        "cancel", "pause", "sorry", "hey", "omni", "okay", "ok", "nevermind", "instead", "dont",
        "quiet", "enough", "shut",
    ]
    static let maximumReferenceWords = 400
    static let maximumTranscriptWords = 120

    public static func isLikelyEcho(_ transcript: String, of reference: String) -> Bool {
        let heard = Array(words(transcript).prefix(maximumTranscriptWords))
        guard heard.count >= minimumWords else { return false }
        let spoken = Array(words(reference).suffix(maximumReferenceWords))
        guard !spoken.isEmpty else { return false }
        let matched = alignedIndices(heard, spoken)
        for (index, word) in heard.enumerated() where !matched.contains(index) && ownerCues.contains(word) {
            return false
        }
        return Double(matched.count) / Double(heard.count) >= echoMatchRatio
    }

    /// Lowercased words without punctuation or diacritics. Apostrophes join
    /// ("I've" → "ive") and small number words become digits so "five" matches "5".
    static func words(_ text: String) -> [String] {
        let folded = text.folding(options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive], locale: nil)
            .replacingOccurrences(of: "'", with: "").replacingOccurrences(of: "\u{2019}", with: "")
        return folded.split(whereSeparator: { !$0.isLetter && !$0.isNumber }).map { word in
            let value = String(word)
            return numberWords[value] ?? value
        }
    }
    private static let numberWords: [String: String] = [
        "zero": "0", "one": "1", "two": "2", "three": "3", "four": "4", "five": "5", "six": "6",
        "seven": "7", "eight": "8", "nine": "9", "ten": "10", "eleven": "11", "twelve": "12",
        "thirteen": "13", "fourteen": "14", "fifteen": "15", "sixteen": "16", "seventeen": "17",
        "eighteen": "18", "nineteen": "19", "twenty": "20",
    ]

    /// Recognisers swap inflections and single letters; short words must match exactly.
    static func similar(_ a: String, _ b: String) -> Bool {
        if a == b { return true }
        let shorter = min(a.count, b.count)
        guard shorter >= 4 else { return false }
        if a.hasPrefix(b) || b.hasPrefix(a) { return true }
        return editDistance(a, b, limit: shorter >= 7 ? 2 : 1) <= (shorter >= 7 ? 2 : 1)
    }

    /// Indices of `heard` in one longest in-order fuzzy alignment with `spoken`.
    /// Similarity is computed once per distinct word pair, so the table fill is integer work.
    static func alignedIndices(_ heard: [String], _ spoken: [String]) -> Set<Int> {
        var ids: [String: Int] = [:]
        let heardIDs = heard.map { word in ids[word] ?? { ids[word] = ids.count; return ids.count - 1 }() }
        let spokenIDs = spoken.map { word in ids[word] ?? { ids[word] = ids.count; return ids.count - 1 }() }
        var vocabulary = Array(repeating: "", count: ids.count)
        for (word, id) in ids { vocabulary[id] = word }
        var cache: [Int: Bool] = [:]
        func same(_ a: Int, _ b: Int) -> Bool {
            if a == b { return true }
            let key = a * ids.count + b
            if let known = cache[key] { return known }
            let result = similar(vocabulary[a], vocabulary[b])
            cache[key] = result
            return result
        }
        let rows = heard.count, columns = spoken.count, width = columns + 1
        var table = [Int](repeating: 0, count: (rows + 1) * width)
        for i in stride(from: rows - 1, through: 0, by: -1) {
            for j in stride(from: columns - 1, through: 0, by: -1) {
                table[i * width + j] = same(heardIDs[i], spokenIDs[j])
                    ? table[(i + 1) * width + j + 1] + 1
                    : max(table[(i + 1) * width + j], table[i * width + j + 1])
            }
        }
        var matched = Set<Int>()
        var i = 0, j = 0
        while i < rows, j < columns {
            if same(heardIDs[i], spokenIDs[j]), table[i * width + j] == table[(i + 1) * width + j + 1] + 1 {
                matched.insert(i); i += 1; j += 1
            } else if table[(i + 1) * width + j] >= table[i * width + j + 1] {
                i += 1
            } else {
                j += 1
            }
        }
        return matched
    }

    static func editDistance(_ a: String, _ b: String, limit: Int) -> Int {
        let x = Array(a), y = Array(b)
        guard abs(x.count - y.count) <= limit else { return limit + 1 }
        guard !x.isEmpty, !y.isEmpty else { return max(x.count, y.count) }
        var previous = Array(0...y.count)
        for i in 1...x.count {
            var current = [i] + Array(repeating: 0, count: y.count)
            for j in 1...y.count {
                current[j] = min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (x[i - 1] == y[j - 1] ? 0 : 1))
            }
            previous = current
        }
        return previous[y.count]
    }
}

/// Counts automatic turns that arrive during or just after Omni's playback with no
/// fresh owner speech in between. Two in a row means Omni is probably answering itself.
public struct VoiceSelfHearingBreaker: Sendable {
    public static let turnLimit = 2
    public private(set) var consecutive = 0
    public init() {}
    /// Returns true when this turn must be held for the owner instead of sent.
    public mutating func automaticTurn(playbackAdjacent: Bool) -> Bool {
        guard playbackAdjacent else { consecutive = 0; return false }
        consecutive += 1
        guard consecutive >= Self.turnLimit else { return false }
        consecutive = 0
        return true
    }
    /// A tap (Send turn, Resume, start) is fresh owner intent.
    public mutating func ownerActed() { consecutive = 0 }
}
