import Foundation
import PrismTransport

public struct OmniNudge: Decodable, Sendable, Equatable, Identifiable {
    public struct OperationalSource: Decodable, Sendable, Equatable { public let kind: String; public let jobId: String?; public let runAt: Double?; public let subsystem: String?; public let lastSeen: Double? }
    public struct Candidate: Decodable, Sendable, Equatable {
        public let operationalSource: OperationalSource?
        public let sourceId: String
        public let sourcePath: String
        public let kind: String
        public let title: String
        public let summary: String
        public let reasons: [String]
        public let senderId: String?
        public let deadline: Double?
    }
    public let id: String
    public let candidate: Candidate
    public let sourceLink: String?
    public let updatedAt: Double
    public let score: Double
    public let surfaces: Int
    public let snoozedUntil: Double?
    public let dismissed: Bool
    public let threadId: String?
}
public struct NudgeWeeklyAudit: Decodable, Sendable, Equatable { public let caught: Int; public let missed: Int; public let noise: Int; public let replied: Int; public let unknownChat: Int; public let since: Double; public let through: Double }
public enum ProactivityDial: String, Codable, Sendable, CaseIterable { case off, conservative, balanced, eager }
public struct NudgeSettings: Codable, Sendable, Equatable {
    public var dial: ProactivityDial
    public var killed: Bool
    public init(dial: ProactivityDial = .balanced, killed: Bool = false) { self.dial = dial; self.killed = killed }
}
public enum NudgeAction: String, Codable, Sendable { case noise, relevant, dismiss, snooze, seen }
public enum NudgeStart: String, Codable, Sendable { case draftReply = "draft-reply", startWorking = "start-working" }
public struct NudgeStarted: Decodable, Sendable, Equatable { public let threadId: String; public let turnId: String? }

public extension OmniClient {
    func nudges(later: Bool = false) async throws -> [OmniNudge] {
        struct Answer: Decodable { let nudges: [OmniNudge] }
        let answer: Answer = try await transport.send(.get("/api/omni/nudges", query: later ? [URLQueryItem(name: "later", value: "1")] : []))
        return answer.nudges
    }
    func nudgeWeeklyAudit() async throws -> NudgeWeeklyAudit? {
        struct Answer: Decodable { let report: NudgeWeeklyAudit? }
        let answer: Answer = try await transport.send(.get("/api/omni/nudges/audit")); return answer.report
    }
    func nudgeSettings() async throws -> NudgeSettings { try await transport.send(.get("/api/omni/nudges/settings")) }
    func saveNudgeSettings(_ settings: NudgeSettings) async throws -> NudgeSettings { try await transport.send(.json("PATCH", "/api/omni/nudges/settings", body: settings)) }
    func actOnNudge(_ id: String, action: NudgeAction, until: Date? = nil) async throws -> OmniNudge {
        struct Body: Encodable { let action: NudgeAction; let until: Double? }
        return try await transport.send(.json("POST", "\(try Self.nudgePath(id))/action", body: Body(action: action, until: until.map { $0.timeIntervalSince1970 * 1000 })))
    }
    func startNudge(_ id: String, action: NudgeStart, key: IdempotencyKey) async throws -> NudgeStarted {
        struct Body: Encodable { let action: NudgeStart }
        return try await transport.send(.json("POST", "\(try Self.nudgePath(id))/start", body: Body(action: action), idempotencyKey: key))
    }
    private static func nudgePath(_ id: String) throws -> String {
        guard !id.isEmpty, id.count <= 128, id.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_" || $0 == "-") }) else { throw URLError(.badURL) }
        return "/api/omni/nudges/\(id)"
    }
}
