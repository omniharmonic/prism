// OmniSmoke — walks the calls the Omni app makes, through PrismKit and OmniCore, against
// the LAPTOP DEV gateway + stub Hermes (docs/omni-module.md "Developing against a stub
// Hermes"). Run it with Scripts/smoke.sh while `apps/server/scripts/omni-dev.sh` is up.
//
// It signs in the way the app does (PrismKit `DeviceSignIn`, client `omni-native`): the
// browser leg is played by this process with a dev-owner session cookie that smoke.sh
// mints in the dev database, as `omni-walkthrough.ts` does. Prints one PASS/FAIL line per
// step and a list of every difference between PrismKit's models and what the gateway
// actually returned. It never prints a token, a cookie or a response body's values.
// It refuses any server that is not http://127.0.0.1:<port>.
import Foundation
import OmniClient
import OmniCore
import PrismAuth
import PrismTransport

// MARK: Reporting

struct StepFailed: Error { let what: String }

func check(_ condition: Bool, _ what: String) throws {
    if !condition { throw StepFailed(what: what) }
}

@MainActor
final class Report {
    var failed = 0
    var count = 0
    var mismatches: [String] = []

    @discardableResult
    func step(_ name: String, _ body: () async throws -> String?) async -> Bool {
        count += 1
        let label = String(format: "%02d %@", count, name)
        do {
            let note = try await body()
            print("PASS  \(label)\(note.map { " — \($0)" } ?? "")")
            return true
        } catch let e as StepFailed {
            failed += 1
            print("FAIL  \(label) — \(e.what)")
        } catch {
            failed += 1
            // The error's case only: PrismKit's errors never carry a token or a URL.
            print("FAIL  \(label) — \(String(describing: error).prefix(200))")
        }
        return false
    }

    func mismatch(_ text: String) {
        if !mismatches.contains(text) { mismatches.append(text) }
    }
}

// MARK: The browser leg, played headlessly for the dev owner

/// What a person does in the browser: open the authorize URL while signed in to Prism,
/// press Approve, and let the browser follow the redirect. Returns the redirect target.
struct DevOwnerBrowser: Sendable {
    let origin: ServerOrigin
    let sessionCookie: String
    let session = PrismURLSession.make()

    func approve(_ authorizeURL: URL) async throws -> String {
        try await approveKeepingCookies(authorizeURL).location
    }

    /// What the OTHER tab does afterwards (the sign-in page that was left open, a reload,
    /// Back): open /auth/device/continue again with the browser's cookies.
    func continueAgain(cookies: String) async throws -> (status: Int, html: String) {
        var get = URLRequest(url: try origin.url(path: "/auth/device/continue"))
        get.setValue("prism_session=\(sessionCookie); \(cookies)", forHTTPHeaderField: "Cookie")
        let (page, r) = try await session.data(for: get)
        return ((r as? HTTPURLResponse)?.statusCode ?? 0, String(decoding: page, as: UTF8.self))
    }

    /// `approve`, also returning the cookies the browser holds afterwards (never printed).
    func approveKeepingCookies(_ authorizeURL: URL) async throws -> (location: String, cookies: String) {
        try check(origin.contains(authorizeURL), "the authorize URL is not on the dev gateway")
        var get = URLRequest(url: authorizeURL)
        get.setValue("prism_session=\(sessionCookie)", forHTTPHeaderField: "Cookie")
        let (page, r1) = try await session.data(for: get)
        let s1 = (r1 as? HTTPURLResponse)?.statusCode ?? 0
        try check(s1 == 200, "authorize answered \(s1)")
        let html = String(decoding: page, as: UTF8.self)
        let setCookie = (r1 as? HTTPURLResponse)?.value(forHTTPHeaderField: "Set-Cookie") ?? ""
        guard let req = Self.capture(html, #"name="req" value="([^"]+)""#), let csrf = Self.capture(html, #"name="csrf" value="([^"]+)""#), let reqCookie = Self.capture(setCookie, #"prism_device_req=([^;]+)"#) else {
            throw StepFailed(what: "the consent page carried no form")
        }
        var post = URLRequest(url: try origin.url(path: "/auth/device/approve"))
        post.httpMethod = "POST"
        post.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        post.setValue("prism_session=\(sessionCookie); prism_device_req=\(reqCookie)", forHTTPHeaderField: "Cookie")
        post.httpBody = Data(FormEncoding.encode([("req", req), ("csrf", csrf), ("decision", "approve")]).utf8)
        let (_, r2) = try await session.data(for: post)
        let http = r2 as? HTTPURLResponse
        try check(http?.statusCode == 302, "approve answered \(http?.statusCode ?? 0)")
        guard let location = http?.value(forHTTPHeaderField: "Location") else { throw StepFailed(what: "approve gave no redirect") }
        let after = http?.value(forHTTPHeaderField: "Set-Cookie") ?? ""
        let done = Self.capture(after, #"prism_device_done=([a-z]+)"#).map { "prism_device_done=\($0)" } ?? ""
        return (location, done)
    }

    static func capture(_ text: String, _ pattern: String) -> String? {
        guard let regex = try? NSRegularExpression(pattern: pattern), let m = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)), let r = Range(m.range(at: 1), in: text) else { return nil }
        return String(text[r])
    }
}

/// The iPhone's leg (`omni://auth/callback`): the redirect comes straight back to the app.
struct CustomSchemeFlow: RedirectFlow {
    let browser: DevOwnerBrowser

    func start() async throws -> any RedirectFlowSession { Session(browser: browser) }

    struct Session: RedirectFlowSession {
        let browser: DevOwnerBrowser
        var redirectURI: String { DeviceAuthConfiguration.omniNative.redirectURI }

        func waitForCode(authorizeURL: URL, expectedState: String) async throws -> String {
            let location = try await browser.approve(authorizeURL)
            return try PKCE.codeFromRedirect(location, redirectURI: redirectURI, expectedState: expectedState)
        }
    }
}

// MARK: Shape comparison (keys only, never values)

