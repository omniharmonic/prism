import OmniCore
import PrismAuth
import SwiftUI
#if canImport(AuthenticationServices)
import AuthenticationServices
#endif

/// Builds the app's one ``AppModel`` with the real server, Keychain and browser behind it.
@MainActor
public enum OmniAppFactory {
    /// The laptop dev gateway (`apps/server/scripts/omni-dev.sh`). Offered as the default
    /// server in development builds only.
    public static let devGatewayURL = "http://127.0.0.1:8797"

    /// - Parameter developmentBuild: pass `true` from a DEBUG build. It prefills the dev
    ///   gateway, uses the login keychain on macOS (a build without a provisioned
    ///   application identifier cannot use the data-protection keychain), and lets a send
    ///   through on a device with no passcode to check (a simulator).
    public static func liveModel(developmentBuild: Bool) -> AppModel {
        let tokens = OmniLive.tokenStore(developmentBuild: developmentBuild)
        #if os(macOS)
        let flow: any RedirectFlow = LoopbackRedirectFlow.systemBrowser()
        let label = "Omni on \(Host.current().localizedName ?? "this Mac")"
        #else
        let flow: any RedirectFlow = WebAuthenticationSessionFlow(configuration: .omniNative) { presentationAnchor() }
        let label = "Omni on \(UIDevice.current.name)"
        #endif
        // Development builds list their own requests in Settings → Diagnostics.
        let diagnostics: DiagnosticsLog? = developmentBuild ? DiagnosticsLog() : nil
        return AppModel(
            settings: UserDefaultsSettings(),
            probe: LiveServerProbe(),
            deviceLabel: label,
            defaultServerURL: developmentBuild ? devGatewayURL : "",
            confirmation: DeviceOwnerConfirmation(allowWhenUnavailable: developmentBuild),
            diagnostics: diagnostics,
            makeEnvironment: OmniLive.environmentFactory(tokenStore: tokens, flow: flow, diagnostics: diagnostics)
        )
    }

    #if os(iOS)
    private static func presentationAnchor() -> ASPresentationAnchor {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        if let window = scenes.flatMap(\.windows).first(where: \.isKeyWindow) ?? scenes.first?.windows.first { return window }
        guard let scene = scenes.first else { preconditionFailure("sign-in was started without a window on screen") }
        return ASPresentationAnchor(windowScene: scene)
    }
    #endif
}

/// How a screen asks the window to go somewhere (a thread from Today, the queue from a badge).
struct Navigator {
    var open: @MainActor (Destination) -> Void = { _ in }
}

extension EnvironmentValues {
    @Entry var navigator = Navigator()
}
