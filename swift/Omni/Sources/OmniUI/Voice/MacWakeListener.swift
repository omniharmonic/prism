#if os(macOS)
import AppKit
@preconcurrency import AVFoundation
@preconcurrency import Speech
import Observation
import OmniCore
import SwiftUI
import WakeAudioBridge

private final class WakeAudioSink: @unchecked Sendable {
    private let lock = NSLock()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    init(_ request: SFSpeechAudioBufferRecognitionRequest) { self.request = request }
    func append(_ buffer: AVAudioPCMBuffer) {
        lock.lock(); defer { lock.unlock() }
        request?.append(buffer)
    }
    func close() {
        lock.lock(); defer { lock.unlock() }
        request?.endAudio(); request = nil
    }
}

/// Experimental full speech recognition, not a dedicated low-energy wake engine.
/// Ambient buffers go only to an explicitly on-device request and never to a file.
@MainActor @Observable public final class MacWakeListener {
    public static let shared = MacWakeListener()
    public var enabled: Bool {
        didSet { UserDefaults.standard.set(enabled, forKey: "omni.experimentalHeyOmni"); reconcile() }
    }
    public private(set) var status = "Off"
    private let owner = UUID()
    private let capture = WakeAudioEngineCycle()
    private var configurationObserver: NSObjectProtocol?
    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var audioSink: WakeAudioSink?
    private var recognition: SFSpeechRecognitionTask?
    private var tapped = false
    private var eligible = false
    private var gate = WakeListeningGate()
    private weak var boundApp: AppModel?
    private var sleeping = false
    private var userSessionActive = true
    private var epoch = WakeRecognitionEpoch()
    private var rollover: Task<Void, Never>?
    private var authorization: Task<Void, Never>?
    private var authorizationToken: UUID?
    private var retryTask: Task<Void, Never>?
    private var recovery = WakeRecoveryPolicy()
    private var observers: [NSObjectProtocol] = []
    private init() {
        enabled = UserDefaults.standard.bool(forKey: "omni.experimentalHeyOmni")
        for name in [NSWorkspace.willSleepNotification, NSWorkspace.didWakeNotification] {
            observers.append(NSWorkspace.shared.notificationCenter.addObserver(forName: name, object: nil, queue: .main) { note in
                let sleep = note.name == NSWorkspace.willSleepNotification
                Task { @MainActor in self.sleeping = sleep; self.reconcile() }
            })
        }
        for name in [NSWorkspace.sessionDidResignActiveNotification, NSWorkspace.sessionDidBecomeActiveNotification] {
            observers.append(NSWorkspace.shared.notificationCenter.addObserver(forName: name, object: nil, queue: .main) { note in
                let active = note.name == NSWorkspace.sessionDidBecomeActiveNotification
                Task { @MainActor in self.userSessionActive = active; self.reconcile() }
            })
        }
        observers.append(NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in
            // Permission changes in System Settings do not change app readiness.
            // Recheck on return without cancelling a pending recovery cooldown.
            Task { @MainActor in self.reconcile() }
        })

    }
    /// App-lifetime readiness survives closing the main window. Observation is
    /// rearmed after every change, including conversation microphone release.
    public func bind(app: AppModel) {
        guard boundApp !== app else { return }
        boundApp = app
        observeReadiness()
    }
    private func observeReadiness() {
        guard let app = boundApp else { return }
        withObservationTracking {
            eligible = app.phase == .signedIn && !PrivacyLock.shared.locked
            _ = VoiceMicrophoneCoordinator.shared.conversationOwner
        } onChange: { [weak self] in
            Task { @MainActor in self?.observeReadiness() }
        }
        reconcile()
    }
    private func updateGate() {
        if let app = boundApp { eligible = app.phase == .signedIn && !PrivacyLock.shared.locked }
        gate.update(enabled: enabled, ready: eligible && userSessionActive, sleeping: sleeping,
                    conversationActive: VoiceMicrophoneCoordinator.shared.conversationOwner != nil)
    }
    private func reconcile() {
        updateGate()
        guard gate.canListen else {
            authorization?.cancel(); authorization = nil; authorizationToken = nil
            if recognition != nil || retryTask != nil { VoiceDiagnostics.record(.wakePaused) }
            cancelRecovery()
            stop(); status = !enabled ? "Off" : sleeping ? "Paused while Mac sleeps" : "Paused"; return
        }
        guard recognition == nil, authorization == nil, retryTask == nil else { return }
        guard AVCaptureDevice.authorizationStatus(for: .audio) != .denied,
              AVCaptureDevice.authorizationStatus(for: .audio) != .restricted,
              SFSpeechRecognizer.authorizationStatus() != .denied,
              SFSpeechRecognizer.authorizationStatus() != .restricted else {
            VoiceDiagnostics.record(.wakePermissionDenied)
            status = "Microphone or speech permission denied"; return
        }
        let permissionToken = gate.permissionRequest()
        authorizationToken = permissionToken
        authorization = Task {
            defer {
                // A cancelled old prompt must never clear a newer prompt's slot.
                if authorizationToken == permissionToken {
                    authorization = nil; authorizationToken = nil
                }
            }
            let mic = await AVCaptureDevice.requestAccess(for: .audio)
            let speech = await withCheckedContinuation { continuation in
                SFSpeechRecognizer.requestAuthorization(Self.authorizationCallback(continuation))
            }
            updateGate()
            guard !Task.isCancelled, gate.acceptsPermission(permissionToken) else { return }
            authorization = nil; authorizationToken = nil
            guard gate.canListen else { return }
            guard mic, speech else {
                VoiceDiagnostics.record(.wakePermissionDenied)
                status = "Microphone or speech permission denied"; return
            }
            start()
        }
    }
    private func start() {
        let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
        guard let recognizer, recognizer.isAvailable, recognizer.supportsOnDeviceRecognition else {
            scheduleRecovery(reason: "On-device recognition unavailable"); return
        }
        guard VoiceMicrophoneCoordinator.shared.acquireWake(owner: owner, onPreempt: { [weak self] in self?.cancelRecovery(); self?.stop(); self?.status = "Paused for conversation" }) else { return }
        self.recognizer = recognizer
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = true
        self.request = request
        let sink = WakeAudioSink(request); audioSink = sink
        let token = epoch.begin()
        let startedAt = ProcessInfo.processInfo.systemUptime
        let (engine, captureToken) = capture.begin()
        configurationObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.capture.accepts(captureToken) else { return }
                self.stop(); self.scheduleRecovery(reason: "Microphone changed")
            }
        }
        let input = engine.inputNode
        let format = input.inputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { stop(); scheduleRecovery(reason: "Microphone unavailable"); return }
        do {
            try OmniWakeAudioBridge.installTap(on: input, block: Self.audioTap(sink))
        } catch {
            stop(); scheduleRecovery(reason: "Microphone unavailable"); return
        }
        tapped = true
        recognition = recognizer.recognitionTask(with: request, resultHandler: Self.recognitionCallback { [weak self] wake, finished, failed in
            guard let self, self.epoch.isCurrent(token) else { return }
                if wake {
                    guard self.epoch.consumeWake(token) else { return }
                    VoiceDiagnostics.record(.wakeDetected)
                    self.stop(); self.status = "Opening conversation"
                    MacVoiceShortcut.shared.activate()
                } else if finished {
                    self.stop()
                    self.scheduleRecovery(normalCompletion: !failed, elapsedSeconds: ProcessInfo.processInfo.systemUptime - startedAt)
                }
        })
        do {
            try OmniWakeAudioBridge.prepareAndStart(engine); VoiceDiagnostics.record(.wakeStarted); status = "Listening locally (experimental)"
            rollover = Task { [weak self] in
                try? await Task.sleep(for: .seconds(50))
                guard !Task.isCancelled, let self, self.epoch.isCurrent(token) else { return }
                VoiceDiagnostics.record(.wakeRollover)
                self.recovery.stable(); self.stop(); self.reconcile()
            }
        }
        catch { stop(); scheduleRecovery(reason: "Microphone unavailable") }
    }
    private func cancelRecovery() {
        retryTask?.cancel(); retryTask = nil
        recovery.cancel()
    }
    private func scheduleRecovery(reason: String = "Recognition ended", normalCompletion: Bool = false, elapsedSeconds: TimeInterval = 0) {
        cancelRecovery()
        updateGate()
        guard gate.canListen else { reconcile(); return }
        let retry = recovery.ended(normally: normalCompletion, elapsedSeconds: elapsedSeconds)
        VoiceDiagnostics.record(retry.coolingDown ? .wakeCooldown : .wakeRetry)
        status = "\(reason) — \(retry.coolingDown ? "cooling down" : "retrying") in \(retry.delaySeconds)s"
        retryTask = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(retry.delaySeconds)) }
            catch { return }
            guard !Task.isCancelled, let self,
                  self.recovery.consume(retry, allowed: self.gate.canListen) else { return }
            self.retryTask = nil
            self.reconcile()
        }
    }
    /// Speech may invoke authorization on a background queue. Constructing its
    /// completion in this nonisolated factory prevents inherited MainActor checks;
    /// resuming the continuation returns the awaiting task to its own executor.
    nonisolated static func authorizationCallback(_ continuation: CheckedContinuation<Bool, Never>) -> @Sendable (SFSpeechRecognizerAuthorizationStatus) -> Void {
        { status in continuation.resume(returning: status == .authorized) }
    }
    nonisolated private static func audioTap(_ sink: WakeAudioSink) -> AVAudioNodeTapBlock {
        { buffer, _ in sink.append(buffer) }
    }
    nonisolated private static func recognitionCallback(_ deliver: @escaping @MainActor @Sendable (Bool, Bool, Bool) -> Void) -> @Sendable (SFSpeechRecognitionResult?, (any Error)?) -> Void {
        { result, error in
            let wake = result.map { WakePhraseMatcher.matches($0.bestTranscription.formattedString) } ?? false
            let failed = error != nil
            let finished = result?.isFinal == true || failed
            Task { @MainActor in deliver(wake, finished, failed) }
        }
    }
    private func stop() {
        epoch.invalidate()
        rollover?.cancel(); rollover = nil
        if let configurationObserver {
            NotificationCenter.default.removeObserver(configurationObserver)
            self.configurationObserver = nil
        }
        if let engine = capture.retire() {
            engine.stop()
            if tapped { engine.inputNode.removeTap(onBus: 0) }
        }
        tapped = false
        audioSink?.close(); audioSink = nil; recognition?.cancel()
        request = nil; recognition = nil; recognizer = nil
        VoiceMicrophoneCoordinator.shared.releaseWake(owner: owner)
    }
}

#endif
