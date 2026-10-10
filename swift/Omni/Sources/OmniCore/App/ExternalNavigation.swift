import Foundation

/// Holds a tap until authentication, privacy unlock and the destination view are ready.
public struct ExternalNavigationQueue: Sendable {
    private var pending: Destination?
    public init() {}
    @discardableResult public mutating func receive(_ url: URL) -> Bool {
        guard url.scheme?.lowercased() == "omni", url.user == nil, url.password == nil,
              url.port == nil, url.query == nil, url.fragment == nil,
              let host = url.host, ["thread", "approval", "nudge"].contains(host),
              url.pathComponents.count == 2 else { return false }
        let id = url.pathComponents[1]
        guard !id.isEmpty, id.utf8.count <= 256,
              id.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil else { return false }
        pending = host == "thread" ? .thread(id) : .needsYou
        return true
    }
    public mutating func take(signedIn: Bool, unlocked: Bool, navigationReady: Bool) -> Destination? {
        guard signedIn, unlocked, navigationReady else { return nil }
        defer { pending = nil }
        return pending
    }
}

/// Native Prism supports exactly prism://page/<id>; a web URL remains the fallback.
public struct PrismSourceLink: Equatable, Sendable {
    public let native: URL?
    public let web: URL
    public init?(web text: String?, noteID: String?) {
        guard let text, let url = URL(string: text), ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
              url.host != nil, url.user == nil, url.password == nil else { return nil }
        web = url
        if let noteID, noteID.utf8.count <= 128,
           url.query == nil, url.fragment == nil, url.pathComponents.count == 3,
           ["page", "collab"].contains(url.pathComponents[1]), url.pathComponents[2] == noteID,
           noteID.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil {
            native = URL(string: "prism://page/\(noteID)")
        } else { native = nil }
    }
}
