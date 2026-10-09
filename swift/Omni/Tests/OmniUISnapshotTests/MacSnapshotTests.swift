#if os(macOS)
import AppKit
import OmniClient
@testable import OmniCore
@testable import OmniUI
import PrismAuth
import SwiftUI
import XCTest

/// Every Mac screen, drawn off-screen from sample data and written as a PNG.
///
/// Nothing here comes to the front, takes the keyboard or shows on the display: the window
/// that hosts the views is never put on screen, and its content is drawn straight into a
/// bitmap. That is what makes it safe to run while the Mac is in use — and it is also the
/// limit: it shows layout, text, colour and state, not clicks, keys or focus. Those are
/// covered by `UITests/` (XCUITest), which on the Mac needs the owner to allow UI
/// automation once. See TESTING.md.
///
/// Output: `qa/screenshots/omni/mac/<size>/<theme>/NN-name.png` (or `OMNI_SNAPSHOT_DIR`).
@MainActor
final class MacSnapshotTests: XCTestCase {
    struct Variant {
        let folder: String
        let size: CGSize
        let dark: Bool
    }

    static let variants = [
        Variant(folder: "mac-default/light", size: CGSize(width: 1040, height: 700), dark: false),
        Variant(folder: "mac-default/dark", size: CGSize(width: 1040, height: 700), dark: true),
        Variant(folder: "mac-narrow/light", size: CGSize(width: 760, height: 500), dark: false),
    ]

    func testEveryScreen() async throws {
        // No Dock icon, no menu bar, never frontmost.
        NSApplication.shared.setActivationPolicy(.prohibited)
        for variant in Self.variants {
            var walk = Walk(variant: variant, root: Self.outputRoot)
            try await walk.run()
            XCTAssertGreaterThan(walk.count, 25, "fewer screens than expected were drawn for \(variant.folder)")
        }
    }

    static var outputRoot: URL {
        if let custom = ProcessInfo.processInfo.environment["OMNI_SNAPSHOT_DIR"], !custom.isEmpty { return URL(fileURLWithPath: custom) }
        // swift/Omni/Tests/OmniUISnapshotTests/ThisFile.swift → the repository root.
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { url.deleteLastPathComponent() }
        return url.appendingPathComponent("qa/screenshots/omni/mac")
    }
}

/// The signed-in window's two columns, laid side by side. The real window is a
/// `NavigationSplitView`; its sidebar is drawn by the system with a material that cannot be
/// drawn into a bitmap, so the pictures use a plain column for it. Everything inside the
/// columns is the app's own views.
struct SampleWindow: View {
    @Bindable var session: SessionModel

    var body: some View {
        HStack(spacing: 0) {
            SidebarList(session: session)
                .listStyle(.sidebar)
                .frame(width: 250)
            Divider()
            NavigationStack {
                DestinationView(session: session, destination: session.destination)
            }
        }
        .environment(\.navigator, Navigator { session.destination = $0 })
        .task { await session.threads.refresh() }
        .task { await session.approvals.refresh() }
    }
}

@MainActor
struct Walk {
    let variant: MacSnapshotTests.Variant
    let root: URL
    var count = 0

    // MARK: Drawing

