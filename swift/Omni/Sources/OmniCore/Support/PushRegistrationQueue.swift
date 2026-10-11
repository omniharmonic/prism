import Foundation

/// Orders device registration writes, including APNs callbacks and explicit Settings saves.
/// A failed request releases the queue so a subsequent preference save can still succeed.
@MainActor
public final class PushRegistrationQueue {
    private var tail: Task<Void, Never>?
    public init() {}

    public func run(_ operation: @escaping @MainActor @Sendable () async throws -> Bool) async throws -> Bool {
        let previous = tail
        let request = Task { @MainActor in
            await previous?.value
            return try await operation()
        }
        tail = Task { @MainActor in _ = try? await request.value }
        return try await request.value
    }
}
