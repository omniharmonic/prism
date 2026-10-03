// Prism Client — iOS glue (WP5). Called ONLY from the app's Rust code
// (`run_mobile_plugin_async`); the plugin registers no webview-callable command.
//
//   authenticate        ASWebAuthenticationSession (system sign-in sheet, PKCE redirect prism://)
//   confirm             UIAlertController (the native confirmation behind open_external / reset_server)
//   deviceInfo          UIDevice model, for the consent-page label
//   configureLock       Face ID / passcode app lock + privacy cover (LocalAuthentication)
//   biometry            which biometry the device has, for the Settings label
//   pushRegister        notification permission + registerForRemoteNotifications -> hex token
//   pushStatus          notification permission state
//   takeOpenedSession   the agent session of the last tapped notification (ids only)

import AuthenticationServices
import Foundation
import LocalAuthentication
import ObjectiveC
import Tauri
import UIKit
import UserNotifications
import WebKit

struct AuthenticateArgs: Decodable {
  let url: String
  let callbackScheme: String
}

struct ConfirmArgs: Decodable {
  let title: String
  let message: String
  let confirm: String
  let cancelIsDefault: Bool
  let destructive: Bool
}

struct VerifyOwnerArgs: Decodable {
  let reason: String
}

struct ConfigureLockArgs: Decodable {
  let mode: String
  let minutes: Int
  let atLaunch: Bool
}

// MARK: - APNs callbacks
//
// tao's UIApplicationDelegate class ("AppDelegate") does not implement the remote
// notification callbacks, so they are added to it at runtime (before we ever call
// registerForRemoteNotifications). UIKit asks respondsToSelector: at callback time.

final class PushRegistrar {
  static let shared = PushRegistrar()
  private var waiting: [Invoke] = []
  private var installed = false

  func installDelegateMethods() {
    if installed { return }
    installed = true
    guard let delegate = UIApplication.shared.delegate, let cls: AnyClass = object_getClass(delegate) else {
      return
    }
    let okSel = NSSelectorFromString("application:didRegisterForRemoteNotificationsWithDeviceToken:")
    let failSel = NSSelectorFromString("application:didFailToRegisterForRemoteNotificationsWithError:")
    let okBlock: @convention(block) (AnyObject, UIApplication, Data) -> Void = { _, _, token in
      PushRegistrar.shared.finish(token: token, error: nil)
    }
    let failBlock: @convention(block) (AnyObject, UIApplication, NSError) -> Void = { _, _, error in
      PushRegistrar.shared.finish(token: nil, error: error)
    }
    class_addMethod(cls, okSel, imp_implementationWithBlock(okBlock), "v@:@@")
    class_addMethod(cls, failSel, imp_implementationWithBlock(failBlock), "v@:@@")
  }

  func register(_ invoke: Invoke) {
    DispatchQueue.main.async {
      self.installDelegateMethods()
      self.waiting.append(invoke)
      UIApplication.shared.registerForRemoteNotifications()
      // APNs normally answers within a second; never leave the caller hanging.
      DispatchQueue.main.asyncAfter(deadline: .now() + 30) {
        self.finish(token: nil, error: NSError(domain: "Prism", code: 1, userInfo: [NSLocalizedDescriptionKey: "APNs did not answer"]))
      }
    }
  }

  private func finish(token: Data?, error: Error?) {
    DispatchQueue.main.async {
      let pending = self.waiting
      self.waiting = []
      for invoke in pending {
        if let token = token {
          let hex = token.map { String(format: "%02x", $0) }.joined()
          invoke.resolve(["token": hex, "environment": PushRegistrar.apnsEnvironment()])
        } else {
          invoke.reject("Couldn't register for notifications: \(error?.localizedDescription ?? "unknown error")")
        }
      }
    }
  }

  /// The APNs environment this build's token belongs to: the `aps-environment`
  /// entitlement as baked into the embedded provisioning profile (App Store and
  /// TestFlight builds: production). No profile = simulator/dev = sandbox.
  static func apnsEnvironment() -> String {
    guard let path = Bundle.main.path(forResource: "embedded", ofType: "mobileprovision"),
      let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
      let text = String(data: data, encoding: .isoLatin1),
      let start = text.range(of: "<?xml"),
      let end = text.range(of: "</plist>")
    else {
      return "sandbox"
    }
    let xml = String(text[start.lowerBound..<end.upperBound])
    guard let plistData = xml.data(using: .isoLatin1),
      let plist = try? PropertyListSerialization.propertyList(from: plistData, format: nil) as? [String: Any],
      let ents = plist["Entitlements"] as? [String: Any],
      let env = ents["aps-environment"] as? String
    else {
      return "sandbox"
    }
    return env == "production" ? "production" : "sandbox"
  }
}

