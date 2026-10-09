import XCTest

/// The walk: every screen and state of the app, in the order a person would meet them, with
/// a screenshot of each. Runs against the laptop dev backend (stub Hermes; nothing can send).
final class OmniWalkTests: OmniUITestCase {
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
        press("Continue")
        wait(element("server.error"), 5, "the reason the address was refused")
        shot("first-run-bad-address")

        // Typing again takes the old reason away.
        clear(field)
        field.typeText(Run.server)
        XCTAssertTrue(gone(element("server.error"), 3), "the old reason stayed up over a new address")
        shot("first-run-address-typed")
        press("Continue")
        see("Sign in to Omni")
        shot("sign-in")

        press("Sign In")
        see("Finish signing in in your browser")
        shot("signing-in-waiting")
        press("Cancel")
        see("Sign in to Omni")

        press("Change Server…")
        see("Welcome to Omni")
    }

    func test02CannotConnect() {
        launch(token: nil, server: "http://127.0.0.1:18699") // nothing listens there
        see("Can't connect", 30)
        shot("cant-connect")
        press("Try Again")
        see("Can't connect", 30)
        press("Change Server…")
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
        press("Check Again")
        see("This conversation is no longer available")
        press("Remove from List")
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
        bring(pauseJob)
        pauseJob.tap()
        let resume = app.buttons["Resume Morning brief (stub)"].firstMatch
        wait(resume, 10, "Resume, after pausing")
        shot("recurring-paused")
        bring(resume)
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
        for _ in 0..<30 where !search.exists { scrollPage(down: false) } // the field sits above the top of the list
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
        shot("today-loaded")
        #if os(iOS)
        if Run.usesTabs {
            app.collectionViews.firstMatch.swipeUp()
            shot("today-loaded-lower")
        }
        #endif

        // From Today into a thread.
        see("Omni is working on", 6)
        let inFlight = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Research mooring suppliers'")).firstMatch
        #if os(iOS)
        for _ in 0..<10 where !inFlight.exists { scrollPage(down: true) }
        #endif
        if inFlight.waitForExistence(timeout: 5) {
            bring(inFlight)
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
        showKeyboard()
        shot("composer-keyboard-up")
        #endif
        send()
        let chip = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH 'Tool:'")).firstMatch
        if chip.waitForExistence(timeout: 15) { shot("thread-tool-chip") }
        wait(sendButton, 30, "Send again, after the turn")
        // The chip stays in the conversation once the turn is over.
        see("Tool:", 10)
        pause(1)
        shot("thread-turn-done")

        // A long message: the box grows, and the transcript stays reachable.
        composer.tap()
        composer.typeText("One\nTwo\nThree\nFour\nFive — a longer line that should wrap inside the box rather than run off its edge, however narrow the window is.")
        showKeyboard()
        shot("composer-multiline")
        #if os(iOS)
        // The end of the conversation stays in view above the box and the keyboard.
        XCTAssertTrue(text("I answer the same way every time").isHittable, "the end of the conversation is hidden behind the message box")
        // The keyboard goes away: by its Done button…
        let done = element("composer.hideKeyboard")
        wait(done, 5, "Done above the keyboard")
        done.tap()
        XCTAssertTrue(gone(app.keyboards.firstMatch, 5), "Done did not put the keyboard away")
        shot("composer-keyboard-dismissed")
        // …and by dragging the conversation down.
        composer.tap()
        showKeyboard()
        let top = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.22))
        top.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)), withVelocity: .default, thenHoldForDuration: 0.1)
        XCTAssertTrue(gone(app.keyboards.firstMatch, 5), "the keyboard cannot be put away by dragging the conversation")
        #endif
    }

    // MARK: Threads that went wrong, or carry something

    func test07ThreadStates() throws {
        if OmniUITestCase.seeded.isEmpty { seed() }
        let ids = OmniUITestCase.seeded
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
        if OmniUITestCase.seeded.isEmpty { seed() }
        let ids = OmniUITestCase.seeded
        launch(faults: "sample-data")

        go(.needsYou)
        see("APPROVE")
        shot("needs-you-list")

        for kind in ["email", "email-reply", "message", "calendar-invite", "tweet", "wallet-proposal"] {
            openThread(try XCTUnwrap(ids["approval-\(kind)"]))
            see("APPROVE", 15)
            wait(element("approval.revise"), 10, "Revise on the \(kind) draft")
            pause(0.5)
            shot("approval-\(kind)")
        }

        // The email draft: Send (sending is off on this server), Edit, Revise, Cancel.
        openThread(try XCTUnwrap(ids["approval-email"]))
        wait(element("approval.send"), 15, "Send on the email draft")
        press("approval.send")
        see("nothing was sent", 15)
        shot("approval-send-switched-off")

        press("approval.edit")
        let subject = app.textFields["Subject"].firstMatch
        wait(subject, 10, "the Subject field of the edit sheet")
        shot("approval-edit-sheet")
        subject.tap()
        subject.typeText(" (v2)")
        press("Save")
        see("(v2)", 15)
        pause(1)
        shot("approval-edited")

        press("approval.revise")
        let feedback = app.descendants(matching: .any).matching(NSPredicate(format: "label == 'What should change' AND (elementType == %d OR elementType == %d)", XCUIElement.ElementType.textField.rawValue, XCUIElement.ElementType.textView.rawValue)).firstMatch
        wait(feedback, 10, "the revise sheet's field")
        feedback.tap()
        feedback.typeText("Make it shorter and mention Friday.")
        shot("approval-revise-sheet")
        press("Ask Omni")
        see("REVISED", 20)
        wait(element("approval.send"), 30, "a new draft after Revise")
        pause(1)
        shot("approval-revised-new-draft")

        press("approval.cancel")
        // The confirmation carries a second "Cancel Draft".
        let confirm = app.buttons.matching(NSPredicate(format: "label == 'Cancel Draft'"))
        let asked = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in confirm.count >= 2 }, object: nil)
        XCTAssertEqual(XCTWaiter().wait(for: [asked], timeout: 8), .completed, "Cancel Draft did not ask first")
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
        XCTAssertFalse(element("approval.send").exists, "Send is offered for a draft that does not match its fingerprint")
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
        bring(copy)
        copy.tap()
        wait(button("Copied"), 3, "Copied, after Copy All")
        XCTAssertFalse(element("diagnostics.count").label.hasPrefix("0 lines"), "Copy All also cleared the list")
        #if os(iOS)
        app.collectionViews.firstMatch.swipeDown()
        #endif

        press("Sign Out")
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
        if OmniUITestCase.seeded.isEmpty { seed() }
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

    /// Press Send (Return on the Mac). On a simulator the software keyboard comes and goes
    /// while a test types, moving the button: wait for it to settle, and press again if the
    /// first press landed on nothing.
    func send() {
        #if os(macOS)
        composer.typeKey(.return, modifierFlags: [])
        #else
        pause(1.2)
        let before = (composer.value as? String) ?? ""
        sendButton.tap()
        let cleared = NSPredicate { _, _ in !self.composer.exists || ((self.composer.value as? String) ?? "") != before || self.stopButton.exists }
        if XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: cleared, object: nil)], timeout: 4) != .completed, sendButton.exists, sendButton.isEnabled {
            sendButton.tap()
        }
        #endif
    }

    /// Bring the software keyboard up for a picture (see `send()`).
    func showKeyboard() {
        #if os(iOS)
        if !app.keyboards.firstMatch.exists { composer.tap() }
        _ = app.keyboards.firstMatch.waitForExistence(timeout: 3)
        #endif
    }

    private func clear(_ field: XCUIElement) {
        #if os(macOS)
        field.tap()
        field.typeKey("a", modifierFlags: .command)
        field.typeKey(.delete, modifierFlags: [])
        #else
        // The cursor at the END of what is there (a tap in the middle of large text leaves it mid-word).
        field.coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: 0.5)).tap()
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
}
