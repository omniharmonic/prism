import XCTest

/// The walk: every screen and state of the app, in the order a person would meet them, with
/// a screenshot of each. Runs against the laptop dev backend (stub Hermes; nothing can send).
final class OmniWalkTests: OmniUITestCase {
    /// What `seed()` made, by a short name.
    nonisolated(unsafe) private static var seeded: [String: String] = [:]

    // MARK: Before the app

    func test01FirstRunAndSignIn() {
        launch(token: nil, firstRun: true)
        see("Welcome to Omni")
        shot("first-run-server")

        // An address that cannot be one: the reason is said in words, on the same screen.
        let field = app.textFields["Server address"].firstMatch
        wait(field)
        clear(field)
        field.typeText("not an address")
        button("Continue").tap()
        wait(element("server.error"), 5, "the reason the address was refused")
        shot("first-run-bad-address")

        // Typing again takes the old reason away.
        clear(field)
        field.typeText(Run.server)
        XCTAssertTrue(gone(element("server.error"), 3), "the old reason stayed up over a new address")
        shot("first-run-address-typed")
        button("Continue").tap()
        see("Sign in to Omni")
        shot("sign-in")

        button("Sign In").tap()
        see("Finish signing in in your browser")
        shot("signing-in-waiting")
        button("Cancel").tap()
        see("Sign in to Omni")

        button("Change Server…").tap()
        see("Welcome to Omni")
    }

    func test02CannotConnect() {
        launch(token: nil, server: "http://127.0.0.1:18699") // nothing listens there
        see("Can't connect", 30)
        shot("cant-connect")
        button("Try Again").tap()
        see("Can't connect", 30)
        button("Change Server…").tap()
        see("Welcome to Omni")
    }

    // MARK: A thread the agent no longer has

    func test03GoneThread() throws {
        server { try await $0.reset(keepGone: true) }
        let goneID = server { backend in try await backend.threads().first { $0["gone"] as? Bool == true }?["id"] as? String } ?? nil
        let id = try XCTUnwrap(goneID, "no ‘no longer available’ sample thread (Scripts/uitest.sh adds one)")
        launch(faults: "sample-data")
        if Run.usesTabs { go(.threads) }
        see("No longer available")
        shot("threads-gone-row")
        openThread(id)
        see("This conversation is no longer available")
        shot("thread-gone")
        button("Check Again").tap()
        see("This conversation is no longer available")
        button("Remove from List").tap()
        XCTAssertTrue(gone(element("thread.\(id)"), 10), "the removed thread is still listed")
        // …and the person is not left on a dead screen.
        XCTAssertTrue(gone(text("This conversation is no longer available"), 5), "still on the dead thread after removing it")
        shot("thread-gone-removed")
    }

    // MARK: Nothing yet

    func test04EmptyApp() {
        server { try await $0.reset() }
        launch(faults: "sample-data")
        go(.today)
        see("Nothing needs a decision")
        shot("today-empty")
        go(.needsYou)
        see("Nothing needs you")
        shot("needs-you-empty")
        go(.threads)
        see("No threads yet")
        shot("threads-empty")

        go(.recurring)
        see("Morning brief")
        shot("recurring")
        let pauseJob = app.buttons["Pause Morning brief (stub)"].firstMatch
        wait(pauseJob)
        pauseJob.tap()
        let resume = app.buttons["Resume Morning brief (stub)"].firstMatch
        wait(resume, 10, "Resume, after pausing")
        shot("recurring-paused")
        resume.tap()
        wait(app.buttons["Pause Morning brief (stub)"].firstMatch, 10, "Pause, after resuming")

        // The reads that do not get through.
        launch(faults: "today-fail,threads-fail,jobs-fail")
        go(.today)
        wait(button("Try Again"), 15, "Try Again on a Today that did not load")
        shot("today-failed")
        go(.threads)
        pause(1)
        shot("threads-failed")
        go(.recurring)
        wait(button("Try Again"), 15, "Try Again on a jobs list that did not load")
        shot("recurring-failed")
    }

    // MARK: The list, in every state

