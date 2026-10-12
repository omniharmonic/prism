#if os(macOS)
import AVFoundation
import Foundation

/// A hardware route belongs to one recognition cycle. Retired engines and their
/// queued configuration notifications must not affect a replacement cycle.
@MainActor final class WakeAudioEngineCycle {
    private let makeEngine: () -> AVAudioEngine
    private(set) var engine: AVAudioEngine?
    private(set) var token: UUID?
    init(makeEngine: @escaping () -> AVAudioEngine = { AVAudioEngine() }) { self.makeEngine = makeEngine }
    func begin() -> (AVAudioEngine, UUID) {
        precondition(engine == nil)
        let fresh = makeEngine(), token = UUID()
        engine = fresh; self.token = token
        return (fresh, token)
    }
    func accepts(_ token: UUID) -> Bool { engine != nil && self.token == token }
    func retire() -> AVAudioEngine? {
        defer { engine = nil; token = nil }
        return engine
    }
}
#endif
