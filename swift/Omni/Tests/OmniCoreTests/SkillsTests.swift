import Foundation
import OmniClient
@testable import OmniCore
import PrismTransport
import XCTest

private actor TestSkills: SkillService {
    var conflict=false
    var savedRevision: String?
    let item: OmniSkill = Fixture.decode(["id":String(repeating:"a",count:32),"name":"sample","location":"sample/SKILL.md","editable":true,"revision":String(repeating:"b",count:64),"text":"Original"])
    func skills() async throws -> [OmniSkill] {[item]}
    func skill(_ id: String) async throws -> OmniSkill {item}
    func setConflict(){conflict=true}
    func saveSkill(_ id: String,text:String,revision:String) async throws -> OmniSkill {
        savedRevision=revision
        if conflict {throw PrismError.conflict(ServerFailure(status:409,code:"skill_revision_conflict",detail:nil,body:Data()))}
        return Fixture.decode(["id":id,"name":"sample","location":"sample/SKILL.md","editable":true,"revision":String(repeating:"c",count:64),"text":text])
    }
}
@MainActor final class SkillsTests: XCTestCase {
    func testRevisionIsSentAndSuccessfulSaveReturnsNewVersion() async {
        let service=TestSkills();let model=SkillsModel(service:service,sink:ErrorSink{})
        await model.refresh();XCTAssertEqual(model.items.count,1)
        let loaded=await model.read(model.items[0].id)!
        let saved=await model.save(loaded,text:"Edited")
        XCTAssertEqual(saved?.text,"Edited");XCTAssertNotEqual(saved?.revision,loaded.revision)
        let revision=await service.savedRevision;XCTAssertEqual(revision,loaded.revision)
        XCTAssertFalse(model.busy)
    }
    func testConflictRetainsCallerDraftAndExplainsReload() async {
        let service=TestSkills();await service.setConflict()
        let model=SkillsModel(service:service,sink:ErrorSink{})
        let item=service.item
        let result=await model.save(item,text:"Unsaved draft")
        XCTAssertNil(result);XCTAssertTrue(model.problem?.contains("Your draft is kept") == true)
        XCTAssertFalse(model.busy)
    }
}
