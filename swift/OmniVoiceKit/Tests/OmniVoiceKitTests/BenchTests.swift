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

@MainActor final class AudioPermissionRaceTests: XCTestCase {
    func testStopInvalidatesPendingPermissionAndRejectsDuplicateStart() async {
        var completion: CheckedContinuation<Bool, Never>?
        var prompts = 0
        let audio = AudioIO(permission: {
            prompts += 1
            return await withCheckedContinuation { completion = $0 }
        })
        let file = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("omni-never-record-\(UUID().uuidString).caf")
        let first = Task { try await audio.start(url: file) }
        while completion == nil { await Task.yield() }
        do { try await audio.start(url: file); XCTFail("A duplicate pending start must be rejected") }
        catch { XCTAssertEqual(prompts, 1) }
        try? audio.stop()
        completion?.resume(returning: true)
        do { try await first.value; XCTFail("A late grant must not start the microphone") }
        catch { XCTAssertTrue(error is CancellationError) }
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
    }
}

final class FinalOnlyLatencyTests: XCTestCase {
    func testDrainedFinalOnlyStreamHasFirstWordLatency() async {
        let collector = HypothesisCollector(started: .now)
        let (stream, continuation) = AsyncStream<TranscriptEvent>.makeStream()
        let consumer = Task { for await event in stream { await collector.accept(event) } }
        continuation.yield(TranscriptEvent(confirmed: "Call Dana", volatile: ""))
        continuation.finish()
        await consumer.value
        let result = await collector.result(engine: "fixture", final: "Call Dana", speechEnd: 0)
        XCTAssertEqual(result.text, "Call Dana")
        XCTAssertNotNil(result.firstWordMilliseconds)
        XCTAssertGreaterThanOrEqual(result.finalMilliseconds, 0)
    }
}
