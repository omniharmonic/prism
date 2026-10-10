import SwiftUI

/// The app's own colours, as sRGB for light and dark backgrounds. Each is chosen to be READ
/// as small text: at least 4.5:1 against the backgrounds it is used on (white, the grouped
/// grey, black) — `ContrastTests` computes it. The system orange, red, blue and secondary
/// grey are made for icons and fills; as caption-sized text on white they measure 2:1–4:1.
enum Palette {
    typealias RGB = (r: Double, g: Double, b: Double)
    /// Quiet text — captions, previews, times, hints.
    static let quiet: (light: RGB, dark: RGB) = ((0.36, 0.36, 0.39), (0.68, 0.68, 0.71))
    /// Warning text: a deep amber on light backgrounds.
    static let warning: (light: RGB, dark: RGB) = ((0.60, 0.29, 0.00), (1.00, 0.62, 0.04))
    /// Failure text: a deep red on light backgrounds.
    static let failure: (light: RGB, dark: RGB) = ((0.72, 0.11, 0.11), (1.00, 0.42, 0.38))
    /// The accent: the system blue, a step deeper on light backgrounds, so that blue text and
    /// white text on a blue button both read clearly.
    static let accent: (light: RGB, dark: RGB) = ((0.00, 0.36, 0.82), (0.36, 0.66, 1.00))

    /// WCAG 2 contrast ratio between two sRGB colours.
    static func contrast(_ a: RGB, _ b: RGB) -> Double {
        func channel(_ v: Double) -> Double { v <= 0.03928 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4) }
        func luminance(_ c: RGB) -> Double { 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b) }
        let (x, y) = (luminance(a), luminance(b))
        return (max(x, y) + 0.05) / (min(x, y) + 0.05)
    }
}

extension Color {
    static let quietText = adaptive(Palette.quiet)
    static let warningText = adaptive(Palette.warning)
    static let failureText = adaptive(Palette.failure)
    static let omniAccent = adaptive(Palette.accent)

    private static func adaptive(_ pair: (light: Palette.RGB, dark: Palette.RGB)) -> Color {
        #if os(macOS)
        Color(nsColor: NSColor(name: nil) { appearance in
            let c = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? pair.dark : pair.light
            return NSColor(srgbRed: c.r, green: c.g, blue: c.b, alpha: 1)
        })
        #else
        Color(uiColor: UIColor { traits in
            let c = traits.userInterfaceStyle == .dark ? pair.dark : pair.light
            return UIColor(red: c.r, green: c.g, blue: c.b, alpha: 1)
        })
        #endif
    }
}
