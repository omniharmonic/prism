import Foundation

/// One block of an answer, ready to draw: a paragraph, a heading, a list item, a code block,
/// a rule or a table — with its inline styling (bold, italic, code, links) already applied.
///
/// Built from Foundation's own CommonMark/GFM parser (`AttributedString(markdown:)` with
/// `.full` syntax): the parser marks every run with its `PresentationIntent` (the blocks it
/// sits in), and `MarkdownBlocks.parse` groups the runs back into blocks. No third-party
/// parser; nothing here knows about SwiftUI.
public struct MarkdownBlock: Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        case paragraph
        /// 1…6.
        case heading(Int)
        /// `language` is the fence's hint (` ```swift `), when there is one.
        case code(language: String?)
        case rule
        /// `rows[0]` is the header row.
        case table
    }

    public enum ListMarker: Equatable, Sendable {
        case bullet
        case number(Int)
    }

    public var kind: Kind
    /// The inline content. A code block's is its text as written (no trailing newline).
    public var text: AttributedString
    /// How many lists it sits in (0 = none). A nested item is depth 2.
    public var listDepth: Int
    /// Set on the first block of a list item: where the bullet or number goes. Later blocks
    /// of the same item (a second paragraph, a code block) have none but keep the indent.
    public var marker: ListMarker?
    /// The outermost list it sits in (nil = none): two lists one after another are two lists.
    public var list: Int?
    /// How many block quotes it sits in.
    public var quoteDepth: Int
    /// A table's cells, row by row (the header first).
    public var rows: [[AttributedString]]

    public init(kind: Kind, text: AttributedString = AttributedString(), listDepth: Int = 0, marker: ListMarker? = nil, list: Int? = nil, quoteDepth: Int = 0, rows: [[AttributedString]] = []) {
        self.kind = kind
        self.text = text
        self.listDepth = listDepth
        self.marker = marker
        self.list = list
        self.quoteDepth = quoteDepth
        self.rows = rows
    }

    /// The words alone, for VoiceOver and copying: markers as they read ("1.", "•"), no `#`,
    /// no `**`, no fences.
    public var plainText: String {
        switch kind {
        case .rule: return ""
        case .table: return rows.map { $0.map { String($0.characters) }.joined(separator: ", ") }.joined(separator: "\n")
        default:
            let words = String(text.characters)
            switch marker {
            case .bullet: return "• " + words
            case .number(let n): return "\(n). " + words
            case nil: return words
            }
        }
    }
}

