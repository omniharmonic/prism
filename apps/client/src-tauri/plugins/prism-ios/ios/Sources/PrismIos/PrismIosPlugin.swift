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
//   takeOpenedSession   what the last tapped notification names: an agent session or an inbox
//                       item (ids only); nothing while the app is locked
//   waitUnlocked        resolves once nothing is behind the lock cover (incoming links wait on it)
//   shareFile           UIActivityViewController for ONE exported file in the app's tmp folder
//
// While the app is LOCKED, nothing here presents UI or hands anything out:
// authenticate / confirm / verifyOwner refuse, and the lock cover is its own
// window above every other window (sheets included).

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

struct ShareFileArgs: Decodable {
  let path: String
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
  /// Each caller waits on its own entry, with its own timeout.
  private var waiting: [UUID: Invoke] = [:]
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
      PushRegistrar.shared.finishAll(token: token, error: nil)
    }
    let failBlock: @convention(block) (AnyObject, UIApplication, NSError) -> Void = { _, _, error in
      PushRegistrar.shared.finishAll(token: nil, error: error)
    }
    class_addMethod(cls, okSel, imp_implementationWithBlock(okBlock), "v@:@@")
    class_addMethod(cls, failSel, imp_implementationWithBlock(failBlock), "v@:@@")
  }

  func register(_ invoke: Invoke) {
    DispatchQueue.main.async {
      self.installDelegateMethods()
      let id = UUID()
      self.waiting[id] = invoke
      UIApplication.shared.registerForRemoteNotifications()
      // APNs normally answers within a second; never leave THIS caller hanging.
      DispatchQueue.main.asyncAfter(deadline: .now() + 30) {
        if let late = self.waiting.removeValue(forKey: id) {
          late.reject("Couldn't register for notifications: APNs did not answer")
        }
      }
    }
  }

  private func finishAll(token: Data?, error: Error?) {
    DispatchQueue.main.async {
      let pending = self.waiting
      self.waiting = [:]
      for (_, invoke) in pending {
        if let token = token {
          let hex = token.map { String(format: "%02x", $0) }.joined()
          // The APNs environment is decided in Rust (mobile_cmds::apns_environment)
          // from these two facts, so the rule is unit-tested there.
          var result: JsonObject = ["token": hex, "simulator": PushRegistrar.isSimulator]
          if let env = PushRegistrar.profileApsEnvironment() { result["profileEnvironment"] = env }
          invoke.resolve(result)
        } else {
          invoke.reject("Couldn't register for notifications: \(error?.localizedDescription ?? "unknown error")")
        }
      }
    }
  }

  static var isSimulator: Bool {
    #if targetEnvironment(simulator)
      return true
    #else
      return false
    #endif
  }

  /// `aps-environment` of the embedded provisioning profile, or nil when there is
  /// none. App Store and TestFlight installs have NO embedded profile (Apple strips
  /// it), so nil must mean production (decided in Rust).
  static func profileApsEnvironment() -> String? {
    guard let path = Bundle.main.path(forResource: "embedded", ofType: "mobileprovision"),
      let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
      let text = String(data: data, encoding: .isoLatin1),
      let start = text.range(of: "<?xml"),
      let end = text.range(of: "</plist>")
    else {
      return nil
    }
    let xml = String(text[start.lowerBound..<end.upperBound])
    guard let plistData = xml.data(using: .isoLatin1),
      let plist = try? PropertyListSerialization.propertyList(from: plistData, format: nil) as? [String: Any],
      let ents = plist["Entitlements"] as? [String: Any],
      let env = ents["aps-environment"] as? String
    else {
      return nil
    }
    return env
  }
}

// MARK: - App lock (Face ID / Touch ID / passcode) + privacy cover

final class AppLock: NSObject {
  static let shared = AppLock()

  private var mode: LockMode = .off
  private var minutes: Int = 5
  private var locked = false
  private var authenticating = false
  /// `continuousSeconds()` when the app entered the background (monotonic, counts sleep).
  private var backgroundedAt: Double?
  private var coverWindow: UIWindow?
  private var statusLabel: UILabel?
  private var observing = false
  /// The Tauri view controller (set by the plugin; PluginManager.shared is internal).
  var viewController: () -> UIViewController? = { nil }
  /// Called when the app locks: drop anything the plugin has on screen.
  var onLock: () -> Void = {}
  /// Callers waiting for "nothing is behind the lock cover" (incoming links).
  private var unlockWaiters: [(Bool) -> Void] = []
  private static let maxUnlockWaiters = 16