    func test05ThreadListSearchAndToday() {
        seed()
        launch(faults: "sample-data")
        go(.threads)
        see("Research mooring suppliers")
        shot("threads-all-states")
        if Run.usesTabs || Run.variant == "narrow" {
            threadList.swipeUp()
            shot("threads-all-states-lower")
            threadList.swipeDown()
            threadList.swipeDown()
        }

        // Search.
        let search = app.searchFields.firstMatch
        #if os(macOS)
        app.typeKey("f", modifierFlags: .command)
        #else
        if !search.exists { threadList.swipeDown() }
        #endif
        wait(search, 10, "the search field")
        search.tap()
        search.typeText("mooring")
        see("Research mooring suppliers")
        XCTAssertTrue(gone(text("Summarise yesterday"), 8), "search did not narrow the list")
        shot("threads-search")
        clearSearch(search)
        search.tap()
        search.typeText("zzzz-nothing")
        see("No threads match that search")
        shot("threads-search-no-match")
        clearSearch(search)
        cancelSearch()

        go(.today)
        see("Stand-up")
        see("Research mooring suppliers") // in flight
        shot("today-loaded")
        #if os(iOS)
        app.collectionViews.firstMatch.swipeUp()
        shot("today-loaded-lower")
        #endif

        // From Today into the queue and into a thread, and back.
        #if os(iOS)
        app.collectionViews.firstMatch.swipeDown()
        #endif
        let inFlight = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Research mooring suppliers'")).firstMatch
        if inFlight.waitForExistence(timeout: 5) {
            inFlight.tap()
            wait(composer, 10, "the thread opened from Today")
        } else {
            XCTFail("Today's in-flight row is not a button")
        }

        launch(faults: "sample-data,today-partial")
        go(.today)
        see("Some of Today couldn't be loaded")
        shot("today-partial")
    }

    // MARK: A thread, live

    func test06NewThreadStreamingAndStop() {
        launch(faults: "sample-data")
        startNewThread()
        wait(composer, 10, "the new-thread composer")
        shot("new-thread")
        composer.tap()
        composer.typeText("Compare the two mooring quotes and say which is cheaper. stub:slow:40")
        shot("new-thread-typed")
        send()
        // The thread opens and the answer streams.
        wait(stopButton, 20, "Stop, while the answer streams")
        pause(3)
        shot("thread-streaming")
        #if os(macOS)
        app.typeKey(".", modifierFlags: .command)
        #else
        stopButton.tap()
        #endif
        wait(sendButton, 20, "Send again, after stopping")
        see("stopped", 10)
        shot("thread-stopped")

        // A normal turn: text, a tool, the answer. The focus is in the composer.
        composer.tap()
        composer.typeText("What is on the list for the retreat?")
        #if os(iOS)
        shot("composer-keyboard-up")
        #endif
        send()
        let chip = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH 'Tool:'")).firstMatch
        if chip.waitForExistence(timeout: 15) {
            shot("thread-tool-chip")
        } else {
            XCTFail("no tool chip while the turn streamed")
        }
        wait(sendButton, 30, "Send again, after the turn")
        pause(1)
        shot("thread-turn-done")

        // A long message: the box grows, and the transcript stays reachable.
        composer.tap()
        composer.typeText("One\nTwo\nThree\nFour\nFive — a longer line that should wrap inside the box rather than run off its edge, however narrow the window is.")
        shot("composer-multiline")
        #if os(iOS)
        // The keyboard goes away when the conversation is dragged.
        element("transcript").swipeDown()
        XCTAssertTrue(gone(app.keyboards.firstMatch, 5), "the keyboard cannot be put away by dragging the conversation")
        shot("composer-keyboard-dismissed")
        #endif
    }

    // MARK: Threads that went wrong, or carry something

    func test07ThreadStates() throws {
        if Self.seeded.isEmpty { seed() }
        let ids = Self.seeded
        launch(faults: "sample-data")

        openThread(try XCTUnwrap(ids["error"]))
        wait(composer)
        pause(1)
        shot("thread-error")

        openThread(try XCTUnwrap(ids["drop"]))
        wait(composer)
        pause(1)
        shot("thread-connection-dropped")

        // A tool that failed, and an answer with nothing in it.
        openThread(try XCTUnwrap(ids["toolfail"]))
        wait(composer)
        pause(1)
        shot("thread-tool-failed")

        openThread(try XCTUnwrap(ids["empty"]))
        wait(composer)
        pause(1)
        shot("thread-empty-answer")

        if let card = ids["card"] {
            openThread(card)
            see("Call Dana about the buoy spec")
            shot("thread-record-card")
        } else {
            XCTFail("no record-card thread was seeded (Today had no note to point at)")
        }

        openThread(try XCTUnwrap(ids["followup"]))
        wait(composer)
        pause(1)
        shot("thread-followup-unread-opened")

        // A turn that is still running when the thread is opened: it re-attaches.
        openThread(try XCTUnwrap(ids["working"]))
        wait(stopButton, 20, "Stop on a thread opened mid-turn")
        pause(2)
        shot("thread-working-reattached")

        openThread(try XCTUnwrap(ids["waiting"]))
        wait(composer)
        pause(1)
        shot("thread-waiting")
    }

    // MARK: Approvals

