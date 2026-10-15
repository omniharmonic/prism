import Foundation

/// What lock-screen notifications may say, as this device remembers it.
///
/// Only an explicit choice in Settings is stored and sent. A device that never chose sends no
/// `preview` at all, so the server's own value applies: the device's stored registration, or
/// Omni's default, `title_preview` (the owner chose informative notifications). Sending
/// "generic" whenever nothing was chosen would reset every device to generic on each launch.
public enum PushPreviewPreference {
    public static let storageKey = "omni.notifications.preview"
    public static let values = ["generic", "title", "title_preview"]
    /// What Settings shows when nothing was chosen: the server's default for Omni.
    public static let defaultValue = "title_preview"

    /// The value to send with a registration: the explicit choice, or nil to leave it out.
    public static func sent(stored: String?) -> String? {
        guard let stored, values.contains(stored) else { return nil }
        return stored
    }

    /// The value Settings shows as selected.
    public static func shown(stored: String?) -> String { sent(stored: stored) ?? defaultValue }
}