  /// True while the app is locked (the plugin refuses UI and secrets then).
  var isLocked: Bool { locked }

  func configure(mode raw: String, minutes: Int, atLaunch: Bool) {
    DispatchQueue.main.async {
      self.observe()
      self.mode = LockMode(rawValue: raw) ?? .off
      self.minutes = max(1, minutes)
      if self.mode == .off {
        // Turning the lock off from Settings (the app is unlocked to get there).
        self.setLocked(false)
        self.hideCover()
        self.flushUnlockWaiters()
        return
      }
      if atLaunch {
        self.setLocked(true)
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
    if backgroundedAt == nil { backgroundedAt = continuousSeconds() }
    showCover()
  }

  @objc private func didBecomeActive() {
    if authenticating { return } // the Face ID sheet itself resigns/re-activates the app
    if mode == .off {
      hideCover()
      return
    }
    if !locked
      && LockPolicy.shouldLock(mode: mode, minutes: minutes, backgroundedAt: backgroundedAt, now: continuousSeconds())
    {
      setLocked(true)
    }
    backgroundedAt = nil
    if locked {
      showCover()
      authenticate()
    } else {
      hideCover()
    }
    flushUnlockWaiters()
  }

  /// Run `body(true)` once nothing is, or is about to be, behind the lock cover
  /// (`LockPolicy.mayDeliverLink`): at once when no lock is on or the app is
  /// unlocked and active, otherwise after the unlock. Too many waiters: the
  /// oldest is answered `false` (its caller keeps what it wanted to deliver).
  func whenUnlocked(_ body: @escaping (Bool) -> Void) {
    DispatchQueue.main.async {
      self.observe()
      if self.unlockWaiters.count >= AppLock.maxUnlockWaiters {
        self.unlockWaiters.removeFirst()(false)
      }
      self.unlockWaiters.append(body)
      self.flushUnlockWaiters()
    }
  }

  private func flushUnlockWaiters() {
    if unlockWaiters.isEmpty { return }
    let active = UIApplication.shared.applicationState == .active
    guard LockPolicy.mayDeliverLink(mode: mode, locked: locked, active: active, backgroundedAt: backgroundedAt)
    else { return }
    let ready = unlockWaiters
    unlockWaiters = []
    for body in ready { body(true) }
  }

  /// Locking disables the webview and drops its focus (no keyboard, no typing
  /// into the page behind the cover), and closes whatever the plugin presented.
  private func setLocked(_ value: Bool) {
    locked = value
    if !value { flushUnlockWaiters() }
    guard let main = viewController() else { return }
    main.view.isUserInteractionEnabled = !value
    if value {
      main.view.window?.endEditing(true)
      main.view.endEditing(true)
      onLock()
      if main.presentedViewController != nil { main.dismiss(animated: false) }
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
      setLocked(false)
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
          self.setLocked(false)
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
        self.flushUnlockWaiters()
      }
    }
  }

  @objc private func unlockTapped() {
    authenticate()
  }

  /// The cover is its own window ABOVE every other window of the scene (alert
  /// level + 1), so nothing the app presents (alerts, the sign-in sheet) can
  /// show on top of it. Only system UI (the Face ID / passcode prompt) does.
  private func showCover() {
    if let w = coverWindow {
      w.isHidden = false
      return
    }
    guard let scene = viewController()?.view.window?.windowScene
      ?? UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first
    else { return }
    let w = UIWindow(windowScene: scene)
    w.windowLevel = .alert + 1
    let vc = UIViewController()
    let v = vc.view!
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
    w.rootViewController = vc
    w.isHidden = false
    coverWindow = w
    statusLabel = status
  }

  private func hideCover() {
    coverWindow?.isHidden = true
    coverWindow = nil
    statusLabel = nil
  }
}

// MARK: - The plugin

class PrismIosPlugin: Plugin, ASWebAuthenticationPresentationContextProviding, UNUserNotificationCenterDelegate {
  private var authSession: ASWebAuthenticationSession?
  private weak var webview: WKWebView?
  private var openedSessionId: String?
  private var openedNotificationId: String?
  /// Answers the share sheet that is up (false = not shared); nil when none is.
  private var pendingShare: ((Bool) -> Void)?
  private static let sessionIdPattern = try! NSRegularExpression(pattern: "^[A-Za-z0-9_-]{8,64}$")
  private static let notificationIdPattern = try! NSRegularExpression(pattern: "^[A-Za-z0-9_-]{1,64}$")
  private static let lockedMessage = "Prism is locked."