    /// Host a view in a window that is never shown, let it load, and draw it into a PNG.
    mutating func draw<V: View>(_ name: String, size: CGSize? = nil, settle: Duration = .milliseconds(700), _ view: V, then act: (@MainActor () async -> Void)? = nil) async throws {
        let size = size ?? variant.size
        let window = NSWindow(contentRect: CGRect(origin: CGPoint(x: -20000, y: -20000), size: size), styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: variant.dark ? .darkAqua : .aqua)
        window.title = "Omni"
        let host = NSHostingController(rootView: view.frame(minWidth: size.width, maxWidth: size.width, minHeight: size.height, maxHeight: size.height))
        host.sceneBridgingOptions = [.toolbars, .title]
        window.contentViewController = host
        window.setContentSize(size)
        // In the window list so AppKit lays it out and SwiftUI runs its tasks — but fully
        // transparent, behind everything, deaf to the mouse and never key: nothing shows
        // and nothing is taken from whoever is using the Mac.
        window.alphaValue = 0
        window.ignoresMouseEvents = true
        window.orderBack(nil)
        try await Task.sleep(for: settle)
        if let act {
            await act()
            try await Task.sleep(for: settle)
        }
        let frame = window.contentView?.superview ?? window.contentView
        guard let target = frame else { return }
        target.layoutSubtreeIfNeeded()
        let bounds = target.bounds
        guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(bounds.width * 2), pixelsHigh: Int(bounds.height * 2), bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { return }
        bitmap.size = bounds.size
        target.cacheDisplay(in: bounds, to: bitmap)
        count += 1
        let folder = root.appendingPathComponent(variant.folder)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let file = folder.appendingPathComponent(String(format: "%02d-%@.png", count, name))
        try bitmap.representation(using: .png, properties: [:])?.write(to: file)
        window.contentViewController = nil
        window.close()
    }

    // MARK: The app, on sample data

    func model(server: String? = "https://prism.example.com", probe: ServerProbeResult = .ready, signedIn: Bool = true, service: SampleService = SampleService(), diagnostics: DiagnosticsLog? = nil) -> AppModel {
        AppModel(
            settings: SampleSettings(server),
            probe: SampleProbe(result: probe),
            deviceLabel: "Omni on a Mac",
            defaultServerURL: "http://127.0.0.1:8797",
            confirmation: NoSendConfirmation(),
            diagnostics: diagnostics,
            makeEnvironment: { _, _ in ServerEnvironment(service: service, auth: SampleAuth(hasToken: signedIn)) }
        )
    }

    static let kinds: [(kind: String, title: String, payload: [String: Any], executor: [String: Any])] = [
        ("email", "Email Kevin about the buoy spec", ["to": ["kevin@example.com"], "cc": ["dana@example.com"], "subject": "Buoy spec — two questions before Friday", "body": "Hi Kevin,\n\nTwo things before Friday's review:\n\n1. Is the mooring line rated for the winter swell, or do we need the heavier one?\n2. Can the housing take the larger battery without a new seal?\n\nIf it is easier to talk, I am free Thursday after two.\n\nThanks,\nBenjamin"], ["name": "proton-send", "available": true, "enabled": false]),
        ("email-reply", "Reply to Dana", ["noteId": "01JEXAMPLE0000000000000001", "expectTo": ["dana@example.com"], "body": "Hi Dana,\n\nFriday at ten works. I will bring the quotes.\n\nBenjamin"], ["name": "proton-send", "available": true, "enabled": false]),
        ("message", "Message the hardware room", ["roomId": "!hardware:example.org", "body": "The review moved to Friday at 11. Bring the two quotes."], ["name": "matrix", "available": true, "enabled": false]),
        ("calendar-invite", "Invite for the spec review", ["title": "Buoy spec review", "start": "2026-10-16T11:00:00-06:00", "end": "2026-10-16T12:00:00-06:00", "attendees": ["kevin@example.com", "dana@example.com"], "location": "Studio B", "description": "Go through the two mooring quotes and decide."], ["name": "calendar", "available": true, "enabled": false]),
        ("tweet", "Post about the retreat", ["text": "Three days by the water, working out how a buoy should talk to a notebook. Notes soon."], ["name": "none", "available": false, "enabled": false]),
        ("wallet-proposal", "Pay the venue deposit", ["to": "0x52908400098527886E0F7030069857D2E4169EE7", "amount": "250", "token": "USDC", "chain": "base", "purpose": "Deposit for the retreat venue, as agreed on the call."], ["name": "none", "available": false, "enabled": false]),
    ]

