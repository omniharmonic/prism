// The UI-test launch path. DEBUG builds only: this whole file is compiled out of a Release
// build (Scripts/check-release.sh proves it), and it does nothing unless the process was
// launched with OMNI_UITEST=1 — which only the XCUITest runner does (UITests/).
//
// What it replaces, and why:
//  - the browser sign-in (UI tests cannot drive the system browser): the runner hands in a
//    device token it obtained for the DEV owner on the laptop dev gateway;
//  - the Keychain and UserDefaults: both are in memory, so a test run never touches a real
//    sign-in or the remembered server of the app the owner uses;
//  - Touch ID / Face ID before Send: let through (there is nobody to touch the sensor);
//  - a few server answers, on request (OMNI_UITEST_FAULTS), to show states the dev backend
//    cannot be made to produce.
// It refuses any server that is not http://127.0.0.1:<port>.
#if DEBUG
import Foundation
import OmniClient
import OmniCore
import PrismAuth
import PrismTransport
import SwiftUI

@MainActor
enum UITestLaunch {
    struct Configuration {
        /// The dev gateway, `http://127.0.0.1:<port>`.
        let server: String
        /// false = first run: no server remembered yet.
        let serverIsSaved: Bool
        /// A `pd_…` device token for the dev owner; nil = signed out.
        let token: String?
        let faults: Set<String>
        /// "light" | "dark" (macOS: the app's appearance; iOS uses the simulator's own setting).
        let appearance: String?
        /// Lay the app out in a column this wide, with a compact width class (an iPad Split
        /// View or Slide Over width, which a UI test cannot drag into being).
        let compactWidth: CGFloat?
    }

    static let configuration: Configuration? = parse(ProcessInfo.processInfo.environment)

    static var isActive: Bool { configuration != nil }

    static func parse(_ env: [String: String]) -> Configuration? {
        guard env["OMNI_UITEST"] == "1", let server = env["OMNI_UITEST_SERVER"], isLoopback(server) else { return nil }
        let token = env["OMNI_UITEST_TOKEN"].flatMap { $0.hasPrefix("pd_") ? $0 : nil }
        let faults = Set((env["OMNI_UITEST_FAULTS"] ?? "").split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) })
        return Configuration(
            server: server,
            serverIsSaved: env["OMNI_UITEST_FIRST_RUN"] != "1",
            token: token,
            faults: faults,
            appearance: env["OMNI_UITEST_APPEARANCE"],
            compactWidth: env["OMNI_UITEST_COMPACT_WIDTH"].flatMap(Double.init).map { CGFloat($0) }
        )
    }

    /// Only the laptop dev gateway: plain http, 127.0.0.1, an explicit port, nothing else.
    static func isLoopback(_ text: String) -> Bool {
        guard let url = URLComponents(string: text), url.scheme == "http", url.host == "127.0.0.1", url.port != nil else { return false }
        return (url.path.isEmpty || url.path == "/") && url.query == nil && url.user == nil
    }

    static func model(_ configuration: Configuration) -> AppModel {
        let tokens = InMemoryTokenStore()
        if let token = configuration.token, let origin = try? ServerOrigin(configuration.server) {
            try? tokens.setToken(token, for: origin)
        }
        let diagnostics = DiagnosticsLog()
        let live = OmniLive.environmentFactory(tokenStore: tokens, flow: NeverReturningFlow(), userAgent: "Omni/1 (ui-test)", diagnostics: diagnostics)
        let faults = configuration.faults
        #if os(iOS)
        // UIKit's transitions off for a test run: the runner waits for every animation to
        // end before each step, and a spinner removed mid-transition can leave it waiting
        // a minute at a time. What is drawn is the same; it just arrives at once.
        if ProcessInfo.processInfo.environment["OMNI_UITEST_ANIMATIONS"] == "0" { UIView.setAnimationsEnabled(false) }
        #endif
        #if os(macOS)
        if let name = configuration.appearance {
            NSApplication.shared.appearance = NSAppearance(named: name == "dark" ? .darkAqua : .aqua)
        }
        #endif
        return AppModel(
            settings: InMemorySettings(configuration.serverIsSaved ? configuration.server : nil),
            probe: LiveServerProbe(),
            deviceLabel: "Omni UI test",
            defaultServerURL: configuration.server,
            confirmation: NoSendConfirmation(),
            diagnostics: diagnostics,
            makeEnvironment: { origin, onSignedOut in
                let environment = live(origin, onSignedOut)
                guard !faults.isEmpty else { return environment }
                return ServerEnvironment(service: FaultInjectingService(base: environment.service, faults: faults), auth: environment.auth)
            }
        )
    }
}

