import SwiftUI

/// Text colours for a warning and a failure that can be READ on the card and list
/// backgrounds, in light and dark. (The system orange and red are made for icons and fills:
/// as small text on a light background they measure about 2:1 and 3.6:1 against white.)
extension Color {
    /// Warning text: a deep amber on light backgrounds, the system orange on dark ones.
    static let warningText = Color.adaptive(light: (0.60, 0.29, 0.00), dark: (1.00, 0.62, 0.04))
    /// Failure text: a deep red on light backgrounds, a soft red on dark ones.
    static let failureText = Color.adaptive(light: (0.72, 0.11, 0.11), dark: (1.00, 0.42, 0.38))

    /// Quiet text — captions, previews, times, hints. The system's secondary label colour
    /// is about 3.4:1 on white, which the accessibility audit marks down at caption sizes;
    /// this is the same idea at about 7:1 (and 9:1 on black).
    static let quietText = Color.adaptive(light: (0.36, 0.36, 0.39), dark: (0.68, 0.68, 0.71))

    /// The app's accent: the system blue, a step deeper on light backgrounds so that blue
    /// TEXT (plain buttons, a card's "APPROVE" line) and white text on a blue button both
    /// read clearly (about 6:1 against white; the system blue is under 4:1).
    static let omniAccent = Color.adaptive(light: (0.00, 0.36, 0.82), dark: (0.36, 0.66, 1.00))

    private static func adaptive(light: (Double, Double, Double), dark: (Double, Double, Double)) -> Color {
        #if os(macOS)
        Color(nsColor: NSColor(name: nil) { appearance in
            let c = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light
            return NSColor(srgbRed: c.0, green: c.1, blue: c.2, alpha: 1)
        })
        #else
        Color(uiColor: UIColor { traits in
            let c = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(red: c.0, green: c.1, blue: c.2, alpha: 1)
        })
        #endif
    }
}
