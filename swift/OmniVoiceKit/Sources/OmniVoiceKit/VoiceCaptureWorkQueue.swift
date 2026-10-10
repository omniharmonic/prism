import Foundation

/// Owns every task in a serial chunk transcription chain. A non-cooperative old
/// engine completion cannot debit the pending count of a later capture session.
@MainActor public final class VoiceCaptureWorkQueue {
    public private(set) var pendingCount = 0
    private var generation = 0
    private var tasks: [UUID: Task<Void, Never>] = [:]
    private var tail: Task<Void, Never>?
    public init() {}
    @discardableResult public func enqueue(_ work: @escaping @MainActor () async -> Void) -> Task<Void, Never> {
        let request = generation; let id = UUID(); let previous = tail
        pendingCount += 1
        let task = Task { [weak self] in
            await previous?.value
            guard let self, self.generation == request, !Task.isCancelled else { return }
            defer {
                if self.generation == request { self.pendingCount -= 1; self.tasks.removeValue(forKey: id) }
            }
            await work()
        }
        tasks[id] = task; tail = task
        return task
    }
    public func drain() async { await tail?.value }
    public func cancel() {
        generation += 1
        tasks.values.forEach { $0.cancel() }; tasks = [:]; tail = nil; pendingCount = 0
    }
}
