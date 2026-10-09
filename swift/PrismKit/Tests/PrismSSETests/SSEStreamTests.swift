import Foundation
import PrismSSE
import XCTest

/// Scripted connections: each connect call pops the next script.
final class ScriptedSource: @unchecked Sendable {
    enum Step {
        case chunks([String], then: (any Error)?)
        case fail(any Error)
        /// Stays open until the consumer goes away.
        case hang([String])
    }
    private let lock = NSLock()
    private var steps: [Step]
    private var _connects: [String?] = []
    private var _terminated = 0

    init(_ steps: [Step]) { self.steps = steps }

    var connects: [String?] { lock.lock(); defer { lock.unlock() }; return _connects }
    var terminated: Int { lock.lock(); defer { lock.unlock() }; return _terminated }

    private func next(_ lastEventID: String?) -> Step {
        lock.lock()
        defer { lock.unlock() }
        _connects.append(lastEventID)
        return steps.isEmpty ? Step.fail(TestError.exhausted) : steps.removeFirst()
    }

    func connect(_ lastEventID: String?) async throws -> AsyncThrowingStream<Data, any Error> {
        let step = next(lastEventID)
        switch step {
        case .fail(let e): throw e
        case .chunks(let chunks, let then):
            return AsyncThrowingStream { c in
                for chunk in chunks { c.yield(Data(chunk.utf8)) }
                c.finish(throwing: then)
            }
        case .hang(let chunks):
            return AsyncThrowingStream { c in
                for chunk in chunks { c.yield(Data(chunk.utf8)) }
                c.onTermination = { _ in
                    self.lock.lock()
                    self._terminated += 1
                    self.lock.unlock()
                }
            }
        }
    }
}

enum TestError: Error, Equatable { case dropped, fatal, exhausted }

final class SSEStreamTests: XCTestCase {
    let noSleep: SSEStream.Sleep = { _ in }

    func collect(_ s: AsyncThrowingStream<SSEStreamItem, any Error>) async throws -> [SSEStreamItem] {
        var out: [SSEStreamItem] = []
        for try await item in s { out.append(item) }
        return out
    }

    func testReconnectResumesWithLastEventID() async throws {
        let source = ScriptedSource([
            // Persisted 1 and 2, then a live delta (no id), then the connection drops.
            .chunks(["event: text\ndata: one\nid: 1\n\n", "event: text\ndata: two\nid: 2\n\nevent: text_delta\ndata: liv", "e\n\n"], then: TestError.dropped),
            // Refused once (still retrying), then the replay after 2 and a clean end.
            .fail(TestError.dropped),
            .chunks([": ping\n\n", "event: text\ndata: three\nid: 3\n\n"], then: nil),
        ])
        let slept = Recorder<Duration>()
        let stream = SSEStream.events(policy: SSERetryPolicy(initialDelay: .seconds(1), jitter: 0), reconnectOnEnd: false, sleep: { slept.add($0) }) { try await source.connect($0) }
        let items = try await collect(stream)
        XCTAssertEqual(source.connects, [nil, "2", "2"], "the resume cursor is the last PERSISTED id, not moved by the id-less delta")
        XCTAssertEqual(items, [
            .connected(attempt: 0),
            .event(SSEEvent(event: "text", data: "one", id: "1")),
            .event(SSEEvent(event: "text", data: "two", id: "2")),
            .event(SSEEvent(event: "text_delta", data: "live")),
            .reconnecting(attempt: 1, delay: .seconds(1)),
            .reconnecting(attempt: 1, delay: .seconds(2)),
            .connected(attempt: 1),
            .keepalive,
            .event(SSEEvent(event: "text", data: "three", id: "3")),
        ])
        XCTAssertEqual(slept.values, [.seconds(1), .seconds(2)], "backoff grows while attempts keep failing")
    }

    func testAHalfReceivedEventIsDroppedOnReconnect() async throws {
        let source = ScriptedSource([
            .chunks(["event: text\ndata: one\nid: 1\n\nevent: text\ndata: half"], then: TestError.dropped),
            .chunks(["event: text\ndata: two\nid: 2\n\n"], then: nil),
        ])
        let items = try await collect(SSEStream.events(reconnectOnEnd: false, sleep: noSleep) { try await source.connect($0) })
        let events = items.compactMap { if case .event(let e) = $0 { return e.data } else { return nil } }
        XCTAssertEqual(events, ["one", "two"], "the partial event never merges into the next connection's first event")
    }

