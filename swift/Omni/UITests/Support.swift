import XCTest

/// What Scripts/uitest.sh hands the runner (TEST_RUNNER_<NAME> → <NAME>).
enum Run {
    static let env = ProcessInfo.processInfo.environment
    static let server = env["OMNI_UITEST_SERVER"] ?? ""
    static let token = env["OMNI_UITEST_TOKEN"] ?? ""
    static let signOutToken = env["OMNI_UITEST_SIGNOUT_TOKEN"] ?? ""
    static let shots = env["OMNI_UITEST_SHOTS"] ?? ""
    static let theme = env["OMNI_UITEST_THEME"] ?? "light"
    /// mac: default | narrow · iphone: default | xxxl · ipad: portrait | landscape | split
    static let variant = env["OMNI_UITEST_VARIANT"] ?? "default"
    static let platform = env["OMNI_UITEST_PLATFORM"] ?? "mac"

    static var isMac: Bool { platform == "mac" }
    static var isPhone: Bool { platform == "iphone" }
    static var isPad: Bool { platform == "ipad" }
    /// The window shows tabs (iPhone, or an iPad at a Split View width) rather than a sidebar.
    static var usesTabs: Bool { isPhone || (isPad && variant == "split") }
    static var configured: Bool { server.hasPrefix("http://127.0.0.1:") && token.hasPrefix("pd_") }
}

/// The dev gateway, called directly to put the backend in a known state before a screen is
/// looked at. The same routes the app uses, with the same device token.
struct Backend {
    struct Failure: Error, CustomStringConvertible { let description: String }

    func call(_ method: String, _ path: String, _ body: [String: Any]? = nil, key: String? = nil) async throws -> (status: Int, json: [String: Any]) {
        guard let url = URL(string: Run.server + path) else { throw Failure(description: "bad path \(path)") }
        var request = URLRequest(url: url, timeoutInterval: 30)
        request.httpMethod = method
        request.setValue("Bearer \(Run.token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if method != "GET" {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body ?? [:])
        }
        if let key { request.setValue(key, forHTTPHeaderField: "Idempotency-Key") }
        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        return (status, (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:])
    }

    func threads() async throws -> [[String: Any]] {
        try await call("GET", "/api/omni/threads").json["threads"] as? [[String: Any]] ?? []
    }

    func pendingApprovals() async throws -> [[String: Any]] {
        try await call("GET", "/api/omni/approvals?status=pending").json["approvals"] as? [[String: Any]] ?? []
    }

    /// An empty app: every draft cancelled, every running turn stopped, every thread archived
    /// (nothing is deleted). `keepGone` leaves the newest "no longer available" sample.
    func reset(keepGone: Bool = false) async throws {
        for approval in try await pendingApprovals() {
            guard let id = approval["id"] as? String, let digest = approval["digest"] as? String else { continue }
            _ = try await call("POST", "/api/omni/approvals/\(id)/decision", ["decision": "cancel", "digest": digest], key: "uitest-reset-\(UUID().uuidString)")
        }
        var keptGone = !keepGone
        for thread in try await threads() {
            guard let id = thread["id"] as? String else { continue }
            if thread["gone"] as? Bool == true, !keptGone {
                keptGone = true
                continue
            }
            if thread["running"] as? Bool == true, let turn = try await call("GET", "/api/omni/threads/\(id)").json["activeTurnId"] as? String {
                _ = try await call("POST", "/api/omni/turns/\(turn)/cancel")
            }
            _ = try await call("PATCH", "/api/omni/threads/\(id)", ["archived": true])
        }
    }

    /// Start a thread; returns its id.
    @discardableResult
    func thread(_ title: String, _ prompt: String) async throws -> String {
        let answer = try await call("POST", "/api/omni/threads", ["prompt": prompt, "title": title, "source": "text"])
        guard answer.status == 201, let id = (answer.json["thread"] as? [String: Any])?["id"] as? String else {
            throw Failure(description: "create thread answered \(answer.status)")
        }
        return id
    }

    func state(of id: String) async throws -> (state: String, running: Bool, unread: Int) {
        let thread = try await call("GET", "/api/omni/threads").json["threads"] as? [[String: Any]] ?? []
        let row = thread.first { $0["id"] as? String == id } ?? [:]
        return (row["state"] as? String ?? "", row["running"] as? Bool ?? false, row["unread"] as? Int ?? 0)
    }

