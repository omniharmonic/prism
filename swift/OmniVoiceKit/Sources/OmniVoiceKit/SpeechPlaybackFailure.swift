import Foundation

/// Fixed categories only; never carries decoder details or audio contents.
public enum SpeechPlaybackFailure: Error, Sendable {
    case routeLost, engineInactive, captureMissing, bufferBudget
}
