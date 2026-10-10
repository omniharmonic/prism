import Observation

/// Retained by a voice panel's SwiftUI State. Reconcile its owner after mounting
/// and navigation: State initial values alone cannot adopt a later session handoff.
@MainActor @Observable public final class VoiceControlBinding {
    public private(set) var audio: any ConversationAudio
    public private(set) var voice: VoiceConversation
    public init(audio: any ConversationAudio, voice: VoiceConversation) {
        self.audio = audio; self.voice = voice
    }
    @discardableResult public func reconcile(session: SessionModel, threadID: String?) -> Bool {
        guard let shared = session.conversationVoice, let audio = session.conversationAudio,
              session.ownsVoice(shared, threadID: threadID) else { return false }
        guard voice !== shared || self.audio !== audio else { return false }
        // Adoption does not start, stop or cancel either controller. End stays End.
        self.audio = audio; voice = shared
        return true
    }
    public func consume(session: SessionModel, model: ThreadModel) {
        // A stale panel must never drain a receipt intended for the current owner.
        guard session.ownsVoice(voice, threadID: model.threadID) else { return }
        if model.completedVoiceTurnID != nil {
            voice.agentDidComplete(model.takeCompletedVoiceTimeline())
        }
        if voice.state == .answering || voice.state == .speaking {
            voice.consume(model.timeline, running: model.isRunning)
        }
    }
}