/// The server address for one launch, in memory.
private final class InMemorySettings: SettingsStore, @unchecked Sendable {
    private let lock = NSLock()
    private var value: String?

    init(_ value: String?) {
        self.value = value
    }

    func serverURL() -> String? { lock.withLock { value } }
    func setServerURL(_ value: String?) { lock.withLock { self.value = value } }
}

/// Sign-in that waits for a browser which never opens: the "finish in your browser" screen
/// can be looked at and cancelled without a stray browser tab.
private struct NeverReturningFlow: RedirectFlow {
    func start() async throws -> any RedirectFlowSession { Session() }

    struct Session: RedirectFlowSession {
        var redirectURI: String { DeviceAuthConfiguration.omniNative.redirectURI }
        func waitForCode(authorizeURL: URL, expectedState: String) async throws -> String {
            try await Task.sleep(for: .seconds(3600))
            throw DeviceAuthError.cancelled
        }
    }
}

/// Changes a few answers on their way to the app. Names (OMNI_UITEST_FAULTS, comma-separated):
///  - `digest-mismatch`: every pending draft arrives with one word of its text changed, so it
///    no longer matches the server's fingerprint (what a tampered or corrupted answer would be);
///  - `today-partial`: Today arrives without the agenda, as when the vault query failed;
///  - `sample-data`: Today's agenda and tasks, and the titles on record cards, are replaced
///    with made-up ones — the laptop's dev vault holds real notes, and the screenshots are
///    committed to a public repository;
///  - `today-fail`, `threads-fail`, `jobs-fail`: the read does not get through.
private struct FaultInjectingService: OmniService {
    let base: any OmniService
    let faults: Set<String>

    private var noAnswer: any Error { PrismError.unreachable("ui-test fault") }

    private func tampered(_ approval: Approval) -> Approval {
        guard faults.contains("digest-mismatch"), approval.status == .pending,
              let data = try? PrismJSON.encoder().encode(approval),
              var object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              var payload = object["payload"] as? [String: Any] else { return approval }
        let key = ["body", "text", "description", "purpose", "title"].first { payload[$0] is String } ?? ""
        guard let text = payload[key] as? String else { return approval }
        payload[key] = text + " (changed on the way)"
        object["payload"] = payload
        guard let changed = try? JSONSerialization.data(withJSONObject: object), let decoded = try? PrismJSON.decoder().decode(Approval.self, from: changed) else { return approval }
        return decoded
    }