// MARK: - App lock (Face ID / Touch ID / passcode) + privacy cover

final class AppLock: NSObject {
  static let shared = AppLock()

  enum Mode: String {
    case off, launch, background, always
  }

  private var mode: Mode = .off
  private var minutes: Int = 5
  private var locked = false
  private var authenticating = false
  private var backgroundedAt: Date?
  private var cover: UIView?
  private var statusLabel: UILabel?
  private var observing = false
  /// The Tauri view controller (set by the plugin; PluginManager.shared is internal).
  var viewController: () -> UIViewController? = { nil }

  func configure(mode raw: String, minutes: Int, atLaunch: Bool) {
    DispatchQueue.main.async {
      self.observe()
      self.mode = Mode(rawValue: raw) ?? .off
      self.minutes = max(1, minutes)
      if self.mode == .off {
        // Turning the lock off from Settings (the app is unlocked to get there).
        self.locked = false
        self.hideCover()
        return
      }
      if atLaunch {
        self.locked = true
        self.showCover()
        if UIApplication.shared.applicationState == .active {
          self.authenticate()
        }
      }
    }
  }

  private func observe() {
    if observing { return }
    observing = true
    let nc = NotificationCenter.default
    nc.addObserver(self, selector: #selector(willResignActive), name: UIApplication.willResignActiveNotification, object: nil)
    nc.addObserver(self, selector: #selector(didEnterBackground), name: UIApplication.didEnterBackgroundNotification, object: nil)
    nc.addObserver(self, selector: #selector(didBecomeActive), name: UIApplication.didBecomeActiveNotification, object: nil)
  }

  /// The app switcher snapshot is taken after this: cover the content.
  @objc private func willResignActive() {
    if mode != .off && !authenticating { showCover() }
  }

  @objc private func didEnterBackground() {
    if mode == .off { return }
    if backgroundedAt == nil { backgroundedAt = Date() }
    showCover()
  }

  @objc private func didBecomeActive() {
    if authenticating { return } // the Face ID sheet itself resigns/re-activates the app
    if mode == .off {
      hideCover()
      return
    }
    if !locked {
      switch mode {
      case .always:
        locked = backgroundedAt != nil
      case .background:
        if let at = backgroundedAt {
          locked = Date().timeIntervalSince(at) >= Double(minutes * 60)
        }
      case .launch, .off:
        break
      }
    }
    backgroundedAt = nil
    if locked {
      showCover()
      authenticate()
    } else {
      hideCover()
    }
  }

  private func authenticate() {
    if authenticating { return }
    let context = LAContext()
    context.localizedFallbackTitle = "Use Passcode"
    var error: NSError?
    guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
      // No passcode on the device: there is nothing to authenticate against, and
      // locking would shut the owner out of their own data. Fail open, say so.
      locked = false
      hideCover()
      NSLog("[prism] app lock: device has no passcode; lock not enforced")
      return
    }
    authenticating = true
    statusLabel?.text = "Unlocking…"
    context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Unlock Prism") { ok, _ in
      DispatchQueue.main.async {
        self.authenticating = false
        if ok {
          self.locked = false
          self.hideCover()
        } else {
          self.statusLabel?.text = "Prism is locked"
        }
      }
    }
  }

  /// Run a Face ID prompt that is not the unlock itself (the lifecycle events it
  /// causes must not re-lock or flash the cover).
  func suspendFor(_ body: @escaping (_ done: @escaping () -> Void) -> Void) {
    DispatchQueue.main.async {
      self.authenticating = true
      body {
        self.authenticating = false
      }
    }
  }

  @objc private func unlockTapped() {
    authenticate()
  }

  private func hostView() -> UIView? {
    if let window = viewController()?.view.window { return window }
    return viewController()?.view
  }

  private func showCover() {
    guard let host = hostView() else { return }
    if let cover = cover {
      host.bringSubviewToFront(cover)
      return
    }
    let v = UIView(frame: host.bounds)
    v.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    v.backgroundColor = UIColor(red: 0.039, green: 0.039, blue: 0.043, alpha: 1)
    v.accessibilityViewIsModal = true

    let title = UILabel()
    title.text = "Prism"
    title.font = .systemFont(ofSize: 28, weight: .semibold)
    title.textColor = .white
    let status = UILabel()
    status.text = locked ? "Prism is locked" : ""
    status.font = .systemFont(ofSize: 15)
    status.textColor = UIColor(white: 1, alpha: 0.6)
    let button = UIButton(type: .system)
    button.setTitle("Unlock", for: .normal)
    button.titleLabel?.font = .systemFont(ofSize: 17, weight: .semibold)
    button.addTarget(self, action: #selector(unlockTapped), for: .touchUpInside)

    let stack = UIStackView(arrangedSubviews: [title, status, button])
    stack.axis = .vertical
    stack.alignment = .center
    stack.spacing = 12
    stack.translatesAutoresizingMaskIntoConstraints = false
    v.addSubview(stack)
    NSLayoutConstraint.activate([
      stack.centerXAnchor.constraint(equalTo: v.centerXAnchor),
      stack.centerYAnchor.constraint(equalTo: v.centerYAnchor),
    ])
    host.addSubview(v)
    cover = v
    statusLabel = status
  }

  private func hideCover() {
    cover?.removeFromSuperview()
    cover = nil
    statusLabel = nil
  }
}

// MARK: - The plugin

class PrismIosPlugin: Plugin, ASWebAuthenticationPresentationContextProviding, UNUserNotificationCenterDelegate {
  private var authSession: ASWebAuthenticationSession?
  private weak var webview: WKWebView?
  private var openedSessionId: String?
  private static let sessionIdPattern = try! NSRegularExpression(pattern: "^[A-Za-z0-9_-]{8,64}$")

  override init() {
    super.init()
    // Must be set before launch finishes so a tap that cold-starts the app is delivered.
    UNUserNotificationCenter.current().delegate = self
    PushRegistrar.shared.installDelegateMethods()
    let manager = self.manager
    AppLock.shared.viewController = { manager.viewController }
  }

  override func load(webview: WKWebView) {
    self.webview = webview
    // The web UI owns safe areas (viewport-fit=cover + env(safe-area-inset-*)),
    // so the scroll view must not add its own insets on top.
    webview.scrollView.contentInsetAdjustmentBehavior = .never
    // No rubber-band bounce of the whole app shell (it fights fixed headers and
    // the composer); inner scroll containers still scroll normally.
    webview.scrollView.bounces = false
    // The app routes with the History API; an edge swipe must not navigate the
    // webview itself back past the app.
    webview.allowsBackForwardNavigationGestures = false
    webview.allowsLinkPreview = false
  }

  // MARK: sign-in

  @objc public func authenticate(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(AuthenticateArgs.self)
    guard let url = URL(string: args.url), url.scheme == "https" || url.scheme == "http" else {
      invoke.reject("invalid sign-in URL")
      return
    }
    DispatchQueue.main.async {
      self.authSession?.cancel()
      let session = ASWebAuthenticationSession(url: url, callbackURLScheme: args.callbackScheme) {
        [weak self] callback, error in
        self?.authSession = nil
        if let callback = callback {
          invoke.resolve(["url": callback.absoluteString])
        } else if let err = error as? ASWebAuthenticationSessionError, err.code == .canceledLogin {
          invoke.reject("Sign-in cancelled")
        } else {
          invoke.reject("Sign-in failed: \(error?.localizedDescription ?? "unknown error")")
        }
      }
      session.presentationContextProvider = self
      // Share Safari's cookies: a user already signed in to the server in Safari
      // only has to approve. (Password login also works inside the sheet.)
      session.prefersEphemeralWebBrowserSession = false
      self.authSession = session
      if !session.start() {
        self.authSession = nil
        invoke.reject("Couldn't open the sign-in sheet")
      }
    }
  }

  func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
    if let w = manager.viewController?.view.window { return w }
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    return scenes.flatMap { $0.windows }.first { $0.isKeyWindow } ?? ASPresentationAnchor()
  }

  // MARK: native confirmation

  @objc public func confirm(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ConfirmArgs.self)
    DispatchQueue.main.async {
      guard var top = self.manager.viewController else {
        invoke.resolve(["confirmed": false])
        return
      }
      while let presented = top.presentedViewController { top = presented }
      let alert = UIAlertController(title: args.title, message: args.message, preferredStyle: .alert)
      let cancel = UIAlertAction(title: "Cancel", style: .cancel) { _ in invoke.resolve(["confirmed": false]) }
      let ok = UIAlertAction(title: args.confirm, style: args.destructive ? .destructive : .default) { _ in
        invoke.resolve(["confirmed": true])
      }
      alert.addAction(cancel)
      alert.addAction(ok)
      alert.preferredAction = args.cancelIsDefault ? cancel : ok
      top.present(alert, animated: true)
    }
  }

