import Foundation

/// Reconnect timing: jittered exponential backoff, honouring the server's `retry:`.
public struct SSERetryPolicy: Sendable, Equatable {
    public var initialDelay: Duration
    public var maxDelay: Duration
    public var multiplier: Double
    /// 0…1: the share of each delay that is randomised (0.5 → 50–100 % of the nominal delay).
    public var jitter: Double
    /// Consecutive failed attempts before giving up (nil = keep trying).
    public var maxAttempts: Int?

    public init(initialDelay: Duration = .seconds(1), maxDelay: Duration = .seconds(30), multiplier: Double = 2, jitter: Double = 0.5, maxAttempts: Int? = nil) {
        self.initialDelay = initialDelay
        self.maxDelay = maxDelay
        self.multiplier = multiplier
        self.jitter = jitter
        self.maxAttempts = maxAttempts
    }

    public static let `default` = SSERetryPolicy()

    /// The delay before reconnect number `attempt` (1-based). `random` is 0..<1.
    public func delay(attempt: Int, serverRetry: Duration? = nil, random: Double = Double.random(in: 0..<1)) -> Duration {
        let base = Self.seconds(serverRetry ?? initialDelay)
        let cap = max(Self.seconds(maxDelay), 0)
        let nominal = min(cap, base * pow(max(multiplier, 1), Double(max(attempt, 1) - 1)))
        let j = min(max(jitter, 0), 1)
        return .milliseconds(Int((nominal * (1 - j + j * min(max(random, 0), 1)) * 1000).rounded()))
    }

    private static func seconds(_ d: Duration) -> Double {
        Double(d.components.seconds) + Double(d.components.attoseconds) / 1e18
    }
}

public enum SSEFailureDisposition: Sendable, Equatable {
    /// Reconnect after a backoff (network drops, 5xx, 408/425/429).
    case retry
    /// End the stream with this error (signed out, forbidden, not found, …).
    case fail
}

public enum SSEStreamItem: Sendable, Equatable {
    /// A connection was established (`attempt` 0 = the first, ≥ 1 = a reconnect).
    case connected(attempt: Int)
    case event(SSEEvent)
    /// A keepalive comment arrived.
    case keepalive
    /// The connection ended; the next attempt starts after `delay`.
    case reconnecting(attempt: Int, delay: Duration)
}

/// A reconnecting server-sent-event stream over any byte source. The connect closure gets
/// the id of the last persisted event (nil at first, unless seeded) and must send it as
/// `Last-Event-ID` (and/or the route's `?after=`).
///
/// Ends when: the consumer stops iterating or its task is cancelled (the connection is
/// closed), a failure is classified `.fail`, `maxAttempts` is exhausted, or the server
/// closes cleanly and `reconnectOnEnd` is false.
public enum SSEStream {
    public typealias Connect = @Sendable (_ lastEventID: String?) async throws -> AsyncThrowingStream<Data, any Error>
    public typealias Classify = @Sendable (any Error) -> SSEFailureDisposition
    public typealias Sleep = @Sendable (Duration) async throws -> Void

    public static func events(
        lastEventID: String? = nil,
        policy: SSERetryPolicy = .default,
        reconnectOnEnd: Bool = true,
        classify: @escaping Classify = { _ in .retry },
        sleep: @escaping Sleep = { try await Task.sleep(for: $0) },
        connect: @escaping Connect
    ) -> AsyncThrowingStream<SSEStreamItem, any Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                var parser = SSEParser(lastEventID: lastEventID)
                var failures = 0
                var connections = 0
                var serverRetry: Duration?
                while !Task.isCancelled {
                    var failure: (any Error)?
                    do {
                        let bytes = try await connect(parser.lastEventID)
                        continuation.yield(.connected(attempt: connections))
                        connections += 1
                        // A new connection starts a new event; keep only the resume cursor.
                        parser = SSEParser(lastEventID: parser.lastEventID)
                        for try await chunk in bytes {
                            for item in parser.feed(chunk) {
                                switch item {
                                case .event(let e):
                                    failures = 0
                                    continuation.yield(.event(e))
                                case .comment:
                                    failures = 0
                                    continuation.yield(.keepalive)
                                case .retry(let ms):
                                    serverRetry = .milliseconds(ms)
                                }
                            }
                        }
                        if !reconnectOnEnd {
                            continuation.finish()
                            return
                        }
                    } catch {
                        if error is CancellationError || Task.isCancelled {
                            continuation.finish()
                            return
                        }
                        if classify(error) == .fail {
                            continuation.finish(throwing: error)
                            return
                        }
                        failure = error
                    }
                    if Task.isCancelled { break }
                    failures += 1
                    if let max = policy.maxAttempts, failures > max {
                        continuation.finish(throwing: failure ?? SSEStreamError.gaveUp)
                        return
                    }
                    let delay = policy.delay(attempt: failures, serverRetry: serverRetry)
                    continuation.yield(.reconnecting(attempt: connections, delay: delay))
                    do { try await sleep(delay) } catch { break }
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

public enum SSEStreamError: Error, Sendable, Equatable {
    /// `maxAttempts` consecutive clean closes without an event.
    case gaveUp
}
