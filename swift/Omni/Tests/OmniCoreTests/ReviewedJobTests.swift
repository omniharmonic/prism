import Foundation
import XCTest
import OmniClient

final class ReviewedJobTests: XCTestCase {
    func testReviewedCapabilitiesDecodeAndScheduleEditDoesNotReplaceRunner() throws {
        let data = Data(#"{"id":"abcdef012345","no_agent":true,"script":"omni-nudges-context.sh","reviewedScript":true,"canEdit":true,"canRun":true,"canResume":true}"#.utf8)
        let job = try JSONDecoder().decode(OmniJob.self, from: data)
        XCTAssertEqual(job.reviewedScript, true)
        XCTAssertEqual(job.canEdit, true)
        XCTAssertEqual(job.canRun, true)
        XCTAssertEqual(job.canResume, true)
        let edit = JobEdit(name: "Context", schedule: "0 9 * * *", prompt: nil)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(edit)) as? [String: Any])
        XCTAssertEqual(Set(body.keys), ["name", "schedule"])
        let legacy = try JSONDecoder().decode(OmniJob.self, from: Data(#"{"id":"abcdef012345","script":"omni-sweep.sh","canEdit":false,"canRun":false,"canResume":false}"#.utf8))
        XCTAssertEqual(legacy.canResume, false)
    }
}
