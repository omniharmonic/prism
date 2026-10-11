@preconcurrency import AVFoundation
import Foundation

/// Reservations remain charged until hardware reports dataPlayedBack. The bridge
/// cannot move an unbounded synthesized reply into AVAudioPlayerNode's queue.
@MainActor public final class SpeechPlaybackQueue {
    private struct Cost { let seconds: Double; let bytes: Int }
    private struct Waiter { let id: UUID; let cost: Cost; let continuation: CheckedContinuation<Void, Error> }
    private var reservations: [UUID: Cost] = [:]
    private var waiters: [Waiter] = []
    public private(set) var inFlightSeconds = 0.0
    public private(set) var inFlightBytes = 0
    public let maximumSeconds: Double
    public let maximumBytes: Int
    public init(maximumSeconds: Double = 2, maximumBytes: Int = 4 * 1024 * 1024) {
        self.maximumSeconds = maximumSeconds; self.maximumBytes = maximumBytes
    }
    public func schedule(_ buffer: AVAudioPCMBuffer,
                         play: @MainActor (AVAudioPCMBuffer, @escaping @Sendable () -> Void) throws -> Void) async throws {
        let bytes = UnsafeMutableAudioBufferListPointer(buffer.mutableAudioBufferList).reduce(0) { $0 + Int($1.mDataByteSize) }
        let cost = Cost(seconds: Double(buffer.frameLength) / buffer.format.sampleRate, bytes: bytes)
        guard cost.seconds.isFinite, cost.seconds > 0, cost.seconds <= maximumSeconds, bytes <= maximumBytes else {
            throw SpeechPlaybackFailure.bufferBudget
        }
        let id = UUID()
        try await withTaskCancellationHandler {
            try Task.checkCancellation()
            try await acquire(id: id, cost: cost)
            do {
                try Task.checkCancellation()
                try play(buffer) { [weak self] in Task { @MainActor in self?.release(id) } }
            } catch { release(id); throw error }
        } onCancel: {
            Task { @MainActor [weak self] in self?.cancelWaiter(id) }
        }
    }
    private func fits(_ cost: Cost) -> Bool {
        inFlightSeconds + cost.seconds <= maximumSeconds + 0.000_001 && inFlightBytes + cost.bytes <= maximumBytes
    }
    private func reserve(_ id: UUID, _ cost: Cost) {
        reservations[id] = cost; inFlightSeconds += cost.seconds; inFlightBytes += cost.bytes
    }
    private func acquire(id: UUID, cost: Cost) async throws {
        if waiters.isEmpty, fits(cost) { reserve(id, cost); return }
        try await withCheckedThrowingContinuation { continuation in
            waiters.append(Waiter(id: id, cost: cost, continuation: continuation))
        }
    }
    private func release(_ id: UUID) {
        if let cost = reservations.removeValue(forKey: id) {
            inFlightSeconds = max(0, inFlightSeconds - cost.seconds); inFlightBytes = max(0, inFlightBytes - cost.bytes)
        }
        drain()
    }
    private func drain() {
        while let first = waiters.first, fits(first.cost) {
            waiters.removeFirst(); reserve(first.id, first.cost); first.continuation.resume()
        }
    }
    private func cancelWaiter(_ id: UUID) {
        if let index = waiters.firstIndex(where: { $0.id == id }) {
            waiters.remove(at: index).continuation.resume(throwing: CancellationError())
        }
        release(id)
    }
    public func cancel() {
        let pending = waiters; waiters = []
        reservations = [:]; inFlightSeconds = 0; inFlightBytes = 0
        pending.forEach { $0.continuation.resume(throwing: CancellationError()) }
    }
}
