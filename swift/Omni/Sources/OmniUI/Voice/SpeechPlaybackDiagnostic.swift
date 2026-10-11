import Foundation
import OmniCore
import OmniVoiceKit

/// Does not inspect arbitrary error messages, domains, or userInfo.
enum SpeechPlaybackDiagnostic {
    static func event(for error: Error) -> VoiceDiagnosticEvent {
        guard let failure = error as? SpeechPlaybackFailure else { return .playbackOtherFailure }
        switch failure {
        case .routeLost: return .playbackRouteLost
        case .engineInactive: return .playbackEngineInactive
        case .engineInactiveAfterReconnect: return .playbackEngineInactiveAfterReconnect
        case .engineInactiveWhileQueued: return .playbackEngineInactiveWhileQueued
        case .monitorNotReady: return .playbackMonitorNotReady
        case .captureMissing: return .playbackCaptureMissing
        case .bufferBudget: return .playbackBufferBudget
        }
    }
}

/// A successful empty decode read signals EOF; thrown decode errors still fail.
enum EncodedSpeechRead {
    @MainActor static func withTemporaryFile(_ url: URL, decode: () async throws -> Void) async rethrows {
        defer { try? FileManager.default.removeItem(at: url) }
        try await decode()
    }
    static func read(total: inout Int64, maximum: Int64, decode: () throws -> UInt32) throws -> Bool {
        try continueReading(decode(), total: &total, maximum: maximum)
    }
    static func continueReading(_ frameLength: UInt32, total: inout Int64, maximum: Int64) throws -> Bool {
        if frameLength == 0 {
            guard total > 0 else { throw SpeechPlaybackFailure.bufferBudget }
            return false
        }
        guard total <= maximum - Int64(frameLength) else { throw SpeechPlaybackFailure.bufferBudget }
        total += Int64(frameLength)
        return true
    }
}