public enum MarkdownBlocks {
    /// The blocks of `markdown`. Never fails: text the parser cannot read comes back as one
    /// paragraph of its inline markdown. Line breaks inside a paragraph are kept as written
    /// (an agent's single newline means a new line, as it did before blocks were drawn).
    public static func parse(_ markdown: String) -> [MarkdownBlock] {
        guard !markdown.isEmpty else { return [] }
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .full, failurePolicy: .returnPartiallyParsedIfPossible)
        guard let parsed = try? AttributedString(markdown: markdown, options: options) else {
            return [MarkdownBlock(kind: .paragraph, text: inline(markdown))]
        }
        var builder = Builder()
        for run in parsed.runs {
            var piece = AttributedString(parsed[run.range])
            piece.presentationIntent = nil
            if let intent = run.inlinePresentationIntent, intent.contains(.softBreak) {
                piece = AttributedString("\n")
            }
            builder.add(piece, intent: run.presentationIntent)
        }
        return builder.finish()
    }

    /// Cached `parse`, for a transcript that draws the same finished answers again as it
    /// scrolls. Streaming text changes every update and is parsed afresh (a few kilobytes
    /// parse in well under a millisecond).
    public static func cached(_ markdown: String) -> [MarkdownBlock] {
        let key = markdown as NSString
        if let hit = cache.object(forKey: key) { return hit.blocks }
        let blocks = parse(markdown)
        cache.setObject(Box(blocks), forKey: key, cost: markdown.utf8.count)
        return blocks
    }

    /// Inline markdown only (bold, italic, code, links), line breaks kept: a user's own
    /// message, which is never laid out as blocks.
    public static func inline(_ text: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace, failurePolicy: .returnPartiallyParsedIfPossible)
        var result = (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
        linkBareURLs(in: &result)
        return result
    }

    /// All of an answer's words, block by block, for VoiceOver.
    public static func plainText(_ markdown: String) -> String {
        cached(markdown).map(\.plainText).filter { !$0.isEmpty }.joined(separator: "\n")
    }

    // MARK: Grouping runs into blocks

    private struct Builder {
        var blocks: [MarkdownBlock] = []
        /// The identity of the innermost block the last run sat in.
        var leaf: Int?
        /// The table being filled, and the row and cell the last run sat in.
        var table: Int?
        var row: Int?
        var cell: Int?
        /// List items whose first block has been made (it carries the marker).
        var startedItems: Set<Int> = []

        mutating func add(_ piece: AttributedString, intent: PresentationIntent?) {
            let components = intent?.components ?? []
            if let tableIndex = components.firstIndex(where: { if case .table = $0.kind { return true } else { return false } }) {
                addCell(piece, components: components, table: components[tableIndex])
                return
            }
            table = nil
            let innermost = components.first
            let identity = innermost?.identity ?? -1
            if identity != leaf || blocks.isEmpty {
                leaf = identity
                blocks.append(start(innermost?.kind, components: components))
            }
            if case .rule = blocks[blocks.count - 1].kind { return }
            blocks[blocks.count - 1].text.append(piece)
        }

        private mutating func start(_ kind: PresentationIntent.Kind?, components: [PresentationIntent.IntentType]) -> MarkdownBlock {
            var block = MarkdownBlock(kind: .paragraph)
            switch kind {
            case .header(let level): block.kind = .heading(level)
            case .codeBlock(let hint): block.kind = .code(language: hint.flatMap { $0.isEmpty ? nil : $0 })
            case .thematicBreak: block.kind = .rule
            default: block.kind = .paragraph
            }
            block.quoteDepth = components.filter { if case .blockQuote = $0.kind { return true } else { return false } }.count
            block.listDepth = components.filter(Self.isList).count
            block.list = components.last(where: Self.isList)?.identity
            // The nearest list item: its first block carries the marker; the list just outside it
            // says whether that is a bullet or a number.
            if let itemIndex = components.firstIndex(where: { if case .listItem = $0.kind { return true } else { return false } }),
               case .listItem(let ordinal) = components[itemIndex].kind,
               startedItems.insert(components[itemIndex].identity).inserted {
                let list = components[(itemIndex + 1)...].first(where: Self.isList)
                if case .orderedList = list?.kind { block.marker = .number(ordinal) } else { block.marker = .bullet }
            }
            return block
        }

        private static func isList(_ component: PresentationIntent.IntentType) -> Bool {
            switch component.kind {
            case .orderedList, .unorderedList: return true
            default: return false
            }
        }

        private mutating func addCell(_ piece: AttributedString, components: [PresentationIntent.IntentType], table component: PresentationIntent.IntentType) {
            if table != component.identity || blocks.isEmpty {
                table = component.identity
                row = nil
                cell = nil
                leaf = component.identity
                var block = MarkdownBlock(kind: .table)
                block.quoteDepth = components.filter { if case .blockQuote = $0.kind { return true } else { return false } }.count
                block.listDepth = components.filter(Self.isList).count
                blocks.append(block)
            }
            let rowIdentity = components.first { component in
                switch component.kind {
                case .tableHeaderRow, .tableRow: return true
                default: return false
                }
            }?.identity
            let cellComponent = components.first { if case .tableCell = $0.kind { return true } else { return false } }
            let last = blocks.count - 1
            if rowIdentity != row {
                row = rowIdentity
                cell = nil
                blocks[last].rows.append([])
            }
            if cellComponent?.identity != cell {
                cell = cellComponent?.identity
                blocks[last].rows[blocks[last].rows.count - 1].append(AttributedString())
            }
            let rowIndex = blocks[last].rows.count - 1
            let cellIndex = blocks[last].rows[rowIndex].count - 1
            blocks[last].rows[rowIndex][cellIndex].append(piece)
        }

        mutating func finish() -> [MarkdownBlock] {
            for index in blocks.indices {
                switch blocks[index].kind {
                case .code:
                    // The parser ends a code block with its last newline.
                    while blocks[index].text.characters.last == "\n" {
                        blocks[index].text.removeSubrange(blocks[index].text.index(beforeCharacter: blocks[index].text.endIndex)..<blocks[index].text.endIndex)
                    }
                case .rule:
                    break
                case .table:
                    for r in blocks[index].rows.indices {
                        for c in blocks[index].rows[r].indices { MarkdownBlocks.linkBareURLs(in: &blocks[index].rows[r][c]) }
                    }
                default:
                    MarkdownBlocks.linkBareURLs(in: &blocks[index].text)
                }
            }
            return blocks
        }
    }

    // MARK: Bare links

    private static let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)

    /// `https://…` written without brackets becomes a link — outside code, and only where the
    /// text is not a link already.
    static func linkBareURLs(in text: inout AttributedString) {
        guard let detector else { return }
        let plain = String(text.characters)
        guard plain.contains("://") || plain.contains("www.") else { return }
        let matches = detector.matches(in: plain, range: NSRange(plain.startIndex..., in: plain))
        for match in matches.reversed() {
            guard let url = match.url, let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme),
                  let range = Range(match.range, in: plain) else { continue }
            let lower = plain.distance(from: plain.startIndex, to: range.lowerBound)
            let length = plain.distance(from: range.lowerBound, to: range.upperBound)
            let start = text.characters.index(text.startIndex, offsetBy: lower)
            let end = text.characters.index(start, offsetBy: length)
            let span = start..<end
            let alreadyStyled = text[span].runs.contains { $0.link != nil || $0.inlinePresentationIntent?.contains(.code) == true }
            if !alreadyStyled { text[span].link = url }
        }
    }

    private final class Box: @unchecked Sendable {
        let blocks: [MarkdownBlock]
        init(_ blocks: [MarkdownBlock]) { self.blocks = blocks }
    }

    nonisolated(unsafe) private static let cache: NSCache<NSString, Box> = {
        let cache = NSCache<NSString, Box>()
        cache.totalCostLimit = 4 << 20
        return cache
    }()
}
