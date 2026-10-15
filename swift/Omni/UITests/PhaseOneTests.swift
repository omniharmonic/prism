import XCTest

/// "Fix what you can see": New Chat on every screen (also with the iPad's sidebar put away),
/// one place for Settings, and an answer's markdown drawn as blocks — headings, lists, a quote,
/// code — rather than as raw `##` and `-`.
@MainActor
final class PhaseOneTests: OmniUITestCase {
    func testNewChatFromEveryScreenAndMarkdown() throws {
        let ids = server { backend -> [String: String] in
            try await backend.reset(keepGone: true)
            var ids: [String: String] = [:]
            ids["markdown"] = try await backend.thread("Markdown sample", "Show me the markdown sample. stub:plain")
            ids["approval"] = try await backend.thread("Email Kevin about the buoy spec", "Email Kevin about the buoy spec. stub:approval:email")
            for id in ids.values { try await backend.settle(id) }
            return ids
        } ?? [:]
        let markdown = try XCTUnwrap(ids["markdown"])
        launch(faults: "sample-data,markdown-sample")

        // Today.
        go(.today)
        see("Stand-up")
        collapseSidebar()
        shot("p1-today")
        newChat(from: "Today")

        // Needs you.
        go(.needsYou)
        see("Email Kevin about the buoy spec")
        collapseSidebar()
        shot("p1-needs-you")
        newChat(from: "Needs you")

        // Recurring.
        go(.recurring)
        see("Recurring")
        collapseSidebar()
        newChat(from: "Recurring")

        // A thread whose answer is markdown.
        openThread(markdown)
        see("Mooring options")
        collapseSidebar()
        shot("p1-thread-markdown")
        XCTAssertFalse(text("## Mooring").exists, "the heading's markdown is shown raw")
        XCTAssertFalse(text("```").exists, "the code fence is shown raw")
        newChat(from: "a thread")
        if Run.usesTabs {
            // The Threads tab's own list keeps New Chat too.
            go(.threads)
            XCTAssertTrue(element("thread.new").waitForExistence(timeout: 5), "New Chat on the Threads list")
            shot("p1-threads")
        }

        // Settings: leading on the iPhone's top-level screens, in the sidebar on an iPad.
        if Run.usesTabs {
            for place in [Place.today, .needsYou, .threads] {
                go(place)
                XCTAssertTrue(element("settings.open").waitForExistence(timeout: 5), "Settings on \(place)")
            }
        }
    }

    /// New Chat is in the bar, labelled "New Chat", and opens the new-chat composer.
    private func newChat(from screen: String, file: StaticString = #filePath, line: UInt = #line) {
        let new = element("thread.new")
        guard wait(new, 8, "New Chat on \(screen)", file: file, line: line) else { return }
        XCTAssertEqual(new.label, "New Chat", file: file, line: line)
        XCTAssertTrue(new.isHittable, "New Chat on \(screen) can be pressed", file: file, line: line)
        new.tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 8), "New Chat from \(screen) opened the composer", file: file, line: line)
        XCTAssertTrue(app.navigationBars["New Chat"].waitForExistence(timeout: 5), "the composer is titled New Chat", file: file, line: line)
        shot("p1-new-chat-from-\(screen.lowercased().replacingOccurrences(of: " ", with: "-"))")
        let cancel = element("voice.sheet.close")
        if cancel.exists { cancel.tap() }
        hideKeyboard()
    }

    /// iPad with a sidebar: put it away, so the content column (and its bar) is all there is.
    private func collapseSidebar() {
        #if os(iOS)
        guard Run.isPad, !Run.usesTabs else { return }
        hideKeyboard()
        guard element("nav.today").exists else { return }
        let toggle = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'sidebar'")).firstMatch
        if toggle.exists { toggle.tap() }
        _ = gone(element("nav.today"), 5)
        pause(0.8)
        #endif
    }
}