    /// Wait until the thread's turn has ended.
    func settle(_ id: String, seconds: Double = 20) async throws {
        let end = Date().addingTimeInterval(seconds)
        while Date() < end {
            if try await !state(of: id).running { return }
            try await Task.sleep(for: .milliseconds(300))
        }
    }

    func stopTurn(in id: String) async throws {
        if let turn = try await call("GET", "/api/omni/threads/\(id)").json["activeTurnId"] as? String {
            _ = try await call("POST", "/api/omni/turns/\(turn)/cancel")
        }
    }
}

/// The base of every Omni UI test: launching the app the way the runner may, waiting, and
/// taking the numbered screenshots that end up in qa/screenshots/omni/.
@MainActor
class OmniUITestCase: XCTestCase {
    let app = XCUIApplication()
    let backend = Backend()
    /// What `seed()` made, by a short name ("working", "approval-email", …) → thread id.
    nonisolated(unsafe) static var seeded: [String: String] = [:]
    /// One numbering for the whole run, so the gallery sorts in the order of the walk.
    nonisolated(unsafe) private static var shotNumber = 0

    override func setUpWithError() throws {
        continueAfterFailure = true
        try XCTSkipUnless(Run.configured, "Run these through Scripts/uitest.sh (it starts nothing by itself: the dev backend must be up).")
        #if os(iOS)
        if Run.isPad {
            XCUIDevice.shared.orientation = Run.variant == "landscape" ? .landscapeLeft : .portrait
        } else {
            XCUIDevice.shared.orientation = .portrait
        }
        #endif
    }

    override func tearDownWithError() throws {
        app.terminate()
    }

    /// Launch signed in to the dev gateway (or as asked).
    func launch(token: String? = Run.token, server: String = Run.server, firstRun: Bool = false, faults: String = "", arguments: [String] = []) {
        app.terminate()
        var env = ["OMNI_UITEST": "1", "OMNI_UITEST_SERVER": server, "OMNI_UITEST_APPEARANCE": Run.theme, "OMNI_UITEST_ANIMATIONS": "0"]
        if let token { env["OMNI_UITEST_TOKEN"] = token }
        if firstRun { env["OMNI_UITEST_FIRST_RUN"] = "1" }
        if !faults.isEmpty { env["OMNI_UITEST_FAULTS"] = faults }
        if Run.isPad, Run.variant == "split", ProcessInfo.processInfo.environment["OMNI_UITEST_SPLIT_SEAM"] == "1" { env["OMNI_UITEST_COMPACT_WIDTH"] = "375" }
        app.launchEnvironment = env
        // No window restoration between launches: every launch starts from the same place.
        app.launchArguments = ["-ApplePersistenceIgnoreState", "YES"] + arguments
        app.launch()
        #if os(iOS)
        if Run.isPad { Run.variant == "split" ? narrowWindow() : fullWindow() }
        #endif
        #if os(macOS)
        app.activate()
        if !arguments.contains("-keepWindowSize") { resizeWindow() }
        #endif
    }

    #if os(macOS)
    /// The Mac window at its default size, or as narrow as it goes.
    func resizeWindow() {
        let window = app.windows["Omni"].firstMatch
        guard window.waitForExistence(timeout: 15) else { return }
        let size = Run.variant == "narrow" ? "{760, 500}" : "{1040, 700}"
        let script = "tell application \"System Events\" to tell (first process whose bundle identifier is \"com.benjaminlife.omni.uitest\") to set size of window 1 to \(size)"
        _ = script // System Events needs its own permission; the corner drag below needs none.
        let frame = window.frame
        let target = Run.variant == "narrow" ? CGSize(width: 760, height: 500) : CGSize(width: 1040, height: 700)
        guard abs(frame.width - target.width) > 4 || abs(frame.height - target.height) > 4 else { return }
        let corner = window.coordinate(withNormalizedOffset: CGVector(dx: 1, dy: 1)).withOffset(CGVector(dx: -2, dy: -2))
        let to = corner.withOffset(CGVector(dx: target.width - frame.width, dy: target.height - frame.height))
        corner.press(forDuration: 0.2, thenDragTo: to)
    }
    #endif

