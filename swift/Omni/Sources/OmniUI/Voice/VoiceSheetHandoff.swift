import OmniCore

/// iPhone navigation keeps a newly created voice thread in its existing sheet.
/// The underlying navigation stack opens it only after that sheet closes, so
/// two visible transitions and two mounted voice owners cannot overlap.
@MainActor struct VoiceSheetHandoff {
    private(set) var threadID: String?
    /// Resolve content in the same render that observes thread creation. Waiting
    /// for onChange to store the ID would render the old new-thread panel empty.
    func contentThreadID(session: SessionModel, destination: Destination?, isPresented: Bool) -> String? {
        if let threadID { return threadID }
        guard isPresented, case .thread(let id) = destination,
              session.voiceThreadID == id, session.conversationVoice?.isSessionActive == true else { return nil }
        return id
    }
    mutating func retain(session: SessionModel, destination: Destination?, isPresented: Bool) -> Bool {
        guard isPresented, case .thread(let id) = destination,
              session.voiceThreadID == id, session.conversationVoice?.isSessionActive == true,
              threadID == nil || threadID == id else { return false }
        threadID = id
        return true
    }
    mutating func reset() { threadID = nil }
    mutating func dismissed(destination: Destination?) -> Destination? {
        defer { reset() }
        guard let threadID, destination == .thread(threadID) else { return nil }
        return destination
    }
}
