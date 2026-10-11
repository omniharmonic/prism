import Foundation

/// Startup readiness belongs to one capture, never to a reusable engine.
@MainActor final class AudioCaptureReadiness {
    private var ready = false
    private var invalidated = false
    func receivedFirstTap() { if !invalidated { ready = true } }
    func invalidate() { invalidated = true }
    func wait(timeout: Duration, isRunning: () -> Bool) async throws {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: timeout)
        while true {
            try Task.checkCancellation()
            guard !invalidated else { throw SpeechPlaybackFailure.captureMissing }
            guard isRunning() else { throw SpeechPlaybackFailure.engineInactive }
            if ready { return }
            guard clock.now < deadline else { throw SpeechPlaybackFailure.monitorNotReady }
            try await Task.sleep(for: .milliseconds(20))
        }
    }
}
