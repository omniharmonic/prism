import XCTest
@testable import OmniVoiceKit

final class BenchTests: XCTestCase {
    func testWordErrorsIncludeInsertionsDeletionsAndCasePunctuationNormalization() {
        XCTAssertEqual(BenchMetrics.wordErrorRate(reference: "Call Dana tomorrow.", hypothesis: "call DANA tomorrow"), 0)
        XCTAssertEqual(BenchMetrics.wordErrorRate(reference: "call Dana tomorrow", hypothesis: "call Kevin"), 2.0 / 3.0)
        XCTAssertEqual(BenchMetrics.wordErrorRate(reference: "call Dana", hypothesis: "please call Dana now"), 1)
        XCTAssertNil(BenchMetrics.wordErrorRate(reference: "", hypothesis: "noise"))
    }
    func testMultiwordNameErrorsCountOccurrencesAndDoNotMatchSubstrings() {
        let result = BenchMetrics.nameCounts(reference: "Benjamin Life called Tim, then Tim called Benjamin Life.", hypothesis: "Benjamin called Tim, then Timothy called Benjamin Life.", vocabulary: ["Benjamin Life", "Tim", "Dana"])
        XCTAssertEqual(result.count, 4)
        XCTAssertEqual(result.errors, 2)
    }
    func testVolatileRevisionDoesNotMutateConfirmedPrefixAndFinalFlushesIt() {
        var stabiliser = TranscriptStabiliser()
        stabiliser.update(confirmed: "Call", volatile: "Dan")
        XCTAssertEqual(stabiliser.text, "Call Dan")
        stabiliser.update(confirmed: "Call", volatile: "Dana tomorrow")
        XCTAssertEqual(stabiliser.confirmed, "Call")
        XCTAssertEqual(stabiliser.text, "Call Dana tomorrow")
        stabiliser.finish("Call Dana tomorrow.")
        XCTAssertEqual(stabiliser.volatile, "")
        XCTAssertEqual(stabiliser.text, "Call Dana tomorrow.")
    }
}
