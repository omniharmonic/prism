@testable import OmniUI
import XCTest

/// The app's own text colours against the backgrounds they are used on: at least 4.5:1
/// (WCAG AA for small text). Computed, so it does not depend on a screenshot.
final class ContrastTests: XCTestCase {
    func testTheAppsTextColoursCanBeReadOnEveryBackgroundTheyAreUsedOn() {
        let white: Palette.RGB = (1, 1, 1)
        let grouped: Palette.RGB = (0.949, 0.949, 0.969)      // the grouped-list grey (light)
        let black: Palette.RGB = (0, 0, 0)
        let raised: Palette.RGB = (0.110, 0.110, 0.118)       // a card or grouped row (dark)
        for (name, colour) in [("quiet", Palette.quiet), ("warning", Palette.warning), ("failure", Palette.failure), ("accent", Palette.accent)] {
            for (background, rgb) in [("white", white), ("grouped grey", grouped)] {
                XCTAssertGreaterThanOrEqual(Palette.contrast(colour.light, rgb), 4.5, "\(name) text on \(background)")
            }
            for (background, rgb) in [("black", black), ("a raised dark surface", raised)] {
                XCTAssertGreaterThanOrEqual(Palette.contrast(colour.dark, rgb), 4.5, "\(name) text on \(background)")
            }
        }
        // White text on the accent (the Send button).
        XCTAssertGreaterThanOrEqual(Palette.contrast(white, Palette.accent.light), 4.5)
        // The system colours these replaced, for the record: none reaches 4.5 on white.
        XCTAssertLessThan(Palette.contrast((1.0, 0.584, 0.0), white), 4.5, "system orange")
        XCTAssertLessThan(Palette.contrast((0.0, 0.478, 1.0), white), 4.5, "system blue")
    }
}
