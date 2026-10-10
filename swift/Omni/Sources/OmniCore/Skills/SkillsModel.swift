import Foundation
import Observation
import OmniClient
import PrismTransport

public protocol SkillService: Sendable {
    func skills() async throws -> [OmniSkill]
    func skill(_ id: String) async throws -> OmniSkill
    func saveSkill(_ id: String, text: String, revision: String) async throws -> OmniSkill
}
extension LiveOmniService: SkillService {
    public func skills() async throws -> [OmniSkill] { try await client.skills() }
    public func skill(_ id: String) async throws -> OmniSkill { try await client.skill(id) }
    public func saveSkill(_ id: String, text: String, revision: String) async throws -> OmniSkill { try await client.saveSkill(id,text:text,revision:revision) }
}
@MainActor @Observable
public final class SkillsModel {
    public private(set) var items: [OmniSkill] = []
    public private(set) var phase: LoadPhase = .idle
    public private(set) var busy = false
    public private(set) var problem: String?
    private let service: any SkillService
    private let sink: ErrorSink
    public init(service: any SkillService, sink: ErrorSink) { self.service=service;self.sink=sink }
    public func refresh() async {
        guard !busy else { return }
        phase = .loading
        do { items = try await service.skills(); phase = .loaded }
        catch {
            if (error as? PrismError)?.serverCode == "skills_not_configured" {phase = .failed("The server’s skills folder has not been configured.")}
            else if let message=sink.describe(error,reading:true) {phase = .failed(message)}
        }
    }
    public func read(_ id: String) async -> OmniSkill? {
        problem=nil
        do { return try await service.skill(id) }
        catch { problem=sink.describe(error,reading:true);return nil }
    }
    public func save(_ skill: OmniSkill,text: String) async -> OmniSkill? {
        guard !busy,skill.editable,let revision=skill.revision else {return nil}
        busy=true;problem=nil;defer{busy=false}
        do {return try await service.saveSkill(skill.id,text:text,revision:revision)}
        catch {
            if (error as? PrismError)?.serverCode == "skill_revision_conflict" {
                problem="This skill changed elsewhere. Your draft is kept. Reload the current version before saving again."
            } else {problem=sink.describe(error)}
            return nil
        }
    }
}