    func testSeededCursorIsSentOnTheFirstConnect() async throws {
        let source = ScriptedSource([.chunks([], then: nil)])
        _ = try await collect(SSEStream.events(lastEventID: "41", reconnectOnEnd: false, sleep: noSleep) { try await source.connect($0) })
        XCTAssertEqual(source.connects, ["41"])
    }

    func testFatalErrorsEndTheStream() async {
        let source = ScriptedSource([.fail(TestError.fatal), .chunks(["data: never\n\n"], then: nil)])
        do {
            _ = try await collect(SSEStream.events(classify: { ($0 as? TestError) == .fatal ? .fail : .retry }, sleep: noSleep) { try await source.connect($0) })
            XCTFail("expected the fatal error")
        } catch {
            XCTAssertEqual(error as? TestError, .fatal)
        }
        XCTAssertEqual(source.connects.count, 1)
    }

    func testMaxAttemptsGivesUpWithTheLastError() async {
        let source = ScriptedSource([.fail(TestError.dropped), .fail(TestError.dropped), .fail(TestError.dropped), .chunks(["data: never\n\n"], then: nil)])
        do {
            _ = try await collect(SSEStream.events(policy: SSERetryPolicy(maxAttempts: 2), sleep: noSleep) { try await source.connect($0) })
            XCTFail("expected to give up")
        } catch {
            XCTAssertEqual(error as? TestError, .dropped)
        }
        XCTAssertEqual(source.connects.count, 3, "the first try + 2 retries")
    }

    func testReconnectOnEndFollowsARecycledChannelAndHonoursRetry() async throws {
        let source = ScriptedSource([
            .chunks(["retry: 3000\n\nevent: thread\ndata: a\n\n"], then: nil),
            .chunks(["event: thread\ndata: b\n\n"], then: nil),
            .fail(TestError.fatal),
        ])
        let slept = Recorder<Duration>()
        var got: [String] = []
        do {
            for try await item in SSEStream.events(policy: SSERetryPolicy(jitter: 0), reconnectOnEnd: true, classify: { ($0 as? TestError) == .fatal ? .fail : .retry }, sleep: { slept.add($0) }, connect: { try await source.connect($0) }) {
                if case .event(let e) = item { got.append(e.data) }
            }
        } catch {
            XCTAssertEqual(error as? TestError, .fatal)
        }
        XCTAssertEqual(got, ["a", "b"])
        XCTAssertEqual(slept.values, [.seconds(3), .seconds(3)], "the server's retry: sets the base delay")
    }

    func testCancellationClosesTheConnectionAndEndsQuietly() async throws {
        let source = ScriptedSource([.hang(["event: text\ndata: one\nid: 1\n\n"])])
        let stream = SSEStream.events(sleep: noSleep) { try await source.connect($0) }
        let task = Task { () -> [SSEStreamItem] in
            var out: [SSEStreamItem] = []
            for try await item in stream {
                out.append(item)
                if case .event = item { withUnsafeCurrentTask { $0?.cancel() } }
            }
            return out
        }
        let items = try await task.value
        XCTAssertEqual(items.last, .event(SSEEvent(event: "text", data: "one", id: "1")))
        for _ in 0..<200 where source.terminated == 0 { try await Task.sleep(for: .milliseconds(5)) }
        XCTAssertEqual(source.terminated, 1, "the underlying connection was closed")
        XCTAssertEqual(source.connects.count, 1, "no reconnect after cancellation")
    }

    func testDroppingTheStreamStopsEverything() async throws {
        let source = ScriptedSource([.hang([]), .hang([])])
        do {
            let stream = SSEStream.events(sleep: noSleep) { try await source.connect($0) }
            var it = stream.makeAsyncIterator()
            let first = try await it.next()
            XCTAssertEqual(first, .connected(attempt: 0))
        }
        for _ in 0..<200 where source.terminated == 0 { try await Task.sleep(for: .milliseconds(5)) }
        XCTAssertEqual(source.terminated, 1)
        XCTAssertEqual(source.connects.count, 1)
    }
}

final class Recorder<T: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [T] = []
    func add(_ v: T) { lock.lock(); items.append(v); lock.unlock() }
    var values: [T] { lock.lock(); defer { lock.unlock() }; return items }
}
