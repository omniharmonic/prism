import SwiftUI
import OmniCore

/// Opens a Prism source: in the Prism app when it takes `prism://source/…`, else in the browser.
///
/// `OpenURLAction`'s completion is called by LaunchServices on its own queue. A closure written in a
/// view's `body` is main-actor isolated, and Swift 6 traps when such a closure runs off the main
/// actor (crash report 2026-10-15, `RecordCardView`). So the completion here is `@Sendable` and only
/// hops back to the main actor for the fallback.
enum SourceLinkOpener {
    typealias Attempt = (URL, @escaping @Sendable (Bool) -> Void) -> Void

    @MainActor
    static func open(_ link: PrismSourceLink, attempt: Attempt, fallback: @escaping @MainActor @Sendable (URL) -> Void) {
        guard let native = link.native else { fallback(link.web); return }
        let web = link.web
        attempt(native) { @Sendable accepted in
            guard !accepted else { return }
            Task { @MainActor in fallback(web) }
        }
    }

    @MainActor
    static func open(_ link: PrismSourceLink, with openURL: OpenURLAction) {
        open(link, attempt: { url, done in openURL(url, completion: done) }, fallback: { openURL($0) })
    }
}