  override init() {
    super.init()
    // Must be set before launch finishes so a tap that cold-starts the app is delivered.
    UNUserNotificationCenter.current().delegate = self
    PushRegistrar.shared.installDelegateMethods()
    let manager = self.manager
    AppLock.shared.viewController = { manager.viewController }
    AppLock.shared.onLock = { [weak self] in
      // A sign-in sheet left open must not survive a lock.
      self?.authSession?.cancel()
      self?.authSession = nil
      // Nor a share sheet: AppLock dismisses it; tell the caller it was not shared
      // (the caller then deletes the file).
      self?.pendingShare?(false)
    }
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
      if AppLock.shared.isLocked {
        invoke.reject(PrismIosPlugin.lockedMessage)
        return
      }
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

  /// Always resolves exactly once: true only on the confirm button; false on
  /// Cancel, while locked, or when the alert could not be presented.
  @objc public func confirm(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ConfirmArgs.self)
    DispatchQueue.main.async {
      var answered = false
      let answer: (Bool) -> Void = { ok in
        if answered { return }
        answered = true
        invoke.resolve(["confirmed": ok])
      }
      guard !AppLock.shared.isLocked, var top = self.manager.viewController, top.view.window != nil else {
        answer(false)
        return
      }
      while let presented = top.presentedViewController, !presented.isBeingDismissed { top = presented }
      let alert = UIAlertController(title: args.title, message: args.message, preferredStyle: .alert)
      let cancel = UIAlertAction(title: "Cancel", style: .cancel) { _ in answer(false) }
      let ok = UIAlertAction(title: args.confirm, style: args.destructive ? .destructive : .default) { _ in
        answer(true)
      }
      alert.addAction(cancel)
      alert.addAction(ok)
      alert.preferredAction = args.cancelIsDefault ? cancel : ok
      top.present(alert, animated: true)
      // UIKit drops a presentation silently (e.g. another one is in flight):
      // never leave the caller waiting.
      DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
        if alert.presentingViewController == nil { answer(false) }
      }
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
    DispatchQueue.main.async {
      if AppLock.shared.isLocked {
        invoke.resolve(["confirmed": false])
        return
      }
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

  /// Resolves `{confirmed: true}` once nothing is behind the lock cover (at once
  /// when no lock is on). The shell waits on it before handing an incoming link
  /// to the page (links.rs), so a link never opens content behind the lock.
  @objc public func waitUnlocked(_ invoke: Invoke) {
    AppLock.shared.whenUnlocked { ok in
      invoke.resolve(["confirmed": ok])
    }
  }

  // MARK: export → share sheet

  /// What the shell exports: an archive (save_export) or one note (export_note).
  private static let shareableExtensions: Set<String> = ["zip", "md", "html"]

  /// Present the system share sheet (Save to Files, AirDrop, …) for ONE file the
  /// shell just wrote. Only a `.zip` / `.md` / `.html` inside
  /// `<app tmp>/prism-exports/` is accepted; the path comes from Rust
  /// (native_cmds.rs), never from the page.
  /// Resolves `{confirmed: <an activity completed>}`; the shell deletes the file
  /// either way.
  @objc public func shareFile(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ShareFileArgs.self)
    let file = URL(fileURLWithPath: args.path).standardizedFileURL.resolvingSymlinksInPath()
    let root = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
      .appendingPathComponent("prism-exports", isDirectory: true)
      .standardizedFileURL.resolvingSymlinksInPath()
    var isDir: ObjCBool = false
    guard file.path.hasPrefix(root.path + "/"),
      PrismIosPlugin.shareableExtensions.contains(file.pathExtension.lowercased()),
      FileManager.default.fileExists(atPath: file.path, isDirectory: &isDir), !isDir.boolValue
    else {
      invoke.reject("That export can't be shared.")
      return
    }
    DispatchQueue.main.async {
      if AppLock.shared.isLocked {
        invoke.reject(PrismIosPlugin.lockedMessage)
        return
      }
      guard var top = self.manager.viewController, top.view.window != nil else {
        invoke.reject("Couldn't open the share sheet")
        return
      }
      while let presented = top.presentedViewController, !presented.isBeingDismissed { top = presented }
      // One sheet at a time: an earlier one that is somehow still pending was not shared.
      self.pendingShare?(false)
      var answered = false
      let answer: (Bool) -> Void = { [weak self] ok in
        if answered { return }
        answered = true
        self?.pendingShare = nil
        invoke.resolve(["confirmed": ok])
      }
      self.pendingShare = answer
      let sheet = UIActivityViewController(activityItems: [file], applicationActivities: nil)
      sheet.completionWithItemsHandler = { _, completed, _, _ in answer(completed) }
      // iPad: the sheet is a popover and needs an anchor; centre it, no arrow.
      if let pop = sheet.popoverPresentationController {
        pop.sourceView = top.view
        pop.sourceRect = CGRect(x: top.view.bounds.midX, y: top.view.bounds.midY, width: 0, height: 0)
        pop.permittedArrowDirections = []
      }
      top.present(sheet, animated: true)
      // UIKit drops a presentation silently (another one is in flight): never
      // leave the caller — and the downloaded file — waiting.
      DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
        if sheet.presentingViewController == nil { answer(false) }
      }
    }
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

  /// What the last tapped notification names (consumed): `{sessionId, notificationId}`,
  /// each an id or null. While the app is LOCKED it answers nulls and keeps the
  /// tap: the page would otherwise open that session / inbox item behind the lock
  /// cover. The page is pinged again once the app is unlocked.
  @objc public func takeOpenedSession(_ invoke: Invoke) {
    DispatchQueue.main.async {
      if AppLock.shared.isLocked {
        // Kept for after the unlock: ask the page to come back for it then (the
        // ping from the tap itself may have fired before the lock was applied).
        if self.openedSessionId != nil || self.openedNotificationId != nil {
          AppLock.shared.whenUnlocked { [weak self] ok in
            if ok { self?.pingPushOpened() }
          }
        }
        invoke.resolve(["sessionId": NSNull(), "notificationId": NSNull()])
        return
      }
      var result: JsonObject = ["sessionId": NSNull(), "notificationId": NSNull()]
      if let id = self.openedSessionId { result["sessionId"] = id }
      if let id = self.openedNotificationId { result["notificationId"] = id }
      self.openedSessionId = nil
      self.openedNotificationId = nil
      invoke.resolve(result)
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

  // Tap: remember what it names (ids only, validated) and tell the page to ask
  // for it — once nothing is behind the lock cover. The page pulls it through
  // takeOpenedSession, so the id always takes the same validated path, warm
  // start or cold. Server payloads (apps/server/src/apns.ts): an agent turn
  // carries `sessionId` + `url: /agent/<id>`, an inbox notification
  // `notificationId` + `url: /inbox/<id>`.
  func userNotificationCenter(
    _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    let info = response.notification.request.content.userInfo
    let url = info["url"] as? String
    var session: String? = info["sessionId"] as? String
    if session == nil, let url = url, url.hasPrefix("/agent/") {
      session = String(url.dropFirst("/agent/".count))
    }
    var notification: String? = info["notificationId"] as? String
    if notification == nil, let url = url, url.hasPrefix("/inbox/") {
      notification = String(url.dropFirst("/inbox/".count))
    }
    DispatchQueue.main.async {
      if let id = session, PrismIosPlugin.matches(PrismIosPlugin.sessionIdPattern, id) {
        self.openedSessionId = id
        self.openedNotificationId = nil
      } else if let id = notification, PrismIosPlugin.matches(PrismIosPlugin.notificationIdPattern, id) {
        self.openedNotificationId = id
        self.openedSessionId = nil
      } else {
        completionHandler()
        return
      }
      AppLock.shared.whenUnlocked { [weak self] ok in
        if ok { self?.pingPushOpened() }
      }
      completionHandler()
    }
  }

  /// The ONE script this plugin ever evaluates: fixed and data-free.
  private func pingPushOpened() {
    self.webview?.evaluateJavaScript(
      "window.dispatchEvent(new CustomEvent('prism:native-push-opened'))", completionHandler: nil)
  }

  static func matches(_ pattern: NSRegularExpression, _ s: String) -> Bool {
    let range = NSRange(s.startIndex..., in: s)
    return pattern.firstMatch(in: s, range: range) != nil
  }
}

@_cdecl("init_plugin_prism_ios")
func initPlugin() -> Plugin {
  return PrismIosPlugin()
}
