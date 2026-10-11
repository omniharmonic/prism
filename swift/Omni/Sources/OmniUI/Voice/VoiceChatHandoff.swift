import OmniCore

/// One main-chat navigation entry spans voice composition and thread creation.
/// Resolve the thread in the creation render, before destination observers run.
@MainActor struct VoiceChatHandoff {
    private(set) var isPresented = false
    private(set) var threadID: String?
    mutating func begin() { isPresented = true; threadID = nil }
    mutating func reset() { isPresented = false; threadID = nil }
    func contentThreadID(session: SessionModel) -> String? {
        guard isPresented else { return nil }
        if let threadID { return session.destination == .thread(threadID) ? threadID : nil }
        guard case .thread(let id) = session.destination,
              session.voiceThreadID == id, session.conversationVoice?.isSessionActive == true else { return nil }
        return id
    }
    mutating func adopt(session: SessionModel) -> Bool {
        guard let id = contentThreadID(session: session), session.destination == .thread(id) else { return false }
        threadID = id
        return true
    }
    /// The path remains .newThread while the authoritative destination is its thread.
    func destination(for top: Destination?, session: SessionModel) -> Destination? {
        if top == .newThread, let id = contentThreadID(session: session) { return .thread(id) }
        return top
    }
}