    func test08Approvals() throws {
        if Self.seeded.isEmpty { seed() }
        let ids = Self.seeded
        launch(faults: "sample-data")

        go(.needsYou)
        see("APPROVE")
        shot("needs-you-list")

        for kind in ["email", "email-reply", "message", "calendar-invite", "tweet", "wallet-proposal"] {
            openThread(try XCTUnwrap(ids["approval-\(kind)"]))
            see("APPROVE", 15)
            wait(button("Revise…"), 10, "Revise on the \(kind) draft")
            pause(0.5)
            shot("approval-\(kind)")
        }

        // The email draft: Send (sending is off on this server), Edit, Revise, Cancel.
        openThread(try XCTUnwrap(ids["approval-email"]))
        wait(button("Send"), 15, "Send on the email draft")
        button("Send").tap()
        see("nothing was sent", 15)
        shot("approval-send-switched-off")

        button("Edit").tap()
        let subject = app.textFields["Subject"].firstMatch
        wait(subject, 10, "the Subject field of the edit sheet")
        shot("approval-edit-sheet")
        subject.tap()
        subject.typeText(" (v2)")
        button("Save").tap()
        see("(v2)", 15)
        pause(1)
        shot("approval-edited")

        button("Revise…").tap()
        let feedback = app.descendants(matching: .any).matching(NSPredicate(format: "label == 'What should change' AND (elementType == %d OR elementType == %d)", XCUIElement.ElementType.textField.rawValue, XCUIElement.ElementType.textView.rawValue)).firstMatch
        wait(feedback, 10, "the revise sheet's field")
        feedback.tap()
        feedback.typeText("Make it shorter and mention Friday.")
        shot("approval-revise-sheet")
        button("Ask Omni").tap()
        see("REVISED", 20)
        wait(button("Send"), 30, "a new draft after Revise")
        pause(1)
        shot("approval-revised-new-draft")

        button("Cancel Draft").tap()
        let confirm = app.buttons.matching(NSPredicate(format: "label == 'Cancel Draft'"))
        pause(1)
        shot("approval-cancel-confirm")
        confirm.element(boundBy: confirm.count - 1).tap()
        see("CANCELLED", 15)
        pause(1)
        shot("approval-cancelled")

        // A draft that does not match the server's fingerprint: Send is not offered.
        launch(faults: "sample-data,digest-mismatch")
        go(.needsYou)
        see("CAN'T VERIFY", 20)
        XCTAssertFalse(button("Send").exists, "Send is offered for a draft that does not match its fingerprint")
        wait(button("Reload"), 5, "Reload on a mismatched draft")
        shot("approval-digest-mismatch")
    }

    // MARK: Settings, diagnostics, sign out

    func test09SettingsAndSignOut() {
        launch(token: Run.signOutToken, faults: "sample-data")
        go(.today)
        see("Stand-up")
        openSettings()
        see("Diagnostics")
        shot("settings", window: settingsWindow)
        #if os(iOS)
        app.collectionViews.firstMatch.swipeUp()
        shot("settings-diagnostics")
        #endif
        let copy = button("Copy All")
        wait(copy, 10, "Copy All in Diagnostics")
        copy.tap()
        wait(button("Copied"), 3, "Copied, after Copy All")
        #if os(iOS)
        app.collectionViews.firstMatch.swipeDown()
        #endif

        button("Sign Out").tap()
        pause(1)
        shot("sign-out-confirm", window: settingsWindow)
        let confirm = app.buttons.matching(NSPredicate(format: "label == 'Sign Out'"))
        confirm.element(boundBy: confirm.count - 1).tap()
        #if os(macOS)
        app.typeKey("w", modifierFlags: .command)
        #endif
        see("Sign in to Omni", 20)
        shot("signed-out")
    }

    #if os(macOS)
    // MARK: Mac keys and the window

    func test10MacKeysAndWindow() {
        if Self.seeded.isEmpty { seed() }
        launch(faults: "sample-data")
        see("Stand-up")
        app.typeKey("n", modifierFlags: .command)
        wait(composer, 10, "⌘N: the new-thread composer")
        XCTAssertTrue(composerHasFocus, "⌘N did not put the cursor in the composer")
        composer.typeText("First line")
        composer.typeKey(.return, modifierFlags: .shift)
        composer.typeText("second line")
        XCTAssertTrue((composer.value as? String ?? "").contains("\n"), "Shift-Return did not start a new line")
        shot("mac-shift-return")
        composer.typeKey(.return, modifierFlags: [])
        wait(sendButton, 30, "Return sent the message and the turn ended")
        XCTAssertTrue(composerHasFocus, "the cursor is not in the composer after a thread opened")
        app.typeKey("r", modifierFlags: .command)
        app.typeKey("f", modifierFlags: .command)
        wait(app.searchFields.firstMatch, 5, "⌘F: the search field")
        app.typeKey(",", modifierFlags: .command)
        wait(settingsWindow, 5, "⌘,: Settings")
        shot("mac-settings", window: settingsWindow)
        settingsWindow.typeKey("w", modifierFlags: .command)
    }