    func sample() -> SampleService {
        let service = SampleService()
        for (index, entry) in Self.kinds.enumerated() {
            let id = "apr\(index)"
            service.addThread("n\(index)", entry.title, state: "needs-you", preview: "I drafted it and put it in front of you.", messages: [("user", entry.title + "."), ("assistant", "I drafted it and put it in front of you to review. Nothing has been sent.")], tools: ["omni_propose"], approvals: [SampleService.draft(id, thread: "n\(index)", kind: entry.kind, payload: entry.payload, executor: entry.executor)])
        }
        let turn = "turn-working"
        service.addThread("working", "Research mooring suppliers", state: "working", preview: "Looking at three suppliers near the harbour…", messages: [("user", "Research mooring suppliers near the harbour and compare their lead times.")], live: [
            SampleService.event(1, turn: turn, ["t": "init", "runId": "run1"]),
            SampleService.event(2, turn: turn, ["t": "tool_use", "id": "tool1", "name": "prism_search", "input": ["query": "mooring"]]),
            SampleService.event(3, turn: turn, ["t": "tool_result", "toolUseId": "tool1", "ok": true, "summary": "3 notes"]),
            SampleService.event(4, turn: turn, ["t": "tool_use", "id": "tool2", "name": "web_search", "input": ["query": "mooring suppliers"]]),
            SampleService.event(nil, turn: turn, ["t": "text_delta", "blockId": "b1", "text": "I found three suppliers within an hour of the harbour. **Harbour Rope & Chain** quotes two weeks; the other two are still"]),
        ])
        service.addThread("waiting", "Compare the two quotes", state: "waiting", preview: "Stopped.", waitingOn: "Kevin's answer", messages: [("user", "Compare the two mooring quotes."), ("assistant", "I have the first quote. The second has not arrived yet — I will pick this up when Kevin replies.")])
        service.addThread("scheduled", "Check the forecast on Friday", state: "scheduled", preview: "I will check on Friday morning.", messages: [("user", "Check the marine forecast on Friday morning and tell me if the crossing is on."), ("assistant", "I will check on Friday morning and tell you.")])
        service.addThread("unread", "Find the grant deadline", state: "done", preview: "One more thing: the portal closes at 5 pm Eastern.", unread: 1, messages: [("user", "Find the grant deadline."), ("assistant", "The deadline is **November 3**."), ("assistant", "One more thing: the portal closes at 5 pm Eastern, not midnight.")], tools: ["prism_search"])
        service.addThread("done", "Update the task for Dana", state: "done", preview: "Done — the task is due Friday.", messages: [("user", "Mark the call with Dana as due Friday."), ("assistant", "Done — the task is due Friday.")], tools: ["prism_update_note"], cards: [["kind": "record", "noteId": "note1", "op": "updated", "type": "task", "title": "Call Dana about the buoy spec", "path": "tasks/call-dana", "summary": "properties status, due", "updatedAt": "2026-10-09T15:00:06.000Z", "links": ["prism": "https://prism.example.com/page/note1"], "private": false]])
        service.addThread("gone", "Plan the retreat agenda", state: "done", gone: true)
        service.addJob("0a1b2c3d4e5f", "Morning brief", schedule: "0 7 * * *", enabled: true, lastStatus: "ok")
        service.addJob("f5e4d3c2b1a0", "Inbox sweep", schedule: "*/30 * * * *", enabled: false, lastStatus: "error", lastError: "The mail bridge did not answer.")
        service.addJob("a0b1c2d3e4f5", "Weekly review", schedule: "0 16 * * 5", enabled: true, lastStatus: "ok")
        return service
    }

    /// The signed-in window on `destination`.
    mutating func screen(_ name: String, service: SampleService, _ destination: Destination?, search: String = "", settle: Duration = .milliseconds(900), then act: (@MainActor (AppModel) async -> Void)? = nil) async throws {
        let app = model(service: service, diagnostics: DiagnosticsLog())
        await app.start()
        app.session?.threads.searchText = search
        app.session?.destination = destination
        var after: (@MainActor () async -> Void)?
        if let act { after = { await act(app) } }
        guard let session = app.session else { return XCTFail("the sample did not sign in") }
        try await draw(name, settle: settle, SampleWindow(session: session), then: after)
        app.session?.stop()
    }

