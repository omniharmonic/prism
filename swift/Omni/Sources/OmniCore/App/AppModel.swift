import Foundation
import Observation
import OmniClient
import PrismAuth
import PrismTransport

/// The app's root state: which server, reachable or not, signed in or not.
///
/// Nothing here starts a sign-in by itself; ``signIn()`` is only for a person's press.
/// The server address survives a sign-out and a 401.
@MainActor
@Observable
public final class AppModel {
    public enum Phase: Equatable, Sendable {
        /// First run, or the person asked to change the server.
        case needsServer
        /// Looking for the server.
        case connecting
        /// The server did not answer, or is not an Omni server. `message` says which.
        case unreachable(message: String)
        /// The server is there; nobody is signed in. `notice` explains how we got here.
        case signedOut(notice: String?)
        /// The browser is open; waiting for the person.
        case signingIn
        case signedIn
    }

    public private(set) var phase: Phase = .needsServer
    /// The address field on the first-run screen.
    public var serverText: String {
        // The reason an address was refused is about the address that was there.
        didSet { if serverText != oldValue { serverError = nil } }
    }
    /// Why the address in ``serverText`` was refused.
    public private(set) var serverError: String?
    public private(set) var origin: ServerOrigin?
    /// The signed-in session's models; nil unless ``phase`` is `.signedIn`.
    public private(set) var session: SessionModel?
    /// The request list for Settings → Diagnostics (development builds); nil otherwise.
    public let diagnostics: DiagnosticsLog?

    private let settings: any SettingsStore
    private let probe: any ServerProbe
    private let makeEnvironment: EnvironmentFactory
    private let deviceLabel: String
    private let confirmation: any SendConfirmation
    private let sleep: @Sendable (Duration) async throws -> Void
    private var environment: ServerEnvironment?
    private var signInTask: Task<Void, Never>?
    /// Bumped whenever the server or the sign-in changes, so a late callback from an old
    /// one is ignored.
    private var generation = 0
    /// Identifies ``environment``: a signed-out callback from a replaced one is ignored.
    private var environmentID = 0

