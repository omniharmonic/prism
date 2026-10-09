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
    public var serverText: String
    /// Why the address in ``serverText`` was refused.
    public private(set) var serverError: String?
    public private(set) var origin: ServerOrigin?
    /// The signed-in session's models; nil unless ``phase`` is `.signedIn`.
    public private(set) var session: SessionModel?

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
        makeEnvironment: @escaping EnvironmentFactory
    ) {
        self.settings = settings
        self.probe = probe
        self.deviceLabel = deviceLabel
        self.confirmation = confirmation
        self.sleep = sleep
        self.makeEnvironment = makeEnvironment
        self.serverText = settings.serverURL() ?? defaultServerURL
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
        signInTask = Task { [deviceLabel] in
            do {
                try await env.auth.signIn(label: deviceLabel)
                guard mine == self.generation else { return }
                self.enterSession(env)
            } catch {
                guard mine == self.generation else { return }
                let cancelled = (error as? DeviceAuthError) == .cancelled || error is CancellationError
                self.phase = .signedOut(notice: cancelled ? nil : PlainLanguage.message(for: error))
            }
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
