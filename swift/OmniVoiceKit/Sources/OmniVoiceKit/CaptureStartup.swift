import Foundation

/// One bounded retry is allowed only before any input was recorded. Start errors
/// (including denied permission) never retry; stop must freeze capture before
/// deciding whether it was empty. Cancellation never starts another capture.
@MainActor enum CaptureStartup {
    static func run(start: () async throws -> Void,
                    wait: () async throws -> Void,
                    stopAndWasEmpty: () throws -> Bool,
                    beforeRetry: () async throws -> Void) async throws {
        for attempt in 0...1 {
            try Task.checkCancellation()
            try await start()
            do { try await wait(); try Task.checkCancellation(); return }
            catch {
                let empty = try stopAndWasEmpty()
                try Task.checkCancellation()
                let recoverable = (error as? SpeechPlaybackFailure).map { $0 == .engineInactive || $0 == .monitorNotReady } ?? false
                guard attempt == 0, empty, recoverable else { throw error }
                try await beforeRetry()
            }
        }
    }
}