    /// - Parameter defaultServerURL: prefilled on first run (the dev gateway in DEBUG builds;
    ///   empty in a release build).
    public init(
        settings: any SettingsStore,
        probe: any ServerProbe,
        deviceLabel: String,
        defaultServerURL: String = "",
        confirmation: any SendConfirmation = NoSendConfirmation(),
        sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) },
        diagnostics: DiagnosticsLog? = nil,
        makeEnvironment: @escaping EnvironmentFactory
    ) {
        self.diagnostics = diagnostics
        self.settings = settings
        self.probe = probe
        self.deviceLabel = deviceLabel
        self.confirmation = confirmation
        self.sleep = sleep
        self.makeEnvironment = makeEnvironment
        self.serverText = settings.serverURL() ?? defaultServerURL
    }

    /// Requires a live native session; registration is triggered only after Settings opt-in.
    public func registerPush(token: String, environment: String) async throws -> Bool {
        guard phase == .signedIn, let service = self.environment?.service as? any NativePushService else { throw CancellationError() }
        return try await service.registerPush(token: token, environment: environment)
    }

    public func unregisterPush() async throws {
        guard phase == .signedIn, let service = environment?.service as? any NativePushService else { return }
        try await service.unregisterPush()
    }

    /// Call once at launch: reconnect to the remembered server, if there is one.
    public func start() async {
        guard let saved = settings.serverURL(), let origin = try? ServerOrigin(saved) else {
            phase = .needsServer
            return
        }
        self.origin = origin
        await connect()
    }

    /// The person pressed Continue on the server screen.
    public func submitServer() async {
        do {
            let origin = try ServerOrigin(serverText)
            serverError = nil
            if origin != self.origin { tearDown() }
            self.origin = origin
            serverText = origin.value
            settings.setServerURL(origin.value)
            await connect()
        } catch let e as ServerOriginError {
            serverError = PlainLanguage.message(for: e)
        } catch {
            serverError = "That address can't be used."
        }
    }

    /// Look for the server (also the Retry button).
    public func connect() async {
        guard let origin else {
            phase = .needsServer
            return
        }
        generation += 1
        let mine = generation
        phase = .connecting
        let result = await probe.probe(origin)
        guard mine == generation else { return }
        if let problem = PlainLanguage.message(for: result) {
            diagnostics?.note("server check: \(Self.word(for: result))", isFailure: true)
            phase = .unreachable(message: problem)
            return
        }
        let envID = environmentID
        let env = environment ?? makeEnvironment(origin) { [weak self] in
            await self?.handleSignedOut(environmentID: envID)
        }
        environment = env
        if env.auth.hasToken {
            enterSession(env)
        } else {
            phase = .signedOut(notice: nil)
        }
    }

    /// The person pressed Sign in. Opens the browser and waits.
    public func signIn() {
        guard case .signedOut = phase, let env = environment else { return }
        generation += 1
        let mine = generation
        phase = .signingIn
        let envID = environmentID
        diagnostics?.note("sign-in: started (the browser opens)")
        signInTask = Task { [deviceLabel] in
            do {
                try await env.auth.signIn(label: deviceLabel)
                self.diagnostics?.note("sign-in: finished, the device is signed in")
                self.signInFinished(env, attempt: mine, environmentID: envID, error: nil)
            } catch {
                self.diagnostics?.note("sign-in: \(Self.word(for: error))", isFailure: !Self.isCancellation(error))
                self.signInFinished(env, attempt: mine, environmentID: envID, error: error)
            }
        }
    }

    /// What the screen shows after a sign-in attempt ends follows ONE fact: is a token
    /// stored for this server? If it is, the app is signed in — whatever the attempt
    /// reported (a late error after the token was kept, or a Cancel pressed while the last
    /// step was already through) — and no "sign-in failed" is shown over a working sign-in.
    private func signInFinished(_ env: ServerEnvironment, attempt: Int, environmentID envID: Int, error: (any Error)?) {
        // The server was changed meanwhile: this attempt says nothing about the new one.
        guard envID == self.environmentID, environment != nil else { return }
        if env.auth.hasToken {
            switch phase {
            case .signingIn, .signedOut:
                generation += 1
                enterSession(env)
            default:
                break
            }
            return
        }
        guard attempt == generation, let error else { return }
        phase = .signedOut(notice: Self.isCancellation(error) ? nil : PlainLanguage.message(for: error))
    }

    private static func isCancellation(_ error: any Error) -> Bool {
        (error as? DeviceAuthError) == .cancelled || error is CancellationError
    }

    /// A sign-in failure as a code for the diagnostics list (never a token, code or URL).
    private static func word(for error: any Error) -> String {
        if isCancellation(error) { return "cancelled" }
        if let e = error as? DeviceAuthError {
            switch e {
            case .server(let code, _, let status): return "failed, the token exchange answered \(status) \(code)"
            case .http(let status): return "failed, HTTP \(status)"
            case .denied(let code): return "denied in the browser (\(code))"
            case .timedOut: return "timed out waiting for the browser"
            case .unreachable(let why): return "failed, server unreachable (\(why))"
            case .flowUnavailable(let why): return "could not start (\(why))"
            case .tokenStore(let why): return "failed, Keychain (\(why))"
            default: return "failed (\(String(describing: e).prefix(40)))"
            }
        }
        return "failed"
    }

    private static func word(for probe: ServerProbeResult) -> String {
        switch probe {
        case .ready: return "ready"
        case .omniOff: return "the server answered, Omni is off there"
        case .unexpected(let status): return "unexpected answer (HTTP \(status))"
        case .unreachable(let why): return "no answer (\(why))"
        }
    }

    /// The person gave up waiting for the browser.
    public func cancelSignIn() {
        guard phase == .signingIn else { return }
        generation += 1
        signInTask?.cancel()
        signInTask = nil
        phase = .signedOut(notice: nil)
    }

    /// Revoke the token on the server and forget it. The server address is kept.
    public func signOut() async {
        guard let env = environment else { return }
        generation += 1
        closeSession()
        let result = await env.auth.signOut()
        phase = .signedOut(notice: PlainLanguage.signOut(result))
    }

    /// Go back to the server screen (signs out first when signed in).
    public func changeServer() async {
        if phase == .signedIn { await signOut() }
        signInTask?.cancel()
        tearDown()
        phase = .needsServer
    }

    /// The server confirmed the token dead (a 401 that `/auth/me` agreed with). PrismKit
    /// has already forgotten it; show sign-in again, on the same server.
    public func handleSignedOut() {
        guard phase == .signedIn || phase == .connecting else { return }
        diagnostics?.note("signed out: the server no longer accepts this device's sign-in", isFailure: true)
        generation += 1
        closeSession()
        phase = .signedOut(notice: "Your sign-in is no longer valid on this server. Sign in again.")
    }

    private func handleSignedOut(environmentID: Int) {
        // A callback from a server that has since been replaced says nothing about this one.
        guard environmentID == self.environmentID, environment != nil else { return }
        handleSignedOut()
    }

    private func enterSession(_ env: ServerEnvironment) {
        closeSession()
        let session = SessionModel(service: env.service, confirmation: confirmation, sleep: sleep) { [weak self] in
            self?.handleSignedOut()
        }
        self.session = session
        phase = .signedIn
        session.start()
    }

    private func closeSession() {
        session?.stop()
        session = nil
    }

    private func tearDown() {
        generation += 1
        environmentID += 1
        closeSession()
        environment = nil
    }
}