/// The JSON keys each PrismKit model reads. A key the gateway sends that is not here, or a
/// key here the gateway never sends, is reported.
enum Shape {
    static let thread: Set<String> = ["id", "title", "state", "objective", "taskNoteId", "lastActivityAt", "unread", "pinned", "archived", "nextCheckAt", "waitingOn", "model", "preview", "messageCount", "running", "lastSeq", "source", "gone"]
    static let threadList: Set<String> = ["threads", "next", "hermes"]
    static let detail: Set<String> = ["thread", "messages", "cards", "approvals", "activeTurnId"]
    static let message: Set<String> = ["id", "role", "text", "toolName", "at"]
    static let approval: Set<String> = ["id", "threadId", "kind", "payload", "digest", "summary", "status", "createdAt", "expiresAt", "decidedAt", "result", "supersededBy", "revises", "executor"]
    static let executor: Set<String> = ["name", "available", "enabled"]
    static let job: Set<String> = ["id", "name", "schedule", "enabled", "paused", "next_run_at", "last_run_at", "last_status", "last_error", "deliver", "skill", "skills", "repeat", "state"]
    static let today: Set<String> = ["date", "agenda", "tasks", "taskIdentity", "needsYou", "inFlight", "openLoops", "brief", "errors"]
    static let needsYou: Set<String> = ["approvals", "nudges"]
    static let inFlight: Set<String> = ["id", "title", "state", "lastActivityAt"]
    static let agenda: Set<String> = ["noteId", "title", "start", "end", "location", "meetLink", "link"]
    static let task: Set<String> = ["noteId", "title", "status", "due", "priority", "threadId", "link"]
    static let version: Set<String> = ["api", "minClient"]
    static let card: Set<String> = ["kind", "noteId", "op", "type", "title", "path", "tags", "icon", "summary", "changedKeys", "bodyDelta", "writer", "updatedAt", "threadId", "links", "private"]
    /// Keys the docs mark optional (`?`): their absence is not a mismatch.
    static let optional: Set<String> = ["paused", "next_run_at", "last_run_at", "last_status", "last_error", "deliver", "skill", "skills", "repeat", "state", "toolName", "text", "bodyDelta"]
}

@MainActor
func compare(_ name: String, _ value: JSONValue?, _ expected: Set<String>, _ report: Report) {
    guard let object = value?.objectValue else {
        if value != nil, value?.isNull == false { report.mismatch("\(name): expected an object, got another JSON type") }
        return
    }
    let got = Set(object.keys)
    for key in got.subtracting(expected).sorted() { report.mismatch("\(name): the gateway sends `\(key)`, which PrismKit does not read") }
    for key in expected.subtracting(got).subtracting(Shape.optional).sorted() { report.mismatch("\(name): PrismKit reads `\(key)`, which the gateway did not send") }
}

// MARK: Helpers

@MainActor
func raw(_ transport: PrismClient, _ path: String, query: [URLQueryItem] = []) async throws -> JSONValue {
    let response = try await transport.send(.get(path, query: query))
    return try PrismJSON.decoder().decode(JSONValue.self, from: response.body)
}

struct Collected {
    var transcript = TurnTranscript()
    var deltas = 0
    var events: [OmniStreamEvent] = []
    var names: [String] = []
}

/// Follow a thread's stream until the server closes it, folding it the way the app does.
func follow(_ omni: OmniClient, _ threadID: String, after: Int, onEvent: (@Sendable (Collected) async -> Void)? = nil) async throws -> Collected {
    var out = Collected(transcript: TurnTranscript(lastSeq: after))
    for try await update in omni.threadStream(threadID: threadID, after: after) {
        guard case .event(let envelope) = update else { continue }
        out.transcript.apply(envelope)
        out.events.append(envelope.event)
        switch envelope.event {
        case .textDelta: out.deltas += 1
        case .initialized: out.names.append("init")
        case .text: out.names.append("text")
        case .toolUse(_, let name, _): out.names.append("tool_use(\(name))")
        case .toolResult: out.names.append("tool_result")
        case .card: out.names.append("card")
        case .approval: out.names.append("approval")
        case .status(let state, let reason): out.names.append("status(\(state.rawValue)\(reason.map { ":\($0)" } ?? ""))")
        case .result(let ok, _, let code): out.names.append("result(\(ok ? "ok" : code ?? "failed"))")
        case .unknown(let type, _): out.names.append("UNKNOWN(\(type))")
        }
        await onEvent?(out)
    }
    return out
}

func waitUntil(_ timeout: Duration = .seconds(30), _ condition: @MainActor () -> Bool) async -> Bool {
    let deadline = ContinuousClock.now + timeout
    while ContinuousClock.now < deadline {
        if await condition() { return true }
        try? await Task.sleep(for: .milliseconds(100))
    }
    return await condition()
}

actor Flag {
    private(set) var value = false
    private(set) var notes: [String] = []
    func set() { value = true }
    func note(_ s: String) { notes.append(s) }
}

// MARK: The walk

