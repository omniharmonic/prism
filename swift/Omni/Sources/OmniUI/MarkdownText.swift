import OmniCore
import SwiftUI

/// Markdown drawn as blocks: headings, paragraphs, bullet and numbered lists (nested), quotes,
/// fenced code, rules and tables, each with its inline styling and links. The parsing is
/// `MarkdownBlocks` (OmniCore, Foundation's parser); this only lays the blocks out.
///
/// Every block is its own `Text`, so text selection works as it does for any `Text`: on the
/// Mac by dragging within a block, on iPhone and iPad by a long press. Links open with the
/// environment's `openURL`.
struct MarkdownText: View {
    let markdown: String
    /// Parse afresh on every change (streaming) rather than through the cache, which would
    /// keep every partial answer.
    var streaming = false

    var body: some View {
        let blocks = streaming ? MarkdownBlocks.parse(markdown) : MarkdownBlocks.cached(markdown)
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { index, block in
                MarkdownBlockView(block: block)
                    .padding(.top, index == 0 ? 0 : Self.gap(blocks[index - 1], block))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Items of one list sit close; everything else has a paragraph's gap; a heading has a
    /// little more above it.
    private static func gap(_ previous: MarkdownBlock, _ block: MarkdownBlock) -> CGFloat {
        if case .heading = block.kind { return 14 }
        if previous.list != nil, previous.list == block.list { return 4 }
        return 8
    }
}

private struct MarkdownBlockView: View {
    let block: MarkdownBlock
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        content
            .padding(.leading, block.quoteDepth > 0 ? CGFloat(block.quoteDepth) * 12 : 0)
            .overlay(alignment: .leading) {
                if block.quoteDepth > 0 {
                    RoundedRectangle(cornerRadius: 1.5).fill(Color.quietText.opacity(0.45)).frame(width: 3)
                        .accessibilityHidden(true)
                }
            }
            .foregroundStyle(block.quoteDepth > 0 ? AnyShapeStyle(Color.quietText) : AnyShapeStyle(.primary))
    }

    @ViewBuilder private var content: some View {
        if block.listDepth > 0 {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(markerText)
                    .monospacedDigit()
                    .foregroundStyle(Color.quietText)
                    .frame(minWidth: markerWidth, alignment: .trailing)
                    .opacity(block.marker == nil ? 0 : 1)
                    .accessibilityHidden(true)
                blockBody
            }
            .padding(.leading, CGFloat(block.listDepth - 1) * 18)
        } else {
            blockBody
        }
    }

    @ViewBuilder private var blockBody: some View {
        switch block.kind {
        case .paragraph:
            Text(block.text).fixedSize(horizontal: false, vertical: true)
        case .heading(let level):
            Text(block.text)
                .font(Self.font(level))
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
        case .code:
            ScrollView(.horizontal, showsIndicators: false) {
                Text(String(block.text.characters))
                    .font(.system(.callout, design: .monospaced))
                    .fixedSize(horizontal: true, vertical: true)
                    .padding(10)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 8))
        case .rule:
            Divider().padding(.vertical, 4)
        case .table:
            ScrollView(.horizontal, showsIndicators: false) {
                Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 14, verticalSpacing: 6) {
                    ForEach(Array(block.rows.enumerated()), id: \.offset) { index, row in
                        GridRow {
                            ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
                                Text(cell).fontWeight(index == 0 ? .semibold : nil).fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        if index == 0 { Divider().gridCellUnsizedAxes(.horizontal) }
                    }
                }
                .padding(.vertical, 2)
            }
        }
    }

    private var markerText: String {
        switch block.marker {
        case .number(let n): return "\(n)."
        case .bullet, nil: return block.listDepth > 1 ? "◦" : "•"
        }
    }

    /// Room for "10." at the reading sizes; it grows with the text.
    private var markerWidth: CGFloat {
        if case .number = block.marker { return typeSize.isAccessibilitySize ? 44 : 22 }
        return typeSize.isAccessibilitySize ? 22 : 12
    }

    private static func font(_ level: Int) -> Font {
        switch level {
        case 1: return .title2.weight(.semibold)
        case 2: return .title3.weight(.semibold)
        case 3: return .headline
        default: return .subheadline.weight(.semibold)
        }
    }
}
