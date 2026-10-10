import Foundation
import OmniClient
import PrismAuth
import PrismTransport

/// The gateway calls the app makes. `OmniClient` is the live implementation; tests use a
/// fake, so every view model is exercised without a server.
public protocol OmniService: Sendable {
    func threads(states: [ThreadState], search: String?, includeArchived: Bool) async throws -> ThreadList
    func createThread(_ new: NewThread) async throws -> CreatedThread
    func thread(_ id: String) async throws -> ThreadDetail
    func updateThread(_ id: String, _ patch: ThreadPatch) async throws -> OmniThread
    func startTurn(threadID: String, text: String, idempotencyKey: IdempotencyKey) async throws -> TurnStart
    func cancelTurn(_ turnID: String) async throws -> TurnCancellation
    func threadStream(threadID: String, after: Int) -> AsyncThrowingStream<ThreadStreamUpdate, any Error>
    func notices() -> AsyncThrowingStream<NoticeStreamUpdate, any Error>
    func approvals(status: ApprovalStatus?) async throws -> [Approval]
    func approval(_ id: String) async throws -> Approval
    func editApproval(shown: Approval, payload: JSONValue) async throws -> ApprovalEdit
    func decide(shown: Approval, _ decision: ApprovalDecisionKind, feedback: String?, idempotencyKey: IdempotencyKey) async throws -> ApprovalDecision
    func jobs() async throws -> [OmniJob]
    func job(_ id: String, _ action: JobAction) async throws -> OmniJob
    func today(date: String) async throws -> OmniToday
}

/// Optional native registration capability; sample services do not register with Apple.
public protocol NativePushService: Sendable {
    func registerPush(token: String, environment: String) async throws -> Bool
    func unregisterPush() async throws
}

/// `OmniClient` behind ``OmniService``.
public struct LiveOmniService: OmniService, NativePushService {
    public let client: OmniClient

    public init(client: OmniClient) {
        self.client = client
    }

    public func registerPush(token: String, environment: String) async throws -> Bool { try await client.registerPush(token: token, environment: environment) }
    public func unregisterPush() async throws { try await client.unregisterPush() }

    public func threads(states: [ThreadState], search: String?, includeArchived: Bool) async throws -> ThreadList {
        try await client.threads(states: states, search: search, includeArchived: includeArchived)
    }
    public func createThread(_ new: NewThread) async throws -> CreatedThread { try await client.createThread(new) }
    public func thread(_ id: String) async throws -> ThreadDetail { try await client.thread(id) }
    public func updateThread(_ id: String, _ patch: ThreadPatch) async throws -> OmniThread { try await client.updateThread(id, patch) }
    public func startTurn(threadID: String, text: String, idempotencyKey: IdempotencyKey) async throws -> TurnStart {
        try await client.startTurn(threadID: threadID, text: text, idempotencyKey: idempotencyKey)
    }
    public func cancelTurn(_ turnID: String) async throws -> TurnCancellation { try await client.cancelTurn(turnID) }
    public func threadStream(threadID: String, after: Int) -> AsyncThrowingStream<ThreadStreamUpdate, any Error> {
        client.threadStream(threadID: threadID, after: after)
    }
    public func notices() -> AsyncThrowingStream<NoticeStreamUpdate, any Error> { client.notices() }
    public func approvals(status: ApprovalStatus?) async throws -> [Approval] { try await client.approvals(status: status) }
    public func approval(_ id: String) async throws -> Approval { try await client.approval(id) }
    public func editApproval(shown: Approval, payload: JSONValue) async throws -> ApprovalEdit {
        try await client.editApproval(shown: shown, payload: payload)
    }
    public func decide(shown: Approval, _ decision: ApprovalDecisionKind, feedback: String?, idempotencyKey: IdempotencyKey) async throws -> ApprovalDecision {
        try await client.decide(shown: shown, decision, feedback: feedback, idempotencyKey: idempotencyKey)
    }
    public func jobs() async throws -> [OmniJob] { try await client.jobs() }
    public func job(_ id: String, _ action: JobAction) async throws -> OmniJob { try await client.job(id, action) }
    public func today(date: String) async throws -> OmniToday { try await client.today(date: date) }
}

/// Sign-in and sign-out for one server. The live one is `DeviceSignIn` + the platform's
/// browser leg.
public protocol SessionAuth: Sendable {
    /// Is a token stored? (Says nothing about whether the server still accepts it.)
    var hasToken: Bool { get }
    /// Only ever called from a person's press: every run registers a device on the server.
    func signIn(label: String) async throws
    func signOut() async -> SignOutResult
}

/// What a first, credential-free look at a server address found.
public enum ServerProbeResult: Sendable, Equatable {
    /// A Prism Server with the Omni module on.
    case ready
    /// It answered, but Omni is off there (every `/api/omni/*` route is a 404).
    case omniOff
    /// It answered something that is not a Prism Server's answer.
    case unexpected(status: Int)
    /// No answer at all.
    case unreachable(String)
}

public protocol ServerProbe: Sendable {
    func probe(_ origin: ServerOrigin) async -> ServerProbeResult
}

/// Where the server address is remembered between launches. Never a secret: the token
/// lives in the Keychain.
public protocol SettingsStore: Sendable {
    func serverURL() -> String?
    func setServerURL(_ value: String?)
}

/// Everything bound to one server origin.
public struct ServerEnvironment: Sendable {
    public let service: any OmniService
    public let auth: any SessionAuth

    public init(service: any OmniService, auth: any SessionAuth) {
        self.service = service
        self.auth = auth
    }
}

/// Builds the environment for an origin. `onSignedOut` must be called when the server has
/// confirmed the token dead.
public typealias EnvironmentFactory = @MainActor (ServerOrigin, _ onSignedOut: @escaping @Sendable () async -> Void) -> ServerEnvironment
