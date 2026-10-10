/// Return is a send command. Only Shift-Return inserts a line; pasted multiline text and
/// input-method composition retain their native editing behavior.
enum ComposerReturnBehavior {
    enum Action: Equatable { case send, consume, insert }
    static func action(replacement: String, shift: Bool, composing: Bool, canSend: Bool) -> Action {
        guard replacement == "\n", !shift, !composing else { return .insert }
        return canSend ? .send : .consume
    }
}