@MainActor
func run() async -> Int32 {
    let report = Report()
    let env = ProcessInfo.processInfo.environment
    let base = env["OMNI_SMOKE_URL"] ?? "http://127.0.0.1:8797"
    guard let origin = try? ServerOrigin(base), origin.scheme == "http", origin.host == "127.0.0.1" else {
        print("smoke: OMNI_SMOKE_URL must be http://127.0.0.1:<port> — this harness is for the laptop dev gateway only")
        return 2
    }
    guard let cookie = env["OMNI_SMOKE_SESSION"], !cookie.isEmpty else {
        print("smoke: no dev-owner session. Run Scripts/smoke.sh (it mints one in the dev database and removes it afterwards).")
        return 2
    }
    print("Omni smoke run against \(origin.value) (dev gateway + stub Hermes), through PrismKit and OmniCore")

    let browser = DevOwnerBrowser(origin: origin, sessionCookie: cookie)
    let tokens = InMemoryTokenStore()
    let signedOut = Flag()

    // Mac: the loopback redirect, exactly as the app runs it — only the "browser" differs.
    let macFlow = LoopbackRedirectFlow(timeout: .seconds(30)) { url in
        guard let location = try? await browser.approve(url), let callback = URL(string: location), callback.host == "127.0.0.1" else { return false }
        _ = try? await PrismURLSession.make().data(from: callback)
        return true
    }
    let signIn = DeviceSignIn(origin: origin, configuration: .omniNative, tokenStore: tokens)

    let signed = await report.step("sign in (Mac): PrismKit DeviceSignIn, omni-native, loopback redirect") {
        let credential = try await signIn.signIn(using: macFlow, label: "Omni smoke (laptop, loopback)")
        try check(signIn.hasToken, "no token was stored")
        return "device token stored (not shown); device id \(credential.deviceID == nil ? "absent" : "present")"
    }
    guard signed else { return 1 }

    await report.step("sign in (iPhone leg): omni://auth/callback, then sign out = revoke + forget") {
        let phoneTokens = InMemoryTokenStore()
        let phone = DeviceSignIn(origin: origin, configuration: .omniNative, tokenStore: phoneTokens)
        try await phone.signIn(using: CustomSchemeFlow(browser: browser), label: "Omni smoke (laptop, custom scheme)")
        try check(await phone.liveness() == .alive, "the new token is not alive")
        let result = await phone.signOut()
        try check(result == .revoked, "sign-out was \(result), not revoked")
        try check(!phone.hasToken, "the token was not forgotten")
        return "signed in, alive, revoked, forgotten"
    }

    await report.step("sign in again, as it went on the first run: the callback arrives twice, a favicon is asked for, and the other tab resumes after Approve") {
        let seen = Flag()
        let again = InMemoryTokenStore()
        let flow = LoopbackRedirectFlow(timeout: .seconds(30)) { url in
            guard let done = try? await browser.approveKeepingCookies(url), let callback = URL(string: done.location), callback.host == "127.0.0.1", let port = callback.port else { return false }
            let web = PrismURLSession.make()
            func status(_ u: URL) async -> Int { ((try? await web.data(from: u))?.1 as? HTTPURLResponse)?.statusCode ?? 0 }
            // A browser asks for more than the callback, and may ask for the callback twice.
            await seen.note("favicon \(await status(URL(string: "http://127.0.0.1:\(port)/favicon.ico")!))")
            await seen.note("callback \(await status(callback))")
            await seen.note("callback-again \(await status(callback))")
            // The sign-in page left open in the first tab now continues by itself.
            if let other = try? await browser.continueAgain(cookies: done.cookies) {
                await seen.note("continue \(other.status) \(other.html.contains("signed in") ? "signed-in-page" : other.html.contains("Can") ? "error-page" : "other-page")")
            }
            return true
        }
        let device = DeviceSignIn(origin: origin, configuration: .omniNative, tokenStore: again)
        try await device.signIn(using: flow, label: "Omni smoke (laptop, repeated callback)")
        try check(device.hasToken, "no token was stored")
        try check(await device.liveness() == .alive, "the token is not alive")
        let notes = await seen.notes
        try check(notes == ["favicon 404", "callback 200", "callback-again 200", "continue 200 signed-in-page"], "the browser saw: \(notes)")
        let result = await device.signOut()
        try check(result == .revoked, "sign-out was \(result)")
        return "favicon 404 (ignored); callback 200; the same callback again 200 and nothing delivered twice; the other tab: 200 “You're signed in”; one live token"
    }

    // Every request this run makes is listed the way Settings → Diagnostics lists it.
    let diagnostics = DiagnosticsLog(capacity: 2000)
    let transport = PrismClient(origin: origin, tokenStore: tokens, userAgent: "OmniSmoke/1", onSignedOut: { await signedOut.set() }, onRequest: diagnostics.observer)
    let omni = OmniClient(transport: transport)
    // What the backend already held before this run touched it (an empty stub, or old threads).
    var preexisting: [OmniThread] = []

    await report.step("server probe (what the first-run screen does, no credential)") {
        let result = await LiveServerProbe().probe(origin)
        try check(result == .ready, "probe said \(result)")
        return "ready"
    }

    await report.step("what was there before: threads from earlier runs") {
        preexisting = try await omni.threads().threads
        let gone = preexisting.filter(\.gone).count
        if env["OMNI_SMOKE_EXPECT_OLD"] == "1" { try check(!preexisting.isEmpty, "this run expected threads from an earlier run and found none") }
        if env["OMNI_SMOKE_EXPECT_EMPTY"] == "1" { try check(preexisting.isEmpty, "this run expected an empty backend and found \(preexisting.count) thread(s)") }
        if env["OMNI_SMOKE_EXPECT_GONE"] == "1" { try check(gone > 0, "this run expected threads the stub no longer has and the list marks none") }
        return preexisting.isEmpty ? "none (an empty backend)" : "\(preexisting.count) thread(s), \(gone) marked no longer available"
    }

    await report.step("version") {
        let v = try await omni.version()
        compare("version", try await raw(transport, "/api/omni/version"), Shape.version, report)
        return "api \(v.api), minClient \(v.minClient)"
    }

    var threadID = ""
    var seq = 0
    let created = await report.step("create a thread") {
        let c = try await omni.createThread(NewThread(prompt: "Hello from the Omni smoke run", title: "Omni smoke", source: "text"))
        threadID = c.thread.id
        try check(c.turnId != nil, "no turn id")
        return "state \(c.thread.state.rawValue), first turn started"
    }
    guard created else { return 1 }

    await report.step("stream the first turn: deltas, then the final text replaces them") {
        let c = try await follow(omni, threadID, after: 0)
        seq = c.transcript.lastSeq
        try check(c.deltas > 0, "no live text_delta arrived")
        try check(!c.names.contains { $0.hasPrefix("UNKNOWN") }, "an event PrismKit does not know: \(c.names.filter { $0.hasPrefix("UNKNOWN") })")
        let texts = c.transcript.items.compactMap { item -> (String, Bool)? in if case .text(_, let t, let f) = item { return (t, f) } else { return nil } }
        try check(!texts.isEmpty && texts.allSatisfy { $0.1 }, "a text block was left provisional")
        try check(texts.count == Set(c.events.compactMap { e -> String? in if case .text(let b, _) = e { return b } else { return nil } }).count, "deltas were not folded into their block")
        try check(c.transcript.result?.ok == true, "result: \(c.transcript.result?.errorCode ?? "none")")
        try check(c.transcript.state == .done, "final state \(c.transcript.state?.rawValue ?? "none")")
        return "\(c.deltas) deltas; \(c.names.joined(separator: " "))"
    }

    await report.step("list threads, read the thread") {
        let list = try await omni.threads()
        try check(list.hermesAvailable, "hermes: \(list.hermes)")
        try check(list.threads.contains { $0.id == threadID }, "the new thread is not listed")
        let rawList = try await raw(transport, "/api/omni/threads")
        compare("thread list", rawList, Shape.threadList, report)
        compare("thread", rawList["threads"]?.arrayValue?.first { $0["id"]?.stringValue == threadID }, Shape.thread, report)
        let detail = try await omni.thread(threadID)
        try check(detail.messages.contains { $0.role == .user && $0.text == "Hello from the Omni smoke run" }, "the first message is not in the transcript")
        try check(detail.messages.contains { $0.role == .assistant && ($0.text ?? "").isEmpty == false }, "no assistant message")
        try check(detail.activeTurnId == nil, "a turn is still listed as active")
        try check(detail.thread.lastSeq == seq, "thread.lastSeq \(detail.thread.lastSeq) is not the stream's last seq \(seq)")
        let rawDetail = try await raw(transport, "/api/omni/threads/\(threadID)")
        compare("thread detail", rawDetail, Shape.detail, report)
        compare("thread (detail)", rawDetail["thread"], Shape.thread, report)
        for m in rawDetail["messages"]?.arrayValue ?? [] { compare("message", m, Shape.message, report) }
        try check(detail.messages.allSatisfy { $0.at != nil }, "a message's `at` did not decode as a date")
        try check(detail.thread.lastActivityAt != nil, "thread.lastActivityAt did not decode as a date")
        let roles = Set(detail.messages.map(\.role.rawValue)).sorted().joined(separator: ",")
        return "\(list.threads.count) threads; \(detail.messages.count) messages (roles \(roles))"
    }

    await report.step("search finds the thread by its title") {
        let hit = try await omni.threads(search: "Omni smoke")
        try check(hit.threads.contains { $0.id == threadID }, "search did not find it")
        let miss = try await omni.threads(search: "zzz-no-such-thread-zzz")
        try check(!miss.threads.contains { $0.id == threadID }, "search matched everything")
        return "hit \(hit.threads.count), miss \(miss.threads.count)"
    }

    let key = IdempotencyKey.random()
    var secondTurn = ""
    await report.step("send a turn with an Idempotency-Key, then resend the SAME key") {
        let first = try await omni.startTurn(threadID: threadID, text: "And a second message", idempotencyKey: key)
        guard case .started(let id) = first else { throw StepFailed(what: "expected started, got \(first)") }
        secondTurn = id
        let c = try await follow(omni, threadID, after: seq)
        try check(c.transcript.result?.ok == true, "the turn failed")
        seq = c.transcript.lastSeq
        let again = try await omni.startTurn(threadID: threadID, text: "And a second message", idempotencyKey: key)
        guard case .replayed(let replayedID, _) = again else { throw StepFailed(what: "the same key was not a replay: \(again)") }
        try check(replayedID == secondTurn, "the replay named another turn")
        return "started, then replayed the same turn — no second turn"
    }

    await report.step("stub:slow — a second send is `alreadyRunning`; Stop cancels it") {
        let start = try await omni.startTurn(threadID: threadID, text: "stub:slow take your time", idempotencyKey: .random())
        let slow = start.turnId
        let acted = Flag()
        let threadID = threadID
        let c = try await follow(omni, threadID, after: seq) { collected in
            guard collected.deltas >= 2, await !acted.value else { return }
            await acted.set()
            if let busy = try? await omni.startTurn(threadID: threadID, text: "too soon", idempotencyKey: .random()), case .alreadyRunning(let id) = busy, id == slow {
                await acted.note("busy")
            }
            if let detail = try? await omni.thread(threadID), detail.activeTurnId == slow, detail.thread.state == .working, detail.thread.running {
                await acted.note("active")
            }
            if let cancel = try? await omni.cancelTurn(slow), cancel.status == "cancelling" { await acted.note("cancelling") }
        }
        let notes = await acted.notes
        try check(notes.contains("busy"), "a second turn while one runs was not alreadyRunning(the running turn)")
        try check(notes.contains("active"), "thread detail did not name the running turn (activeTurnId / working / running)")
        try check(notes.contains("cancelling"), "cancel did not answer `cancelling`")
        try check(c.transcript.result?.ok == false && c.transcript.result?.errorCode == "cancelled", "result \(c.transcript.result?.errorCode ?? "none")")
        try check(c.transcript.state == .waiting, "state after cancel: \(c.transcript.state?.rawValue ?? "none")")
        seq = c.transcript.lastSeq
        let ended = try await omni.cancelTurn(slow)
        try check(ended.status == "cancelled", "cancelling an ended turn answered \(ended.status)")
        return c.names.joined(separator: " ")
    }

    var approval: Approval?
    await report.step("stub:approval — the draft arrives on the stream; its digest verifies locally") {
        _ = try await omni.startTurn(threadID: threadID, text: "stub:approval draft an email to Dana", idempotencyKey: .random())
        let c = try await follow(omni, threadID, after: seq)
        seq = c.transcript.lastSeq
        let streamed = c.transcript.items.compactMap { item -> Approval? in if case .approval(let a) = item { return a } else { return nil } }.first
        guard let streamed else { throw StepFailed(what: "no approval event") }
        try check(streamed.isPending && streamed.kind == .email && streamed.threadId == threadID, "not a pending email on this thread")
        try check(streamed.digestMatchesPayload, "the locally computed digest differs from the server's")
        try check(c.transcript.state == .needsYou, "state \(c.transcript.state?.rawValue ?? "none")")
        let listed = try await omni.approvals().first { $0.id == streamed.id }
        guard let listed else { throw StepFailed(what: "not in the pending list") }
        try check(listed == streamed, "the listed approval differs from the streamed one")
        try check(listed.executor?.name == "proton-send" && listed.executor?.available == true && listed.executor?.enabled == false, "executor is not proton-send/available/off")
        try check(listed.createdAt != nil && listed.expiresAt != nil, "createdAt / expiresAt did not decode as dates")
        let rawList = try await raw(transport, "/api/omni/approvals", query: [URLQueryItem(name: "status", value: "pending")])
        let rawOne = rawList["approvals"]?.arrayValue?.first { $0["id"]?.stringValue == streamed.id }
        compare("approval", rawOne, Shape.approval, report)
        compare("approval.executor", rawOne?["executor"], Shape.executor, report)
        approval = listed
        let content = ApprovalContent(listed)
        return "\(content.headline); fields \(content.fields.map(\.label).joined(separator: "/")); body \(content.body?.count ?? 0) chars; \(c.names.joined(separator: " "))"
    }

    if let shown = approval {
        await report.step("decide: send → executor disabled, nothing sent, still pending (same key twice)") {
            let sendKey = IdempotencyKey.random()
            for attempt in 1...2 {
                do {
                    let outcome = try await omni.decide(shown: shown, .send, idempotencyKey: sendKey)
                    throw StepFailed(what: "attempt \(attempt): the send was not refused (status \(outcome.approval.status.rawValue))")
                } catch OmniError.executorNotReady(let code, let executor) {
                    try check(code == "executor_disabled" && executor == "proton-send", "refused as \(code) / \(executor ?? "nil")")
                }
            }
            let after = try await omni.approval(shown.id)
            try check(after.isPending && after.result == nil && after.decidedAt == nil, "the approval is \(after.status.rawValue)")
            return "OmniError.executorNotReady(executor_disabled, proton-send) both times; still pending"
        }

        await report.step("a tampered payload is refused locally, before anything is sent") {
            guard case .object(var object) = shown.payload else { throw StepFailed(what: "payload is not an object") }
            object["body"] = .string("something else entirely")
            var json = try JSONSerialization.jsonObject(with: PrismJSON.encoder().encode(shown)) as? [String: Any] ?? [:]
            json["payload"] = try JSONSerialization.jsonObject(with: PrismJSON.encoder().encode(JSONValue.object(object)))
            let tampered = try PrismJSON.decoder().decode(Approval.self, from: JSONSerialization.data(withJSONObject: json))
            try check(!tampered.digestMatchesPayload, "the tampered approval still verifies")
            do {
                _ = try await omni.decide(shown: tampered, .send, idempotencyKey: .random())
                throw StepFailed(what: "the tampered approval was sent to the server")
            } catch OmniError.localDigestMismatch {}
            return "digestMatchesPayload false; decide threw localDigestMismatch"
        }

        var edited: Approval?
        await report.step("edit the draft → a NEW pending approval; the old one is revised") {
            guard var draft = ApprovalDraft(shown) else { throw StepFailed(what: "this kind has nothing editable") }
            guard let index = draft.fields.firstIndex(where: { $0.key == "body" }) else { throw StepFailed(what: "no body field") }
            draft.fields[index].text += "\n\nEdited by the smoke run."
            let edit = try await omni.editApproval(shown: shown, payload: draft.payload)
            try check(edit.replaced == shown.id, "replaced \(edit.replaced)")
            try check(edit.approval.id != shown.id && edit.approval.isPending && edit.approval.digest != shown.digest, "not a new pending draft")
            try check(edit.approval.digestMatchesPayload, "the new draft's digest does not verify locally")
            try check(edit.approval.revises == shown.id, "revises = \(edit.approval.revises ?? "nil")")
            let old = try await omni.approval(shown.id)
            try check(old.status == .revised && old.supersededBy == edit.approval.id, "the old draft is \(old.status.rawValue), supersededBy \(old.supersededBy ?? "nil")")
            do {
                _ = try await omni.decide(shown: shown, .send, idempotencyKey: .random())
                throw StepFailed(what: "the replaced draft could still be decided")
            } catch let e as PrismError {
                try check(e.serverCode == "already_decided" || e.serverCode == "digest_mismatch", "the replaced draft answered \(e.serverCode ?? "nil")")
            }
            edited = edit.approval
            return "new id, new digest, old one revised and refused"
        }

        if let current = edited {
            await report.step("decide: cancel → cancelled; same key replays; another key is already_decided") {
                let k = IdempotencyKey.random()
                let first = try await omni.decide(shown: current, .cancel, idempotencyKey: k)
                try check(first.approval.status == .cancelled && !first.replayed && first.httpStatus == 200, "cancel: \(first.approval.status.rawValue) replayed=\(first.replayed)")
                try check(first.approval.decidedAt != nil, "decidedAt did not decode")
                let again = try await omni.decide(shown: current, .cancel, idempotencyKey: k)
                try check(again.replayed && again.approval.status == .cancelled, "the same key was not a replay")
                do {
                    _ = try await omni.decide(shown: current, .send, idempotencyKey: .random())
                    throw StepFailed(what: "a decided approval accepted another key")
                } catch let e as PrismError {
                    guard case .conflict(let f) = e, f.code == "already_decided" else { throw StepFailed(what: "expected conflict(already_decided), got \(e.serverCode ?? "another error")") }
                }
                return "cancelled; replayed; conflict(already_decided)"
            }
        }
    }

    await report.step("every approval kind: the digest verifies locally; Send is refused honestly; Cancel works") {
        var out: [String] = []
        for kind in ["email-reply", "message", "calendar-invite", "tweet", "wallet-proposal"] {
            _ = try await omni.startTurn(threadID: threadID, text: "stub:approval:\(kind)", idempotencyKey: .random())
            let c = try await follow(omni, threadID, after: seq)
            seq = c.transcript.lastSeq
            guard let a = c.transcript.items.compactMap({ item -> Approval? in if case .approval(let a) = item { return a } else { return nil } }).last else {
                throw StepFailed(what: "\(kind): no approval event")
            }
            try check(a.kind.rawValue == kind, "\(kind): arrived as \(a.kind.rawValue)")
            try check(a.digestMatchesPayload, "\(kind): the locally computed digest differs from the server's")
            let content = ApprovalContent(a)
            let known = Set(ApprovalContent.shownKeys(for: a.kind))
            let extra = Set(a.payload.objectValue?.keys.map { $0 } ?? []).subtracting(known)
            if !extra.isEmpty { report.mismatch("approval payload (\(kind)): keys the docs do not list: \(extra.sorted().joined(separator: ", "))") }
            var refusal = "sent?!"
            do {
                _ = try await omni.decide(shown: a, .send, idempotencyKey: .random())
            } catch OmniError.executorNotReady(let code, _) {
                refusal = code
            }
            try check(refusal == "executor_disabled" || refusal == "executor_unavailable", "\(kind): send answered \(refusal)")
            let cancelled = try await omni.decide(shown: a, .cancel, idempotencyKey: .random())
            try check(cancelled.approval.status == .cancelled, "\(kind): cancel left it \(cancelled.approval.status.rawValue)")
            out.append("\(kind): \(content.fields.map(\.label).joined(separator: "/"))\(content.body == nil ? "" : "+body") → \(refusal)")
        }
        return out.joined(separator: "; ")
    }

    await report.step("other stub turns decode: Hermes' own approval request, a queued run, an empty run") {
        var out: [String] = []
        for text in ["stub:hermes-approval", "stub:queued", "stub:empty"] {
            _ = try await omni.startTurn(threadID: threadID, text: text, idempotencyKey: .random())
            let c = try await follow(omni, threadID, after: seq)
            seq = c.transcript.lastSeq
            try check(!c.names.contains { $0.hasPrefix("UNKNOWN") }, "\(text): an event PrismKit does not know")
            try check(c.transcript.result != nil, "\(text): no result")
            out.append("\(text): \(c.names.joined(separator: " "))")
        }
        return out.joined(separator: "; ")
    }

    await report.step("rename and pin the thread (PATCH)") {
        let renamed = try await omni.updateThread(threadID, ThreadPatch(title: "Omni smoke (renamed)", pinned: true))
        try check(renamed.title == "Omni smoke (renamed)" && renamed.pinned, "the patch did not apply")
        let listed = try await omni.threads().threads.first
        try check(listed?.id == threadID, "a pinned thread is not listed first")
        _ = try await omni.updateThread(threadID, ThreadPatch(pinned: false))
        return "renamed, pinned first, unpinned"
    }

    await report.step("failure codes arrive as codes, never as the agent's own text") {
        var out: [String] = []
        for (text, code) in [("stub:error:auth_failed", "auth"), ("stub:drop", "hermes_unavailable"), ("stub:truncate", "stream_ended")] {
            _ = try await omni.startTurn(threadID: threadID, text: text, idempotencyKey: .random())
            let c = try await follow(omni, threadID, after: seq)
            seq = c.transcript.lastSeq
            try check(c.transcript.result?.ok == false && c.transcript.result?.errorCode == code, "\(text): \(c.transcript.result?.errorCode ?? "none")")
            out.append("\(code) → \"\(PlainLanguage.turnFailure(code))\"")
        }
        return out.joined(separator: "; ")
    }

    await report.step("stub:followup — an agent-initiated message reaches the change channel") {
        let sawThread = Flag()
        let listening = Flag()
        let threadID = threadID
        let listener = Task {
            for try await update in omni.notices() {
                switch update {
                case .connected: await listening.set()
                case .notice(let n) where n.type == "thread" && n.id == threadID && n.op == "message": await sawThread.set()
                default: break
                }
            }
        }
        defer { listener.cancel() }
        var connected = false
        for _ in 0..<100 where !connected {
            connected = await listening.value
            if !connected { try await Task.sleep(for: .milliseconds(100)) }
        }
        try check(connected, "the change channel did not connect")
        _ = try await omni.startTurn(threadID: threadID, text: "stub:followup", idempotencyKey: .random())
        let c = try await follow(omni, threadID, after: seq)
        seq = c.transcript.lastSeq
        try check(c.transcript.result?.ok == true, "the turn failed")
        var seen = false
        for _ in 0..<100 where !seen {
            seen = await sawThread.value
            if !seen { try await Task.sleep(for: .milliseconds(100)) }
        }
        try check(seen, "no thread/message notice within 10 s")
        let unread = try await omni.threads().threads.first { $0.id == threadID }?.unread ?? 0
        try check(unread == 1, "unread is \(unread)")
        let tail = try await follow(omni, threadID, after: seq)
        seq = tail.transcript.lastSeq
        try check(tail.transcript.statusReason == "agent_message", "no status with reason agent_message")
        let detail = try await omni.thread(threadID)
        let cleared = try await omni.threads().threads.first { $0.id == threadID }?.unread ?? -1
        try check(cleared == 0, "reading the thread did not clear unread")
        return "notice thread/message; unread 1 → 0 after reading; \(detail.messages.count) messages"
    }

    await report.step("today") {
        let t = try await omni.today()
        let rawToday = try await raw(transport, "/api/omni/today", query: [URLQueryItem(name: "date", value: t.date)])
        compare("today", rawToday, Shape.today, report)
        compare("today.needsYou", rawToday["needsYou"], Shape.needsYou, report)
        for item in rawToday["inFlight"]?.arrayValue ?? [] { compare("today.inFlight", item, Shape.inFlight, report) }
        for item in rawToday["agenda"]?.arrayValue ?? [] { compare("today.agenda", item, Shape.agenda, report) }
        for item in rawToday["tasks"]?.arrayValue ?? [] { compare("today.tasks", item, Shape.task, report) }
        try check(t.date == TodayModel.dayString(Date(), calendar: .current), "the server answered for \(t.date)")
        let sections = "agenda \(t.agenda.map { String($0.count) } ?? "unavailable"), tasks \(t.tasks.map { String($0.count) } ?? "unavailable"), needs you \(t.needsYou.approvals.count), in flight \(t.inFlight.count)"
        return t.errors.isEmpty ? sections : "\(sections); sections the dev server could not build: \(t.errors.keys.sorted().joined(separator: ", "))"
    }

    await report.step("stub:card — a record card decodes and is listed on the thread") {
        let today = try await omni.today()
        guard let noteID = today.tasks?.first?.noteId ?? today.agenda?.first?.noteId else {
            return "SKIPPED: the dev vault has no task or meeting note to point a card at"
        }
        _ = try await omni.startTurn(threadID: threadID, text: "stub:card:\(noteID)", idempotencyKey: .random())
        let c = try await follow(omni, threadID, after: seq)
        seq = c.transcript.lastSeq
        try check(!c.names.contains { $0.hasPrefix("UNKNOWN") }, "an event PrismKit does not know: \(c.names)")
        let detail = try await omni.thread(threadID)
        guard let card = detail.cards.first else { throw StepFailed(what: "no card on the thread (\(c.names.joined(separator: " ")))") }
        try check(card.noteId == noteID && card.op == .updated, "card is \(card.op.rawValue)")
        try check(c.transcript.items.contains { if case .card = $0 { return true } else { return false } }, "the card was not on the stream")
        let rawCard = (try await raw(transport, "/api/omni/threads/\(threadID)"))["cards"]?.arrayValue?.first
        compare("card", rawCard, Shape.card, report)
        compare("card.writer", rawCard?["writer"], ["kind", "label"], report)
        compare("card.links", rawCard?["links"], ["prism", "prismApp", "omni"], report)
        return "card: op \(card.op.rawValue), type \(card.type ?? "nil"), writer \(card.writer?.kind ?? "nil"), links \(card.links?.prism == nil ? "absent" : "present")"
    }

    await report.step("jobs: list, pause, resume") {
        let jobs = try await omni.jobs()
        try check(!jobs.isEmpty, "no jobs")
        for item in (try await raw(transport, "/api/omni/jobs"))["jobs"]?.arrayValue ?? [] { compare("job", item, Shape.job, report) }
        guard let job = jobs.first(where: { !JobPresentation.isPaused($0) }) else { throw StepFailed(what: "no running job to pause") }
        let paused = try await omni.job(job.id, .pause)
        try check(JobPresentation.isPaused(paused), "pause did not pause it")
        let resumed = try await omni.job(job.id, .resume)
        try check(!JobPresentation.isPaused(resumed), "resume did not resume it")
        let described = jobs.map { "\(JobPresentation.schedule($0) == nil ? "no schedule" : "schedule ok")/\(JobPresentation.date($0.nextRunAt) == nil ? "no next run" : "next run ok")" }
        return "\(jobs.count) jobs (\(described.joined(separator: ", "))); pause → paused; resume → running"
    }

    // The same flows through the app's own view models (OmniCore), on the live gateway.
    let appSignedOut = Flag()
    let session = SessionModel(service: LiveOmniService(client: omni)) { Task { await appSignedOut.set() } }
    await report.step("app models: thread list groups by state; new thread streams to done") {
        session.start()
        await session.threads.refresh()
        try check(session.threads.phase == .loaded && !session.threads.sections.isEmpty, "the list did not load")
        let titles = session.threads.sections.map { "\($0.title) \($0.threads.count)" }.joined(separator: ", ")
        try check(await session.startThread(prompt: "A thread from the app's own models"), "create failed: \(session.threads.createError ?? "?")")
        guard case .thread(let id) = session.destination else { throw StepFailed(what: "the new thread was not opened") }
        let model = session.threadModel(for: id)
        await model.open()
        try check(model.isRunning, "the first turn is not being followed")
        var sawStreaming = false
        _ = await waitUntil(.seconds(30)) {
            if model.timeline.contains(where: { if case .streamingText = $0 { return true } else { return false } }) { sawStreaming = true }
            return !model.isRunning
        }
        try check(!model.isRunning, "the turn never finished")
        try check(sawStreaming, "no streaming text was shown while it ran")
        try check(model.turnEnded == nil, "turn ended with: \(model.turnEnded ?? "")")
        let kinds = model.timeline.map { item -> String in
            switch item {
            case .message(_, let role, _, _): return role.rawValue
            case .streamingText: return "streaming"
            case .pendingMessage: return "pending"
            case .tool: return "tool"
            case .card: return "card"
            case .approval: return "approval"
            case .turnEnded: return "ended"
            }
        }
        try check(kinds.first == "user" && kinds.contains("assistant") && !kinds.contains("streaming") && !kinds.contains("pending"), "timeline after the turn: \(kinds)")
        return "sections: \(titles); timeline \(kinds.joined(separator: " "))"
    }

    await report.step("app models: send, Stop (⌘.), approval card → Send says the executor is off") {
        guard case .thread(let id) = session.destination else { throw StepFailed(what: "no open thread") }
        let model = session.threadModel(for: id)
        model.draft = "stub:slow keep going"
        await model.send()
        try check(model.isRunning, "the slow turn did not start: \(model.sendState)")
        try check(await waitUntil(.seconds(15)) { model.timeline.contains { if case .streamingText = $0 { return true } else { return false } } }, "nothing streamed")
        await session.stopCurrentTurn()
        try check(await waitUntil(.seconds(15)) { !model.isRunning }, "Stop did not end the turn")
        try check(model.turnEnded == "Stopped.", "after Stop the thread says: \(model.turnEnded ?? "nothing")")

        model.draft = "stub:approval:email please"
        await model.send()
        try check(await waitUntil(.seconds(30)) { !model.isRunning }, "the approval turn never finished")
        guard let approvalID = model.timeline.compactMap({ item -> String? in if case .approval(let id) = item { return id } else { return nil } }).last, let card = session.approvals.card(for: approvalID) else {
            throw StepFailed(what: "no approval card in the thread")
        }
        try check(card.canOfferSend(), "Send is not offered on a verified pending draft")
        try check(card.sendingSwitchedOff == "Sending is switched off on this server.", "no advance warning that sending is off")
        try check(await waitUntil(.seconds(10)) { session.approvals.pending.contains { $0.id == approvalID } }, "the draft is not in Needs you")
        await session.approvals.send(approvalID)
        guard let after = session.approvals.card(for: approvalID) else { throw StepFailed(what: "the card vanished") }
        try check(after.notice?.text == "Sending is switched off on this server — nothing was sent. The draft is still waiting.", "notice: \(after.notice?.text ?? "none")")
        try check(after.standing() == .pending, "the card is no longer pending")
        await session.approvals.cancel(approvalID)
        try check(session.approvals.card(for: approvalID)?.standing() == .cancelled, "cancel did not cancel")
        try check(!session.approvals.pending.contains { $0.id == approvalID }, "a cancelled draft is still in Needs you")
        return "Stopped.; executor-off notice shown; cancelled"
    }

    await report.step("app models: Today and Recurring load") {
        await session.today.refresh()
        try check(session.today.phase == .loaded, "today: \(session.today.phase)")
        await session.jobs.refresh()
        try check(session.jobs.phase == .loaded && !session.jobs.jobs.isEmpty, "jobs: \(session.jobs.phase)")
        let partial = session.today.partialNotice.map { " — partial: \($0)" } ?? ", every section loaded"
        return "today \(session.today.today?.date ?? "?")\(partial); \(session.jobs.jobs.count) jobs"
    }

    await report.step("app models: a failed turn and a dropped connection say so in words, and the thread still works afterwards") {
        guard case .thread(let id) = session.destination else { throw StepFailed(what: "no open thread") }
        let model = session.threadModel(for: id)
        var said: [String] = []
        for (marker, expected) in [("stub:error", "The agent couldn't finish that."), ("stub:error:rate_limit", "The model's usage limit was reached. Try again later."), ("stub:drop", "The connection to the agent was lost before it finished."), ("stub:truncate", "The connection to the agent was lost before it finished.")] {
            model.draft = "\(marker) please"
            await model.send()
            try check(model.sendState == .idle, "\(marker): the send itself failed: \(model.sendState)")
            try check(await waitUntil(.seconds(30)) { !model.isRunning }, "\(marker): the turn never ended")
            try check(model.turnEnded == expected, "\(marker): the thread says “\(model.turnEnded ?? "nothing")”")
            try check(model.phase == .loaded && model.streamProblem == nil, "\(marker): left a problem banner: \(model.streamProblem ?? "phase \(model.phase)")")
            said.append("\(marker) → “\(expected)”")
        }
        // The chat request itself refused by the agent (5xx): still a turn that ends in words.
        model.draft = "stub:http:503 please"
        await model.send()
        try check(await waitUntil(.seconds(30)) { !model.isRunning }, "stub:http: the turn never ended")
        try check(model.turnEnded != nil, "stub:http:503 ended without a word")
        said.append("stub:http:503 → “\(model.turnEnded ?? "")”")
        // And it is not stuck: the next ordinary message goes through.
        model.draft = "and a normal one after the failures"
        try check(model.canSend, "the composer is disabled after a failed turn")
        await model.send()
        try check(await waitUntil(.seconds(30)) { !model.isRunning }, "the turn after the failures never ended")
        try check(model.turnEnded == nil, "the turn after the failures says: \(model.turnEnded ?? "")")
        return said.joined(separator: "; ") + "; then a normal turn worked"
    }

    await report.step("app screens, as each does on appearing: sidebar groups, Needs you badge, Today, Recurring, ⌘R on each") {
        await session.threads.refresh()
        await session.approvals.refresh()
        try check(session.threads.phase == .loaded, "threads: \(session.threads.phase)")
        try check(session.approvals.phase == .loaded, "approvals: \(session.approvals.phase)")
        let serverPending = try await omni.approvals(status: .pending).count
        try check(session.approvals.pendingCount == serverPending, "the Needs you badge says \(session.approvals.pendingCount), the server \(serverPending)")
        var opened: [String] = []
        // One thread from every group the sidebar shows.
        for section in session.threads.sections {
            guard let thread = section.threads.first(where: { !$0.gone }) else { continue }
            session.destination = .thread(thread.id)
            let model = session.threadModel(for: thread.id)
            await session.openThread(model)
            try check(model.phase == .loaded, "\(section.title): opening “\(ThreadGrouping.displayTitle(thread))” gave \(model.phase)")
            _ = await waitUntil(.seconds(20)) { !model.isRunning }
            await session.refreshVisible()
            try check(model.phase == .loaded && model.streamProblem == nil, "\(section.title): after ⌘R: \(model.streamProblem ?? "\(model.phase)")")
            model.close()
            opened.append("\(section.title) \(section.threads.count)")
        }
        for destination in [Destination.today, .needsYou, .recurring, .newThread] {
            session.destination = destination
            await session.refreshVisible()
        }
        try check(session.today.phase == .loaded, "Today after ⌘R: \(session.today.phase)")
        try check(session.jobs.phase == .loaded, "Recurring after ⌘R: \(session.jobs.phase)")
        // Search: a word no thread has → the empty-search state, then back to the full list.
        session.threads.searchText = "zzz-no-thread-has-this-zzz"
        await session.threads.refresh()
        try check(session.threads.isEmpty && session.threads.isSearching, "a search with no hits is not the empty state")
        session.threads.searchText = ""
        await session.threads.refresh()
        try check(!session.threads.isEmpty, "the list did not come back after clearing the search")
        return "groups: \(opened.joined(separator: ", ")); badge \(serverPending); Today, Needs you, Recurring and New Thread refreshed; search empty state ok"
    }

    await report.step("old threads: each one opens, or says it is no longer available — never a dead screen, never asked for twice") {
        await session.threads.refresh()
        let old = session.threads.threads.filter { t in preexisting.contains { $0.id == t.id } }
        guard !old.isEmpty else { return "no threads from an earlier run on this backend" }
        var loaded = 0, unavailable = 0
        for thread in old.prefix(40) {
            let before = diagnostics.entries.count
            let model = session.threadModel(for: thread.id)
            await session.openThread(model)
            // What the first run did: the screen appears, a notice and a reconnect arrive, the person comes back to it.
            await model.changedOnServer()
            await model.open()
            _ = await waitUntil(.seconds(1)) { diagnostics.entries.count > before }
            let reads = diagnostics.entries[before...].filter { $0.line.contains("GET /api/omni/threads/\(thread.id) ") }.count
            if model.isUnavailable {
                unavailable += 1
                try check(model.phase.failure == PlainLanguage.threadUnavailable, "an unavailable thread says: \(model.phase.failure ?? "nothing")")
                try check(reads <= 1, "an unavailable thread was asked for \(reads) times")
                try check(!model.canSend, "a message can be sent into a thread that is gone")
                try check(session.threads.thread(thread.id)?.gone == true, "the list does not mark it")
            } else {
                loaded += 1
                try check(model.phase == .loaded, "“\(ThreadGrouping.displayTitle(thread))” gave \(model.phase)")
            }
            model.close()
        }
        if env["OMNI_SMOKE_EXPECT_GONE"] == "1" { try check(unavailable > 0, "expected at least one unavailable thread") }
        var removedNote = ""
        if let victim = session.threads.threads.first(where: { $0.gone }) {
            session.destination = .thread(victim.id)
            try check(await session.removeThread(victim.id), "Remove from List failed: \(session.threads.removeError ?? "?")")
            try check(session.destination == .today, "after removing, the window is on \(String(describing: session.destination))")
            let listed = try await omni.threads().threads.contains { $0.id == victim.id }
            let archived = try await omni.threads(includeArchived: true).threads.first { $0.id == victim.id }
            try check(!listed && archived?.archived == true, "the removed thread is still listed (or was deleted, not archived)")
            removedNote = "; removed one from the list (archived on the server, not deleted)"
        }
        return "\(old.count) old thread(s): \(loaded) opened, \(unavailable) no longer available\(removedNote)"
    }

    await report.step("a thread the server has never heard of: one request, a clear state, nothing sendable") {
        let ghost = session.threadModel(for: "omni_0000000000000000deadbeef")
        let before = diagnostics.entries.count
        await ghost.open()
        await ghost.open()
        await ghost.changedOnServer()
        try check(ghost.isUnavailable && !ghost.canSend, "phase \(ghost.phase)")
        _ = await waitUntil(.seconds(2)) { diagnostics.entries.count > before }
        let lines = diagnostics.entries[before...].map(\.line).filter { $0.contains("omni_0000000000000000deadbeef") }
        try check(lines.count == 1 && lines[0].contains("→ 404 not_found"), "requests: \(lines)")
        return "1 request (404 not_found) → “\(PlainLanguage.threadUnavailable)”"
    }

    await report.step("diagnostics: the request list names what failed and holds no secret") {
        _ = await waitUntil(.seconds(2)) { diagnostics.entries.count > 20 }
        let text = diagnostics.text
        let held = (try? tokens.token(for: origin)) ?? nil
        try check(diagnostics.entries.count > 20, "only \(diagnostics.entries.count) lines")
        try check(text.contains("POST /api/omni/threads →") && text.contains("[stream] → 200"), "the list is missing ordinary requests")
        try check(text.contains("→ 404 not_found") && text.contains("executor_disabled"), "the failures of this run are not in the list")
        if let held { try check(!text.contains(held), "THE TOKEN IS IN THE DIAGNOSTICS LIST") }
        for secret in [cookie, "Bearer", "pd_", "stub:", "dana@example.com", "?q=", "Idempotency"] {
            try check(!text.contains(secret), "the list contains “\(secret == cookie ? "the session cookie" : secret)”")
        }
        return "\(diagnostics.entries.count) lines, \(diagnostics.failureCount) failures, e.g. “\(diagnostics.entries.first(where: \.isFailure)?.line ?? "")”; no token, cookie, query, message text or address"
    }
    session.stop()

    await report.step("signed out: a revoked token → PrismError.signedOut, token forgotten, handler run once") {
        // Revoke on the server only (as "Revoke" in Prism → Account → Devices would): the
        // app still holds the token and finds out on its next call.
        guard let held = try tokens.token(for: origin) else { throw StepFailed(what: "no token held") }
        try await DeviceAuthClient(origin: origin, configuration: .omniNative).revoke(token: held)
        do {
            _ = try await omni.version()
            throw StepFailed(what: "a dead token was accepted")
        } catch PrismError.signedOut {}
        try check(await signedOut.value, "the signed-out handler did not run")
        try check(try tokens.token(for: origin) == nil, "the dead token was not forgotten")
        do {
            _ = try await omni.version()
            throw StepFailed(what: "a call without a token was sent")
        } catch PrismError.notSignedIn {}
        return "signedOut → handler → notSignedIn afterwards"
    }

    print("")
    if report.mismatches.isEmpty {
        print("PrismKit models vs the gateway's JSON: no differences in the objects seen.")
    } else {
        print("PrismKit models vs the gateway's JSON — \(report.mismatches.count) difference(s):")
        for m in report.mismatches { print("  - \(m)") }
    }
    print("\(report.count - report.failed)/\(report.count) steps passed")
    return report.failed == 0 ? 0 : 1
}

exit(await run())
