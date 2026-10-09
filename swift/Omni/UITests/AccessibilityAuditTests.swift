#if os(iOS)
import XCTest

/// The system's own accessibility audit (`performAccessibilityAudit`) on each main screen:
/// contrast, clipped text, Dynamic Type, touch-target size, missing or unhelpful labels.
/// Every finding fails the test, with the screen and the element named — except the few
/// listed in `expected`, each with its reason.
final class AccessibilityAuditTests: OmniUITestCase {
    private var findings: [String] = []

    func testEveryMainScreenPassesTheAudit() throws {
        if OmniUITestCase.seeded.isEmpty { seed() }
        let ids = OmniUITestCase.seeded

        launch(token: nil)
        see("Sign in to Omni")
        audit("sign-in")

        launch(faults: "sample-data")
        go(.today)
        see("Stand-up")
        audit("today")
        go(.needsYou)
        see("APPROVE")
        audit("needs-you")
        go(.threads)
        see("Research mooring suppliers")
        audit("threads")
        go(.recurring)
        see("Morning brief")
        audit("recurring")
        openThread(try XCTUnwrap(ids["approval-email"]))
        see("APPROVE")
        audit("thread-with-approval")
        openThread(try XCTUnwrap(ids["card"]))
        see("Call Dana about the buoy spec")
        audit("thread-with-record-card")
        startNewThread()
        wait(composer)
        audit("new-thread")
        let cancel = button("Cancel")
        if cancel.exists { cancel.tap() }
        if Run.usesTabs { go(.today) } else { showSidebar() }
        element("settings.open").tap()
        see("Diagnostics")
        audit("settings")

        XCTAssertTrue(findings.isEmpty, "accessibility audit findings:\n" + findings.joined(separator: "\n"))
    }

    /// Findings that are not the app's to fix, by audit type and a fragment of the element.
    private static let expected: [(type: XCUIAccessibilityAuditType, element: String, why: String)] = [
        // The system's own controls: the tab bar, navigation bar buttons and the keyboard are
        // drawn by iOS; their contrast and text scaling are the system's.
        (.contrast, "TabBar", "the system tab bar"),
        (.dynamicType, "TabBar", "the system tab bar scales through the large-content viewer"),
        (.contrast, "Keyboard", "the system keyboard"),
        (.dynamicType, "NavigationBar", "navigation bar titles scale through the large-content viewer"),
        (.textClipped, "NavigationBar", "a navigation bar title truncates by design; the full title is its label"),
    ]

    private func audit(_ screen: String) {
        pause(0.8)
        do {
            try app.performAccessibilityAudit(for: [.contrast, .elementDetection, .hitRegion, .sufficientElementDescription, .dynamicType, .textClipped, .trait]) { issue in
                let element = issue.element?.debugDescription ?? ""
                let label = issue.element?.label ?? ""
                if Self.expected.contains(where: { $0.type == issue.auditType && element.contains($0.element) }) { return true }
                let short = element.split(separator: "\n").first.map(String.init) ?? ""
                self.findings.append("[\(screen)] \(issue.compactDescription) — “\(label)” \(short.prefix(160))")
                return true
            }
        } catch {
            findings.append("[\(screen)] the audit itself failed: \(error.localizedDescription)")
        }
    }
}
#endif
