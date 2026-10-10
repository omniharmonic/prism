#if os(macOS)
import AppKit
@preconcurrency import AVFoundation
@preconcurrency import Speech
import Observation
import OmniCore
import SwiftUI

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
    private let engine = AVAudioEngine()
    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var audioSink: WakeAudioSink?
    private var recognition: SFSpeechRecognitionTask?
    private var tapped = false
    private var eligible = false
    private var gate = WakeListeningGate()
    private var scenes: [UUID: Bool] = [:]
    private var sleeping = false
    private var epoch = WakeRecognitionEpoch()
    private var rollover: Task<Void, Never>?
    private var authorization: Task<Void, Never>?
    private var observers: [NSObjectProtocol] = []
    private init() {
        enabled = UserDefaults.standard.bool(forKey: "omni.experimentalHeyOmni")
        for name in [NSWorkspace.willSleepNotification, NSWorkspace.didWakeNotification] {
            observers.append(NSWorkspace.shared.notificationCenter.addObserver(forName: name, object: nil, queue: .main) { note in
                let sleep = note.name == NSWorkspace.willSleepNotification
                Task { @MainActor in self.sleeping = sleep; self.reconcile() }
            })
        }
        observers.append(NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { _ in
            Task { @MainActor in self.stop(); self.reconcile() }
        })
    }
    public func update(scene: UUID, eligible: Bool) {
        scenes[scene] = eligible
        self.eligible = scenes.values.contains(true)
        reconcile()
    }
    public func remove(scene: UUID) {
        scenes[scene] = nil
        eligible = scenes.values.contains(true)
        reconcile()
    }
    private func reconcile() {
        gate.update(enabled: enabled, ready: eligible, sleeping: sleeping,
                    conversationActive: VoiceMicrophoneCoordinator.shared.conversationOwner != nil)
        guard gate.canListen else {
            authorization?.cancel(); authorization = nil
            stop(); status = !enabled ? "Off" : sleeping ? "Paused while Mac sleeps" : "Paused"; return
        }
        guard recognition == nil, authorization == nil else { return }
        let permissionToken = gate.permissionRequest()
        authorization = Task {
            let mic = await AVCaptureDevice.requestAccess(for: .audio)
            let speech = await withCheckedContinuation { continuation in
                SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
            }
            guard !Task.isCancelled, gate.acceptsPermission(permissionToken) else { return }
            authorization = nil
            guard enabled, eligible, !sleeping, VoiceMicrophoneCoordinator.shared.conversationOwner == nil else { return }
            guard mic, speech == .authorized else { status = "Microphone or speech permission denied"; return }
            start()
        }
    }
    private func start() {
        let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
        guard let recognizer, recognizer.isAvailable, recognizer.supportsOnDeviceRecognition else {
            status = "On-device recognition unavailable"; return
        }
        guard VoiceMicrophoneCoordinator.shared.acquireWake(owner: owner, onPreempt: { [weak self] in self?.stop(); self?.status = "Paused for conversation" }) else { return }
        self.recognizer = recognizer
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = true
        self.request = request
        let sink = WakeAudioSink(request); audioSink = sink
        let token = epoch.begin()
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { stop(); status = "Microphone unavailable"; return }
        input.installTap(onBus: 0, bufferSize: 1024, format: format, block: Self.audioTap(sink))
        tapped = true
        recognition = recognizer.recognitionTask(with: request, resultHandler: Self.recognitionCallback { [weak self] wake, finished in
            guard let self, self.epoch.isCurrent(token) else { return }
                if wake {
                    guard self.epoch.consumeWake(token) else { return }
                    self.stop(); self.status = "Opening conversation"
                    MacVoiceShortcut.shared.activate()
                } else if finished {
                    self.stop(); self.status = "Recognition ended — toggle to retry"
                }
        })
        do {
            engine.prepare(); try engine.start(); status = "Listening locally (experimental)"
            rollover = Task { [weak self] in
                try? await Task.sleep(for: .seconds(50))
                guard !Task.isCancelled, let self, self.epoch.isCurrent(token) else { return }
                self.stop(); self.reconcile()
            }
        }
        catch { stop(); status = "Microphone unavailable" }
    }
    nonisolated private static func audioTap(_ sink: WakeAudioSink) -> AVAudioNodeTapBlock {
        { buffer, _ in sink.append(buffer) }
    }
    nonisolated private static func recognitionCallback(_ deliver: @escaping @MainActor @Sendable (Bool, Bool) -> Void) -> @Sendable (SFSpeechRecognitionResult?, (any Error)?) -> Void {
        { result, error in
            let wake = result.map { WakePhraseMatcher.matches($0.bestTranscription.formattedString) } ?? false
            let finished = result?.isFinal == true || error != nil
            Task { @MainActor in deliver(wake, finished) }
        }
    }
    private func stop() {
        epoch.invalidate()
        rollover?.cancel(); rollover = nil
        engine.stop()
        if tapped { engine.inputNode.removeTap(onBus: 0); tapped = false }
        audioSink?.close(); audioSink = nil; recognition?.cancel()
        request = nil; recognition = nil; recognizer = nil
        VoiceMicrophoneCoordinator.shared.releaseWake(owner: owner)
    }
}

public struct MacWakeReadiness: ViewModifier {
    let app: AppModel
    @State private var scene = UUID()
    public init(app: AppModel) { self.app = app }
    public func body(content: Content) -> some View {
        content.onAppear { update() }
            .onChange(of: app.phase) { update() }
            .onChange(of: PrivacyLock.shared.locked) { update() }
            .onChange(of: VoiceMicrophoneCoordinator.shared.conversationOwner) { update() }
            .onDisappear { MacWakeListener.shared.remove(scene: scene) }
    }
    private func update() {
        MacWakeListener.shared.update(scene: scene, eligible: app.phase == .signedIn && !PrivacyLock.shared.locked)
    }
}
#endif
