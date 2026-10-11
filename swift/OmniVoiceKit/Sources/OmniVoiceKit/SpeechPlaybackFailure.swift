import Foundation

/// Fixed categories only; never carries decoder details or audio contents.
public enum SpeechPlaybackFailure: Error, Sendable, Equatable {
    case routeLost, engineInactive, engineInactiveAfterReconnect, engineInactiveWhileQueued, captureMissing, monitorNotReady, bufferBudget
}
