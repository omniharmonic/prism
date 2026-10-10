import Foundation
import Observation
import OmniClient
import PrismTransport

public protocol NudgeService: Sendable {
    func nudges(later: Bool) async throws -> [OmniNudge]
    func nudgeSettings() async throws -> NudgeSettings
    func saveNudgeSettings(_ settings: NudgeSettings) async throws -> NudgeSettings
    func actOnNudge(_ id: String, action: NudgeAction, until: Date?) async throws -> OmniNudge
    func startNudge(_ id: String, action: NudgeStart, key: IdempotencyKey) async throws -> NudgeStarted
}
extension LiveOmniService: NudgeService {
    public func nudges(later: Bool) async throws -> [OmniNudge] { try await client.nudges(later: later) }
    public func nudgeSettings() async throws -> NudgeSettings { try await client.nudgeSettings() }
    public func saveNudgeSettings(_ settings: NudgeSettings) async throws -> NudgeSettings { try await client.saveNudgeSettings(settings) }
    public func actOnNudge(_ id: String, action: NudgeAction, until: Date?) async throws -> OmniNudge { try await client.actOnNudge(id, action: action, until: until) }
    public func startNudge(_ id: String, action: NudgeStart, key: IdempotencyKey) async throws -> NudgeStarted { try await client.startNudge(id, action: action, key: key) }
}
@MainActor @Observable
public final class NudgeCenter {
    public private(set) var items: [OmniNudge] = []
    public private(set) var later: [OmniNudge] = []
    public private(set) var settings = NudgeSettings()
    public private(set) var phase: LoadPhase = .idle
    public private(set) var failure: String?
    public private(set) var busy: Set<String> = []
    private let service: any NudgeService
    private let sink: ErrorSink
    @ObservationIgnored private var keys: [String: IdempotencyKey] = [:]
    public init(service: any NudgeService, sink: ErrorSink) { self.service = service; self.sink = sink }
    public func refresh() async {
        guard phase != .loading else { return }
        phase = .loading
        do {
            async let current = service.nudges(later: false)
            async let held = service.nudges(later: true)
            async let preferences = service.nudgeSettings()
            let values = try await (current, held, preferences)
            items = values.0; later = values.1; settings = values.2; phase = .loaded
        } catch { phase = .failed(sink.describe(error) ?? "Couldn’t load nudges") }
    }
    public func act(_ id: String, _ action: NudgeAction, until: Date? = nil) async {
        guard busy.insert(id).inserted else { return }
        defer { busy.remove(id) }
        failure = nil
        do { _ = try await service.actOnNudge(id, action: action, until: until); await refresh() }
        catch { failure = sink.describe(error) }
    }
    public func start(_ id: String, _ action: NudgeStart) async -> String? {
        guard busy.insert(id).inserted else { return nil }
        defer { busy.remove(id) }
        failure = nil
        let token = "\(id):\(action.rawValue)"
        let key = keys[token] ?? .random()
        keys[token] = key
        do { let result = try await service.startNudge(id, action: action, key: key); return result.threadId }
        catch { failure = sink.describe(error); return nil }
    }
    public func save(_ proposed: NudgeSettings) async {
        guard busy.insert("settings").inserted else { return }
        defer { busy.remove("settings") }
        do { settings = try await service.saveNudgeSettings(proposed); failure = nil }
        catch { failure = sink.describe(error) }
    }
}
