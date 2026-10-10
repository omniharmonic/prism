import Foundation

/// A narration projection only. Preserve the original assistant response in chat.
/// Call with a completed response, not arbitrary stream deltas: fences, links and
/// emphasis can span deltas. Tool events must never be passed as assistant prose.
public enum SpeechText {
    public static func narration(from markdown: String) -> String {
        var lines: [String] = []
        var fence: Character?
        var fenceLength = 0
        var hiddenBlock: String?
        for raw in markdown.components(separatedBy: .newlines) {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if let hidden = hiddenBlock {
                if line.contains("</" + hidden + ">") { hiddenBlock = nil }
                continue
            }
            if let marker = line.first, marker == "`" || marker == "~" {
                let count = line.prefix(while: { $0 == marker }).count
                if count >= 3 {
                    if fence == nil { fence = marker; fenceLength = count }
                    else if fence == marker && count >= fenceLength { fence = nil }
                    continue
                }
            }
            if fence != nil { continue }
            for tag in ["tool", "tool_result", "script", "style"] where line.hasPrefix("<" + tag + ">") {
                if !line.contains("</" + tag + ">") { hiddenBlock = tag }
            }
            if hiddenBlock != nil || ["tool", "tool_result", "script", "style"].contains(where: { line.hasPrefix("<" + $0 + ">") }) { continue }
            if line.hasPrefix("<!--") || line.hasPrefix("<") || line.hasPrefix("|") { continue }
            if matches(line, #"^\[[^\]]+\]:\s*\S+"#) || matches(line, #"^([-*_]\s*){3,}$"#) { continue }
            // Hermes media directives/cache paths describe attachment delivery,
            // not another spoken answer. Preserve the original in chat.
            let audioPath = #"(?i)(?:file://)?(?:/|~/?|[A-Z]:\\)[^\s`<>\[\]()\"']+\.(?:mp3|wav|m4a|aac|ogg|opus|caf)(?:\?[^\s]*)?"#
            if matches(line, #"(?i)^\s*(?:[-*]\s*)?(?:MEDIA:|(?:saved\s+)?(?:audio|voice|speech|tts)(?:[ _-]?(?:file|path|cache|attachment))?\s*[:=])"#), matches(line, audioPath) { continue }
            if matches(line, #"(?i)^\s*\{.*\"audio_(?:path|file|url)\"\s*:"#), matches(line, audioPath) { continue }
            var text = replacing(line, #"!\[[^\]]*\]\([^)]*\)"#, "")
            text = replacing(text, #"(?i)\[[^\]]*\]\((?:file://)?(?:/|~)[^)]*\.(?:mp3|wav|m4a|aac|ogg|opus|caf)\)"#, "")
            text = replacing(text, #"\[([^\]]+)\]\([^)]*\)"#, "$1")
            text = replacing(text, #"\[([^\]]+)\]\[[^\]]*\]"#, "$1")
            text = replacing(text, #"^\s*(?:#{1,6}\s+|>\s*|[-+*]\s+|\d+[.)]\s+)"#, "")
            text = replacing(text, #"^\[[ xX]\]\s*"#, "")
            text = replacing(text, #"(`+|\*\*|__|~~)"#, "")
            text = replacing(text, #"(?<!\w)[*_]([^*_]+)[*_](?!\w)"#, "$1")
            text = replacing(text, #"\\([\\`*_{}\[\]()#+.!>-])"#, "$1")
            text = replacing(text, audioPath, "")
            text = replacing(text, #"\s+"#, " ").trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty { lines.append(text) }
        }
        return lines.joined(separator: "\n")
    }
    private static func replacing(_ value: String, _ pattern: String, _ replacement: String) -> String {
        value.replacingOccurrences(of: pattern, with: replacement, options: .regularExpression)
    }
    private static func matches(_ value: String, _ pattern: String) -> Bool {
        value.range(of: pattern, options: .regularExpression) != nil
    }
}