    #if os(iOS)
    /// Make the iPad window narrow, the way a person does: drag its bottom-right corner in
    /// until the window is about a phone's width (iPadOS windows resize from that corner).
    func narrowWindow() {
        let window = app.windows.firstMatch
        guard window.waitForExistence(timeout: 15) else { return }
        var tries = 0
        while window.frame.width > 520, tries < 3 {
            let frame = window.frame
            let board = XCUIApplication(bundleIdentifier: "com.apple.springboard")
            let origin = board.coordinate(withNormalizedOffset: .zero)
            let corner = origin.withOffset(CGVector(dx: frame.maxX - 6, dy: frame.maxY - 6))
            let target = origin.withOffset(CGVector(dx: frame.minX + 400, dy: frame.maxY - 6))
            corner.press(forDuration: 0.6, thenDragTo: target, withVelocity: .slow, thenHoldForDuration: 0.4)
            pause(1)
            tries += 1
        }
        XCTAssertLessThan(window.frame.width, 520, "the iPad window could not be made narrow")
    }

    /// Put the iPad window back to the whole screen (a narrow-width run leaves it narrow).
    func fullWindow() {
        let window = app.windows.firstMatch
        guard window.waitForExistence(timeout: 15) else { return }
        let board = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        var tries = 0
        while window.frame.width < board.frame.width - 40, tries < 3 {
            let frame = window.frame
            let origin = board.coordinate(withNormalizedOffset: .zero)
            let corner = origin.withOffset(CGVector(dx: frame.maxX - 6, dy: frame.maxY - 6))
            let far = origin.withOffset(CGVector(dx: board.frame.maxX - 2, dy: board.frame.maxY - 2))
            corner.press(forDuration: 0.6, thenDragTo: far, withVelocity: .slow, thenHoldForDuration: 0.4)
            pause(1)
            tries += 1
            // Grown from its left edge, it may still sit away from the left: drag the other corner too.
            let now = window.frame
            if now.minX > 20 {
                let left = origin.withOffset(CGVector(dx: now.minX + 6, dy: now.maxY - 6))
                left.press(forDuration: 0.6, thenDragTo: origin.withOffset(CGVector(dx: 2, dy: board.frame.maxY - 2)), withVelocity: .slow, thenHoldForDuration: 0.4)
                pause(1)
            }
        }
    }
    #endif

    // MARK: Waiting

    @discardableResult
    func wait(_ element: XCUIElement, _ seconds: TimeInterval = 15, _ what: String = "", file: StaticString = #filePath, line: UInt = #line) -> Bool {
        let found = element.waitForExistence(timeout: seconds)
        XCTAssertTrue(found, "not on screen: \(what.isEmpty ? element.description : what)", file: file, line: line)
        return found
    }

    /// Any element whose label or value contains the text.
    func text(_ fragment: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS[c] %@ OR value CONTAINS[c] %@", fragment, fragment)).firstMatch
    }

    func button(_ label: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label ==[c] %@ OR identifier == %@", label, label)).firstMatch
    }

    /// Tap a button by its label or identifier, scrolling to it first.
    func press(_ label: String, file: StaticString = #filePath, line: UInt = #line) {
        let target = label.contains(".") ? element(label) : button(label)
        guard wait(target, 15, "the \(label) button", file: file, line: line) else { return }
        bring(target)
        target.tap()
    }

    /// The text is on screen — scrolling the main list or page down to find it if need be
    /// (at the largest text sizes most screens are longer than the phone).
    @discardableResult
    func see(_ fragment: String, _ seconds: TimeInterval = 15, file: StaticString = #filePath, line: UInt = #line) -> Bool {
        let target = text(fragment)
        if target.waitForExistence(timeout: Run.variant == "xxxl" ? min(seconds, 4) : seconds) { return true }
        #if os(iOS)
        for _ in 0..<12 {
            scrollPage(down: true)
            if target.waitForExistence(timeout: 0.6) { return true }
        }
        for _ in 0..<24 {
            scrollPage(down: false)
            if target.waitForExistence(timeout: 0.6) { return true }
        }
        #endif
        return wait(target, Run.variant == "xxxl" ? seconds : 1, "“\(fragment)”", file: file, line: line)
    }

    #if os(iOS)
    /// Where, across the screen, the content being read is: the middle (a phone, a narrow
    /// iPad window), or the middle of the content column beside an iPad's sidebar.
    static var contentX: CGFloat {
        if Run.isPad, Run.variant == "split" { return ProcessInfo.processInfo.environment["OMNI_UITEST_SPLIT_SEAM"] == "1" ? 0.18 : 0.5 }
        return Run.isPad ? 0.65 : 0.5
    }