  @objc public func deviceInfo(_ invoke: Invoke) {
    DispatchQueue.main.async {
      invoke.resolve(["model": UIDevice.current.model])
    }
  }

  // MARK: app lock

  @objc public func configureLock(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ConfigureLockArgs.self)
    AppLock.shared.configure(mode: args.mode, minutes: args.minutes, atLaunch: args.atLaunch)
    invoke.resolve(["ok": true])
  }

  /// Re-authenticate before a lock setting changes (so page script can't switch it off).
  @objc public func verifyOwner(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(VerifyOwnerArgs.self)
    let context = LAContext()
    guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: nil) else {
      // No passcode: the lock was never enforceable, so there is nothing to protect.
      invoke.resolve(["confirmed": true])
      return
    }
    AppLock.shared.suspendFor { done in
      context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: args.reason) { ok, _ in
        DispatchQueue.main.async {
          done()
          invoke.resolve(["confirmed": ok])
        }
      }
    }
  }

  @objc public func biometry(_ invoke: Invoke) {
    let context = LAContext()
    var err: NSError?
    let hasBio = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &err)
    var kind = "none"
    if hasBio || context.biometryType != .none {
      switch context.biometryType {
      case .faceID: kind = "faceID"
      case .touchID: kind = "touchID"
      default:
        if #available(iOS 17.0, *), context.biometryType == .opticID { kind = "opticID" }
      }
    }
    let passcode = LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: nil)
    invoke.resolve(["kind": kind, "passcodeSet": passcode])
  }

  // MARK: push

  @objc public func pushStatus(_ invoke: Invoke) {
    UNUserNotificationCenter.current().getNotificationSettings { settings in
      invoke.resolve(["permission": PrismIosPlugin.permissionName(settings.authorizationStatus)])
    }
  }

  @objc public func pushRegister(_ invoke: Invoke) {
    let center = UNUserNotificationCenter.current()
    center.getNotificationSettings { settings in
      if settings.authorizationStatus == .denied {
        invoke.reject("Notifications are turned off for Prism. Turn them on in the iOS Settings app.")
        return
      }
      center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
        if !granted {
          invoke.reject("Notifications weren't allowed.")
          return
        }
        PushRegistrar.shared.register(invoke)
      }
    }
  }

  @objc public func takeOpenedSession(_ invoke: Invoke) {
    DispatchQueue.main.async {
      let id = self.openedSessionId
      self.openedSessionId = nil
      if let id = id {
        invoke.resolve(["sessionId": id])
      } else {
        invoke.resolve(["sessionId": NSNull()])
      }
    }
  }

  static func permissionName(_ s: UNAuthorizationStatus) -> String {
    switch s {
    case .notDetermined: return "notDetermined"
    case .denied: return "denied"
    case .authorized: return "authorized"
    case .provisional: return "provisional"
    case .ephemeral: return "ephemeral"
    @unknown default: return "denied"
    }
  }

  // A notification arrives while the app is open: still show it (the test
  // notification would otherwise look like it never came).
  func userNotificationCenter(
    _ center: UNUserNotificationCenter, willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    if #available(iOS 14.0, *) {
      completionHandler([.banner, .list, .sound])
    } else {
      completionHandler([.alert, .sound])
    }
  }

  // Tap: remember the agent session (ids only, validated) and tell the page to
  // ask for it. The page pulls it through takeOpenedSession, so the id always
  // takes the same validated path, warm start or cold.
  func userNotificationCenter(
    _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    let info = response.notification.request.content.userInfo
    var id: String? = info["sessionId"] as? String
    if id == nil, let url = info["url"] as? String, url.hasPrefix("/agent/") {
      id = String(url.dropFirst("/agent/".count))
    }
    DispatchQueue.main.async {
      if let id = id, PrismIosPlugin.validSessionId(id) {
        self.openedSessionId = id
        self.webview?.evaluateJavaScript(
          "window.dispatchEvent(new CustomEvent('prism:native-push-opened'))", completionHandler: nil)
      }
      completionHandler()
    }
  }

  static func validSessionId(_ s: String) -> Bool {
    let range = NSRange(s.startIndex..., in: s)
    return sessionIdPattern.firstMatch(in: s, range: range) != nil
  }
}

@_cdecl("init_plugin_prism_ios")
func initPlugin() -> Plugin {
  return PrismIosPlugin()
}
