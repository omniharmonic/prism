import Foundation

/// Serial narration work is cancelled independently of microphone capture. An
/// acoustic interruption may promote the current microphone buffer into a turn.
@MainActor public final class ReplyNarrationWork {
    private var epoch = 0
    private var tasks: [UUID: Task<Void, Never>] = [:]
    private var tail: Task<Void, Never>?
    public var isBusy: Bool { !tasks.isEmpty }
    public init() {}
    public func enqueue(_ work: @escaping @MainActor (@escaping @MainActor () -> Bool) async -> Void) {
        let request = epoch; let id = UUID(); let previous = tail
        let task = Task { [weak self] in
            await previous?.value
            guard let self, self.epoch == request, !Task.isCancelled else { return }
            defer { self.tasks.removeValue(forKey: id) }
            await work { self.epoch == request && !Task.isCancelled }
        }
        tasks[id] = task; tail = task
    }
    public func cancel() {
        epoch += 1; tasks.values.forEach { $0.cancel() }; tasks = [:]; tail = nil
    }
    public func wait() async { await tail?.value }
}