    func threads(states: [ThreadState], search: String?, includeArchived: Bool) async throws -> ThreadList {
        if faults.contains("threads-fail") { throw noAnswer }
        return try await base.threads(states: states, search: search, includeArchived: includeArchived)
    }
    func createThread(_ new: NewThread) async throws -> CreatedThread { try await base.createThread(new) }
    func thread(_ id: String) async throws -> ThreadDetail {
        let detail = try await base.thread(id)
        guard faults.contains("sample-data"), !detail.cards.isEmpty else { return detail }
        let cards = detail.cards.map { card -> RecordCard in
            guard let data = try? PrismJSON.encoder().encode(card), var object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return card }
            object["title"] = "Call Dana about the buoy spec"
            object["path"] = "tasks/call-dana"
            object["type"] = "task"
            object["summary"] = "properties status, due"
            guard let changed = try? JSONSerialization.data(withJSONObject: object), let decoded = try? PrismJSON.decoder().decode(RecordCard.self, from: changed) else { return card }
            return decoded
        }
        return ThreadDetail(thread: detail.thread, messages: detail.messages, cards: cards, approvals: detail.approvals, activeTurnId: detail.activeTurnId)
    }
    func updateThread(_ id: String, _ patch: ThreadPatch) async throws -> OmniThread { try await base.updateThread(id, patch) }
    func startTurn(threadID: String, text: String, idempotencyKey: IdempotencyKey) async throws -> TurnStart {
        try await base.startTurn(threadID: threadID, text: text, idempotencyKey: idempotencyKey)
    }
    func cancelTurn(_ turnID: String) async throws -> TurnCancellation { try await base.cancelTurn(turnID) }
    func threadStream(threadID: String, after: Int) -> AsyncThrowingStream<ThreadStreamUpdate, any Error> { base.threadStream(threadID: threadID, after: after) }
    func notices() -> AsyncThrowingStream<NoticeStreamUpdate, any Error> { base.notices() }
    func approvals(status: ApprovalStatus?) async throws -> [Approval] { try await base.approvals(status: status).map(tampered) }
    func approval(_ id: String) async throws -> Approval { tampered(try await base.approval(id)) }
    func editApproval(shown: Approval, payload: JSONValue) async throws -> ApprovalEdit { try await base.editApproval(shown: shown, payload: payload) }
    func decide(shown: Approval, _ decision: ApprovalDecisionKind, feedback: String?, idempotencyKey: IdempotencyKey) async throws -> ApprovalDecision {
        try await base.decide(shown: shown, decision, feedback: feedback, idempotencyKey: idempotencyKey)
    }
    func jobs() async throws -> [OmniJob] {
        if faults.contains("jobs-fail") { throw noAnswer }
        return try await base.jobs()
    }
    func job(_ id: String, _ action: JobAction) async throws -> OmniJob { try await base.job(id, action) }

    func today(date: String) async throws -> OmniToday {
        if faults.contains("today-fail") { throw noAnswer }
        guard faults.contains("today-partial") || faults.contains("sample-data") else { return try await base.today(date: date) }
        var object: [String: Any]
        if faults.contains("sample-data") {
            // Built here rather than read: the laptop's vault holds real notes (and is slow to
            // answer). The two live parts — drafts waiting and threads in flight — are real.
            let approvals = try await base.approvals(status: .pending).map(tampered)
            let running = try await base.threads(states: [], search: nil, includeArchived: false).threads.filter(\.running)
            let encoded = (try? JSONSerialization.jsonObject(with: PrismJSON.encoder().encode(approvals))) ?? []
            object = [
                "date": date,
                "agenda": [
                    ["noteId": "sample-a1", "title": "Stand-up", "start": "\(date)T09:30:00-06:00", "end": "\(date)T09:45:00-06:00"],
                    ["noteId": "sample-a2", "title": "Buoy spec review with Kevin and the hardware group", "start": "\(date)T11:00:00-06:00", "end": "\(date)T12:00:00-06:00", "location": "Studio B, second floor — or the video link in the invite"],
                    ["noteId": "sample-a3", "title": "Walk", "location": "Chautauqua"],
                ],
                "tasks": [
                    ["noteId": "sample-t1", "title": "Call Dana about the buoy spec", "status": "open", "due": date],
                    ["noteId": "sample-t2", "title": "Send the retreat agenda to the facilitators and ask who can bring a projector", "status": "open", "due": "2026-10-14"],
                    ["noteId": "sample-t3", "title": "Renew the domain", "status": "open"],
                ],
                "taskIdentity": "person",
                "needsYou": ["approvals": encoded, "nudges": [Any]()],
                "inFlight": running.map { ["id": $0.id, "title": $0.title ?? "Untitled thread", "state": $0.state.rawValue] },
                "errors": [String: String](),
            ]
        } else {
            let today = try await base.today(date: date)
            guard let data = try? PrismJSON.encoder().encode(today), let real = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return today }
            object = real
        }
        if faults.contains("today-partial") {
            object["agenda"] = NSNull()
            object["errors"] = ["agenda": "vault_error"]
        }
        return try PrismJSON.decoder().decode(OmniToday.self, from: JSONSerialization.data(withJSONObject: object))
    }
}

/// An iPad Split View width for a test: a fixed column with a compact width class.
struct UITestCompactWidth: ViewModifier {
    func body(content: Content) -> some View {
        if let width = UITestLaunch.configuration?.compactWidth {
            #if os(iOS)
            HStack(spacing: 0) {
                content
                    .environment(\.horizontalSizeClass, .compact)
                    .frame(width: width)
                Divider()
                Color(uiColor: .systemGroupedBackground).ignoresSafeArea()
            }
            #else
            content.frame(width: width)
            #endif
        } else {
            content
        }
    }
}
#endif
