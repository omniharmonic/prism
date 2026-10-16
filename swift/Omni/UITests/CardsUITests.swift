import XCTest

/// Needs you with sample cards (`card-sample`: made-up data, nothing from the dev vault):
/// the three sections, a one-tap option, Something else, Not needed, and 44 pt targets.
@MainActor
final class CardsUITests: OmniUITestCase {
    func testNeedsYouSectionsAndOneTapOnACard() throws {
        server { backend in try await backend.reset(keepGone: true) }
        launch(faults: "sample-data,card-sample")
        go(.needsYou)
        // Needs you says "Checking what needs you…" until cards and approvals are both loaded.
        XCTAssertTrue(element("needsYou.section.decide").waitForExistence(timeout: 20), "Decide is shown")
        see("Sam asks whether you can review the grant budget before Friday")
        shot("cards-needs-you")

        let option = element("card.ui-invite.option.later-week")
        reveal(option, "the invite's Ask Ana option")
        bring(option)
        #if os(iOS)
        XCTAssertGreaterThanOrEqual(option.frame.height, 43.9,  // 44 pt, less float rounding
                                     "an option is a full touch target")
        #endif
        option.tap()
        XCTAssertTrue(element("needsYou.section.in-motion").waitForExistence(timeout: 8), "the chosen card moves to In motion")
        shot("cards-in-motion")

        let field = element("card.ui-task.somethingElse")
        reveal(field, "the task's Something else field")
        bring(field)
        field.tap()
        field.typeText("Ask Kevin to renew it before Friday")
        let submit = element("card.ui-task.somethingElse.submit")
        XCTAssertTrue(submit.waitForExistence(timeout: 5))
        submit.tap()
        XCTAssertTrue(gone(element("card.ui-task.somethingElse"), 8), "the instruction started work on the card")

        let notNeeded = element("card.ui-budget.notNeeded")
        reveal(notNeeded, "the budget's Not needed button")
        bring(notNeeded)
        notNeeded.tap()
        XCTAssertTrue(gone(element("card.ui-budget"), 8), "Not needed takes the card away")
        shot("cards-after-actions")
        #if os(iOS)
        try audit()
        #endif
    }

    /// The list is lazy: at the largest text sizes a card further down is not drawn until it is
    /// scrolled near. Scroll until the element exists.
    private func reveal(_ target: XCUIElement, _ what: String, file: StaticString = #filePath, line: UInt = #line) {
        var tries = 0
        while !target.waitForExistence(timeout: 1.5), tries < 14 {
            #if os(iOS)
            scrollPage(down: true)
            #endif
            tries += 1
        }
        XCTAssertTrue(target.exists, "not on screen: \(what)", file: file, line: line)
    }

    #if os(iOS)
    /// The system audit on Needs you with its cards. Contrast and Dynamic Type are left out for the
    /// reasons in AccessibilityAuditTests (ContrastTests checks the colours exactly; the xxxl run
    /// shows the large text). The iPad sidebar is audited by AccessibilityAuditTests, not here.
    private func audit() throws {
        pause(0.8)
        var findings: [String] = []
        try app.performAccessibilityAudit(for: [.elementDetection, .hitRegion, .sufficientElementDescription, .textClipped, .trait]) { issue in
            let frame = issue.element?.frame ?? .null
            if Run.isPad, !frame.isNull, frame.midX < 340 { return true }
            findings.append("\(issue.compactDescription) — “\((issue.element?.label ?? "").prefix(60))” \(frame.isNull ? "" : "\(frame.integral)")")
            return true
        }
        XCTAssertTrue(findings.isEmpty, "accessibility audit findings:\n" + findings.joined(separator: "\n"))
    }
    #endif
}