    mutating func run() async throws {
        // Before the app.
        let first = model(server: nil, signedIn: false)
        await first.start()
        try await draw("first-run-server", RootView(app: first))
        first.serverText = "not an address"
        await first.submitServer()
        try await draw("first-run-bad-address", RootView(app: first))
        first.serverText = "https://prism.example.com"
        await first.submitServer()
        try await draw("sign-in", RootView(app: first))
        first.signIn()
        try await draw("signing-in-waiting", RootView(app: first))
        first.cancelSignIn()

        let unreachable = model(probe: .unreachable("timed out"), signedIn: false)
        await unreachable.start()
        try await draw("cant-connect", RootView(app: unreachable))
        let off = model(probe: .omniOff, signedIn: false)
        await off.start()
        try await draw("server-without-omni", RootView(app: off))

        // Nothing yet.
        let empty = SampleService()
        empty.addJob("0a1b2c3d4e5f", "Morning brief", schedule: "0 7 * * *", enabled: true, lastStatus: "ok")
        try await screen("today-empty", service: empty, .today)
        try await screen("needs-you-empty", service: empty, .needsYou)

        // The reads that do not get through.
        let failing = sample()
        failing.failReads = true
        try await screen("today-failed", service: failing, .today)
        try await screen("recurring-failed", service: failing, .recurring)
        let agentDown = sample()
        agentDown.agentUnavailable = true
        try await screen("agent-unreachable", service: agentDown, .today)

        // The list in every state, search, Today.
        let service = sample()
        try await screen("today-loaded", service: service, .today)
        let partial = sample()
        partial.todayPartial = true
        try await screen("today-partial", service: partial, .today)
        try await screen("threads-search", service: service, .today, search: "mooring")
        try await screen("threads-search-no-match", service: service, .today, search: "zzzz")

        // Threads.
        try await screen("new-thread", service: service, .newThread)
        try await screen("thread-streaming", service: service, .thread("working"))
        try await screen("thread-record-card", service: service, .thread("done"))
        try await screen("thread-followup", service: service, .thread("unread"))
        try await screen("thread-waiting", service: service, .thread("waiting"))
        try await screen("thread-gone", service: service, .thread("gone"))

        // Approvals: the queue, and each kind in its thread.
        try await screen("needs-you-list", service: service, .needsYou)
        for (index, entry) in Self.kinds.enumerated() {
            try await screen("approval-\(entry.kind)", service: service, .thread("n\(index)"))
        }
        let sending = sample()
        try await screen("approval-send-switched-off", service: sending, .thread("n0")) { app in
            await app.session?.approvals.send("apr0")
        }
        let cancelling = sample()
        try await screen("approval-cancelled", service: cancelling, .thread("n0")) { app in
            await app.session?.approvals.cancel("apr0")
        }
        let tampered = sample()
        tampered.tamperDrafts = true
        try await screen("approval-digest-mismatch", service: tampered, .thread("n0"))

        // The two sheets, as the window shows them.
        let approval: Approval = SampleService.decode(SampleService.draft("apr0", thread: "n0", kind: "email", payload: Self.kinds[0].payload))
        if let draft = ApprovalDraft(approval) {
            try await draw("approval-edit-sheet", size: CGSize(width: 480, height: 460), ApprovalEditSheet(draft: draft, kindLabel: "Email") { _ in true })
        }
        try await draw("approval-revise-sheet", size: CGSize(width: 420, height: 280), ReviseSheet(feedback: .constant("Make it shorter and mention Friday.")) {})

        // Recurring, Settings.
        try await screen("recurring", service: service, .recurring)
        let settings = model(service: service, diagnostics: DiagnosticsLog())
        await settings.start()
        settings.diagnostics?.note("sign-in: finished, the device is signed in")
        settings.diagnostics?.note("server check: no answer (timed out)", isFailure: true)
        try await draw("settings", size: CGSize(width: 620, height: 560), SettingsView(app: settings))
        let signedOut = model(signedIn: false)
        await signedOut.start()
        try await draw("signed-out", RootView(app: signedOut))
    }
}
#endif
