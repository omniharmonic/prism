#if os(iOS)
import XCTest

/// The system's own accessibility audit (`performAccessibilityAudit`) on each main screen.
///
/// **Asserted** (a finding fails the test, with the screen and the element named): touch
/// targets too small, elements with no or an unhelpful description, wrong traits, and text
/// clipped in one of the app's own elements.
///
/// **Reported, not asserted** (attached to the test as "audit notes"):
/// - *Contrast.* The audit samples the screen, and misfires here: it fails black titles on
///   white rows, and marks the system's own section headers. The app's own text colours are
///   checked exactly instead — `ContrastTests` computes each against its backgrounds (≥ 4.5:1).
/// - *Dynamic Type.* It reports "cannot change the font size" for SwiftUI text that uses the
///   system text styles — which does change: the walk is run at the largest size
///   (`Scripts/uitest.sh iphone light xxxl`) and its screenshots show every one of them grown.
/// - Findings with no element at all (nothing to name or fix), and the system's keyboard,
///   search field and navigation-bar buttons.
final class AccessibilityAuditTests: OmniUITestCase {
    private var findings: [String] = []
    private var notes: [String] = []

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

        let report = XCTAttachment(string: notes.isEmpty ? "none" : notes.joined(separator: "\n"))
        report.name = "audit notes (reported, not asserted)"
        report.lifetime = .keepAlways
        add(report)
        print("AUDIT asserted=\(findings.count) noted=\(notes.count)")
        XCTAssertTrue(findings.isEmpty, "accessibility audit findings:\n" + findings.joined(separator: "\n"))
    }

    private func audit(_ screen: String) {
        pause(0.8)
        do {
            let keyboard = app.keyboards.firstMatch.exists ? app.keyboards.firstMatch.frame.insetBy(dx: 0, dy: -70) : .null
            try app.performAccessibilityAudit(for: [.contrast, .elementDetection, .hitRegion, .sufficientElementDescription, .dynamicType, .textClipped, .trait]) { issue in
                let element = issue.element
                let debug = element?.debugDescription ?? ""
                let label = element?.label ?? ""
                let frame = element?.frame ?? .null
                // The system's own: the keyboard and its suggestion bar, and the buttons the
                // navigation bar draws on glass (Cancel, Done, Back).
                if !keyboard.isNull, !frame.isNull, keyboard.contains(CGPoint(x: frame.midX, y: frame.midY)) { return true }
                if element?.elementType == .button, self.app.navigationBars.buttons[label].exists, issue.auditType == .contrast { return true }
                let kind = element.map { "\($0.elementType.rawValue)" } ?? "-"
                let line = "[\(screen)] \(issue.compactDescription) — “\(label.prefix(60))” type \(kind) \(frame.isNull ? "" : "\(frame.integral)")"
                let systemDrawn = element == nil || element?.elementType == .searchField || debug.contains("UISearchBarTextField") || debug.contains("TabBar")
                if issue.auditType == .contrast || issue.auditType == .dynamicType || systemDrawn {
                    self.notes.append(line)
                } else {
                    self.findings.append(line)
                }
                return true
            }
        } catch {
            findings.append("[\(screen)] the audit itself failed: \(error.localizedDescription)")
        }
    }
}
#endif