    private var composerHasFocus: Bool {
        (composer.value(forKey: "hasKeyboardFocus") as? Bool) ?? false
    }
    #endif

    // MARK: Helpers

    var settingsWindow: XCUIElement? {
        #if os(macOS)
        return app.windows.matching(NSPredicate(format: "title != 'Omni'")).firstMatch
        #else
        return nil
        #endif
    }

    func openSettings() {
        #if os(macOS)
        app.typeKey(",", modifierFlags: .command)
        #else
        if Run.usesTabs { go(.today) } else { showSidebar() }
        let gear = element("settings.open")
        wait(gear, 10, "the Settings button")
        gear.tap()
        #endif
    }

    func send() {
        #if os(macOS)
        composer.typeKey(.return, modifierFlags: [])
        #else
        sendButton.tap()
        #endif
    }

    private func clear(_ field: XCUIElement) {
        field.tap()
        #if os(macOS)
        field.typeKey("a", modifierFlags: .command)
        field.typeKey(.delete, modifierFlags: [])
        #else
        let existing = (field.value as? String) ?? ""
        if !existing.isEmpty, existing != field.placeholderValue {
            field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: existing.count + 2))
        }
        #endif
    }

    private func clearSearch(_ search: XCUIElement) {
        let existing = (search.value as? String) ?? ""
        search.tap()
        if !existing.isEmpty { search.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: existing.count + 2)) }
    }

    private func cancelSearch() {
        #if os(iOS)
        let cancel = app.buttons.matching(NSPredicate(format: "label IN {'Cancel', 'Close'}")).firstMatch
        if cancel.exists, cancel.isHittable { cancel.tap() }
        #else
        app.typeKey(.escape, modifierFlags: [])
        #endif
    }

    /// One thread in every state the list can show, and one draft of every kind.
    func seed() {
        let made = server { backend -> [String: String] in
            try await backend.reset()
            var ids: [String: String] = [:]
            ids["done"] = try await backend.thread("Summarise yesterday's notes", "Summarise yesterday's notes in five lines.")
            ids["scheduled"] = try await backend.thread("Check the forecast on Friday", "Check the marine forecast on Friday morning and tell me if the crossing is on.")
            ids["error"] = try await backend.thread("Look up the tide tables", "Look up the tide tables for Saturday. stub:error")
            ids["drop"] = try await backend.thread("Draft the packing list", "Draft the packing list for the retreat. stub:drop")
            ids["toolfail"] = try await backend.thread("File the receipts", "File last month's receipts. stub:toolfail:sample-note-2")
            ids["empty"] = try await backend.thread("Name the boat", "Suggest a name for the boat. stub:empty")
            // A made-up note id: the gateway builds the card without asking the vault for it.
            ids["card"] = try await backend.thread("Update the task for Dana", "Mark the call with Dana as due Friday. stub:card:sample-note-1")
            for id in ids.values { try await backend.settle(id) }
            if let scheduled = ids["scheduled"] { _ = try await backend.call("PATCH", "/api/omni/threads/\(scheduled)", ["state": "scheduled"]) }

            let waiting = try await backend.thread("Compare the two quotes", "Compare the two mooring quotes. stub:slow:900")
            ids["waiting"] = waiting
            try await Task.sleep(for: .seconds(2))
            try await backend.stopTurn(in: waiting)

            let drafts = [
                ("email", "Email Kevin about the buoy spec"), ("email-reply", "Reply to Dana"), ("message", "Message the hardware room"),
                ("calendar-invite", "Invite for the spec review"), ("tweet", "Post about the retreat"), ("wallet-proposal", "Pay the venue deposit"),
            ]
            for (kind, title) in drafts {
                let id = try await backend.thread(title, "\(title). stub:approval:\(kind)")
                ids["approval-\(kind)"] = id
                try await backend.settle(id)
            }
            ids["followup"] = try await backend.thread("Find the grant deadline", "Find the grant deadline. stub:followup")
            ids["working"] = try await backend.thread("Research mooring suppliers", "Research mooring suppliers near the harbour. stub:slow:900")
            // The follow-up arrives three seconds after its turn: wait for the unread dot.
            if let followup = ids["followup"] {
                try await backend.settle(followup)
                for _ in 0..<30 {
                    if try await backend.state(of: followup).unread > 0 { break }
                    try await Task.sleep(for: .milliseconds(300))
                }
            }
            return ids
        }
        Self.seeded = made ?? [:]
        XCTAssertFalse(Self.seeded.isEmpty, "seeding the backend failed")
    }
}