    /// Drag the frontmost scrolling area by a third of the screen.
    func scrollPage(down: Bool) {
        let from = app.coordinate(withNormalizedOffset: CGVector(dx: Self.contentX, dy: down ? 0.62 : 0.38))
        let to = app.coordinate(withNormalizedOffset: CGVector(dx: Self.contentX, dy: down ? 0.30 : 0.70))
        from.press(forDuration: 0.05, thenDragTo: to, withVelocity: .slow, thenHoldForDuration: 0.1)
    }

    /// Scroll until the element can be tapped.
    func bring(_ target: XCUIElement) {
        // Whole, and clear of the bar above and the message box (or tab bar) below: a button
        // half under the box counts as hittable, but its middle is not.
        func ready() -> Bool {
            guard target.exists, target.isHittable else { return false }
            let frame = target.frame
            let box = app.textViews["composer"].firstMatch
            let floor = box.exists && box.frame.minY > frame.minY ? box.frame.minY : app.frame.maxY - 100
            return frame.minY >= 110 && frame.maxY <= floor - 4
        }
        var tries = 0
        while !ready(), tries < 14 {
            scrollPage(down: true)
            tries += 1
        }
        tries = 0
        while !ready(), tries < 28 {
            scrollPage(down: false)
            tries += 1
        }
    }
    #else
    func bring(_ target: XCUIElement) {}
    #endif

