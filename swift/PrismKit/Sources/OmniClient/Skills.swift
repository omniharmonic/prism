import Foundation
import PrismTransport

public struct OmniSkill: Decodable, Sendable, Equatable, Identifiable {
    public let id: String
    public let name: String
    public let location: String
    public let editable: Bool
    public let reason: String?
    public let revision: String?
    public let text: String?
}
public extension OmniClient {
    func skills() async throws -> [OmniSkill] {
        struct Answer: Decodable { let skills: [OmniSkill] }
        let result: Answer = try await transport.send(.get("/api/omni/skills"))
        return result.skills
    }
    func skill(_ id: String) async throws -> OmniSkill {
        struct Answer: Decodable { let skill: OmniSkill }
        let result: Answer = try await transport.send(.get(try Self.skillPath(id)))
        return result.skill
    }
    func saveSkill(_ id: String, text: String, revision: String) async throws -> OmniSkill {
        struct Body: Encodable { let text: String; let revision: String }
        struct Answer: Decodable { let skill: OmniSkill }
        let result: Answer = try await transport.send(.json("PUT", try Self.skillPath(id), body: Body(text:text,revision:revision)))
        return result.skill
    }
    private static func skillPath(_ id: String) throws -> String {
        guard id.count == 32, id.allSatisfy({ "0123456789abcdef".contains($0) }) else { throw PrismError.invalidRequest("Invalid skill ID") }
        return "/api/omni/skills/\(id)"
    }
}