    func gone(_ element: XCUIElement, _ seconds: TimeInterval = 10) -> Bool {
        let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: element)
        return XCTWaiter().wait(for: [expectation], timeout: seconds) == .completed
    }

    func pause(_ seconds: Double) {
        Thread.sleep(forTimeInterval: seconds)
    }

    /// Run an async backend step from a synchronous test.
    func server<T: Sendable>(_ work: @escaping @Sendable (Backend) async throws -> T, file: StaticString = #filePath, line: UInt = #line) -> T? {
        let expectation = expectation(description: "backend")
        let box = Box<T>()
        let backend = backend
        Task {
            do { box.value = try await work(backend) } catch { box.error = "\(error)" }
            expectation.fulfill()
        }
        wait(for: [expectation], timeout: 90)
        if let error = box.error { XCTFail("backend: \(error)", file: file, line: line) }
        return box.value
    }

    // MARK: Screenshots

    /// Take the numbered screenshot `NN-name.png`: attached to the test and written to the
    /// gallery folder. On the Mac only the app's own windows are captured, never the desktop.
    func shot(_ name: String, window: XCUIElement? = nil) {
        Self.shotNumber += 1
        let number = String(format: "%02d", Self.shotNumber)
        pause(0.6) // let an animation finish
        let image: XCUIScreenshot
        #if os(macOS)
        let target = window ?? app.windows.firstMatch
        guard target.exists else {
            XCTFail("no window to capture for \(name)")
            return
        }
        image = target.screenshot()
        #else
        image = XCUIScreen.main.screenshot()
        #endif
        let png = Self.upright(image)
        let attachment = XCTAttachment(screenshot: image)
        attachment.name = "\(number)-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
        guard !Run.shots.isEmpty else { return }
        let url = URL(fileURLWithPath: Run.shots).appendingPathComponent("\(number)-\(name).png")
        do {
            try FileManager.default.createDirectory(atPath: Run.shots, withIntermediateDirectories: true)
            try png.write(to: url)
        } catch {
            XCTFail("could not write \(url.lastPathComponent): \(error.localizedDescription)")
        }
    }

    /// The picture as a person holding the device sees it: a landscape iPad's screenshot
    /// arrives lying on its side.
    private static func upright(_ shot: XCUIScreenshot) -> Data {
        #if os(iOS)
        guard Run.isPad, Run.variant == "landscape", let cg = shot.image.cgImage, cg.height > cg.width else { return shot.pngRepresentation }
        // The pixels are stored as the device is built (portrait); draw them turned.
        let turned = UIImage(cgImage: cg, scale: 1, orientation: .left)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        return UIGraphicsImageRenderer(size: CGSize(width: cg.height, height: cg.width), format: format).pngData { _ in
            turned.draw(in: CGRect(x: 0, y: 0, width: cg.height, height: cg.width))
        }
        #else
        return shot.pngRepresentation
        #endif
    }

    // MARK: Getting around

    enum Place { case today, needsYou, threads, recurring }

    func element(_ identifier: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: identifier).firstMatch
    }

    /// The list that holds the threads: the sidebar, or the Threads tab's list.
    var threadList: XCUIElement {
        #if os(macOS)
        return app.outlines.firstMatch
        #else
        return app.collectionViews.firstMatch
        #endif
    }

    func go(_ place: Place, file: StaticString = #filePath, line: UInt = #line) {
        if Run.usesTabs {
            let name = [Place.today: "Today", .needsYou: "Needs you", .threads: "Threads", .recurring: "Threads"][place] ?? "Today"
            let tab = app.tabBars.buttons[name].firstMatch
            if Run.isPad { hideKeyboard() }
            guard wait(tab, 15, "the \(name) tab", file: file, line: line) else { return }
            tab.tap()
            // A tap that lands while a search field is still closing is swallowed: look, and press again.
            for _ in 0..<3 where !tab.isSelected {
                pause(1)
                tab.tap()
            }
            XCTAssertTrue(tab.isSelected, "the \(name) tab did not open", file: file, line: line)
            // A pushed screen is still up: the tab again goes back to its first screen.
            if place == .threads || place == .recurring, !app.navigationBars["Threads"].exists { tab.tap() }
            if place == .recurring {
                let row = element("nav.recurring")
                reveal(row)
                row.tap()
            }
        } else {
            showSidebar()
            let row = element([Place.today: "nav.today", .needsYou: "nav.needsYou", .threads: "nav.today", .recurring: "nav.recurring"][place] ?? "nav.today")
            reveal(row)
            guard wait(row, 15, "the sidebar row", file: file, line: line) else { return }
            row.tap()
        }
    }

    /// An iPad can have its sidebar put away; bring it back.
    func showSidebar() {
        #if os(iOS)
        if !element("nav.today").exists, !element("nav.recurring").exists {
            let toggle = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'sidebar'")).firstMatch
            if toggle.exists { toggle.tap() }
        }
        #endif
    }

    /// Scroll the thread list until the element can be tapped: a third of a screen at a
    /// time, so a row cannot be jumped over or left under the tab bar.
    func reveal(_ target: XCUIElement) {
        func ready() -> Bool { target.exists && target.isHittable }
        func drag(_ from: CGFloat, _ to: CGFloat) {
            let list = threadList
            guard list.exists else { return }
            let start = list.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: from))
            start.press(forDuration: 0.05, thenDragTo: list.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: to)), withVelocity: .slow, thenHoldForDuration: 0.1)
        }
        var tries = 0
        while !ready(), tries < 14 {
            drag(0.65, 0.35)
            tries += 1
        }
        tries = 0
        while !ready(), tries < 28 {
            drag(0.35, 0.65)
            tries += 1
        }
    }

    func openThread(_ id: String, file: StaticString = #filePath, line: UInt = #line) {
        if Run.usesTabs { go(.threads) } else { showSidebar() }
        let row = element("thread.\(id)")
        _ = row.waitForExistence(timeout: 5)
        reveal(row)
        guard wait(row, 10, "the thread's row", file: file, line: line) else { return }
        row.tap()
        // The row was under a bar, or the list was still moving: once more.
        if Run.usesTabs, !app.navigationBars.buttons.element(boundBy: 0).waitForExistence(timeout: 3) || app.navigationBars["Threads"].exists {
            reveal(row)
            if row.exists, row.isHittable { row.tap() }
        }
    }

    func startNewThread() {
        if Run.usesTabs { go(.threads) } else { showSidebar() }
        let new = element("thread.new")
        wait(new, 10, "the New Thread button")
        new.tap()
    }

    /// Put the software keyboard away with its own key (an iPad's keyboard has one, bottom
    /// right; in a narrow iPad window the keyboard lies over the window's tab bar until then).
    func hideKeyboard() {
        #if os(iOS)
        let keyboard = app.keyboards.firstMatch
        guard keyboard.exists else { return }
        let key = keyboard.buttons.matching(NSPredicate(format: "label IN {'Hide keyboard', 'Dismiss', 'Dismiss keyboard'}")).firstMatch
        if key.exists {
            key.tap()
        } else if Run.isPad {
            keyboard.coordinate(withNormalizedOffset: CGVector(dx: 1, dy: 1)).withOffset(CGVector(dx: -28, dy: -28)).tap()
        }
        _ = gone(keyboard, 3)
        #endif
    }

    // MARK: Typing

    func type(_ string: String, into element: XCUIElement) {
        element.tap()
        element.typeText(string)
    }

    var composer: XCUIElement { app.textViews["composer"].firstMatch }
    var sendButton: XCUIElement { app.buttons["composer.send"].firstMatch }
    var stopButton: XCUIElement { app.buttons["composer.stop"].firstMatch }
}

final class Box<T>: @unchecked Sendable {
    var value: T?
    var error: String?
}
