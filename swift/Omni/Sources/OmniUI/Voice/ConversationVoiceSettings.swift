import OmniCore
import SwiftUI

/// Swappable reply speech providers; recognition stays independent.
struct ConversationVoiceSettings: View {
    let device: ConversationDevice
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var phase
    @State private var voices: [SpeechVoice] = []
    @State private var recognitionVocabulary = ""
    private var preferences: SpeechPreferences { device.speechPreferences }
    private var chosen: SpeechVoice? { AppleVoiceCatalog.resolve(preferences, voices: voices) }
    private var languages: [String] {
        Array(Set(voices.map(\.language) + [preferences.language])).sorted { languageName($0) < languageName($1) }
    }
    private var available: [SpeechVoice] {
        voices.filter { $0.language == preferences.language }.sorted {
            if $0.quality != $1.quality { return $0.quality > $1.quality }
            return $0.name.localizedStandardCompare($1.name) == .orderedAscending
        }
    }
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Turn taking", selection: Binding(get: { device.turnPreferences.mode }, set: { device.turnPreferences.mode = $0 })) {
                        Text("Think aloud").tag(VoiceTurnMode.thinkAloud)
                        Text("Automatic").tag(VoiceTurnMode.automatic)
                    }
                    if device.turnPreferences.mode == .automatic {
                        Picker("Wait after speech", selection: Binding(get: { device.turnPreferences.pauseSeconds }, set: { device.turnPreferences.pauseSeconds = $0 })) {
                            Text("2 seconds").tag(2.0)
                            Text("4 seconds").tag(4.0)
                            Text("8 seconds").tag(8.0)
                            Text("12 seconds").tag(12.0)
                            Text("20 seconds").tag(20.0)
                        }
                    }
                } header: { Text("Conversation") } footer: {
                    if device.turnPreferences.mode == .automatic {
                        Text("After you speak, Omni waits through the selected pause, then shows a 3-second countdown. Speak again or tap Keep listening to cancel it. Speech detection runs on this device and may download a small model on first use. Changes apply when you next start or resume a session.")
                    } else {
                        Text("Tap Send turn when you're ready for Omni to respond. Pause keeps your words as an unsent draft. Long recordings are transcribed in sections on this device. At 15 minutes, or if transcription cannot keep up, Omni pauses and keeps recognized words as an unsent draft.")
                    }
                }
                Section {
                    TextField("Names and terms, separated by commas", text: $recognitionVocabulary, axis: .vertical)
                        .lineLimit(3...6)
                        .accessibilityIdentifier("voice.vocabulary")
                        .onChange(of: recognitionVocabulary) {
                            device.recognitionVocabulary = recognitionVocabulary
                                .split(whereSeparator: { $0 == "," || $0.isNewline })
                                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                                .filter { !$0.isEmpty }
                        }
                } header: { Text("Recognition vocabulary") } footer: {
                    Text("Optional names and terms to help speech recognition. Leave blank for no custom vocabulary. Changes apply the next time you start or resume voice.")
                }
                Section {
                    Toggle("Interrupt by speaking", isOn: Binding(get: { device.turnPreferences.acousticInterruption }, set: { device.turnPreferences.acousticInterruption = $0 }))
                    if device.turnPreferences.acousticInterruption {
                        Picker("Interruption responsiveness", selection: Binding(get: { device.turnPreferences.interruptionResponsiveness }, set: { device.turnPreferences.interruptionResponsiveness = $0 })) {
                            ForEach(VoiceInterruptionResponsiveness.allCases, id: \.self) { Text($0.title).tag($0) }
                        }
                    }
                } header: { Text("Experimental") } footer: {
                    Text("Listen for your voice while Omni speaks, using on-device echo cancellation. Omni starts listening about a second into each reply, ignores captured speech that matches what it just said, and pauses automatic sending if it seems to be answering itself. Sustained requires longer speech to interrupt and may reduce interruptions from brief noises; continuous noise can still interrupt. Quick responds sooner. If playback still interrupts itself, turn this off and use Interrupt and speak. Responsiveness changes apply to the next reply.")
                }
                Section {
                    Picker("Speech provider", selection: Binding(get: { device.replyPreferences.provider }, set: {
                        device.stopPreview(); device.replyPreferences.provider = $0
                    })) {
                        Text("Kokoro · your server").tag(ReplySpeechPreferences.Provider.kokoro)
                        Text("Hermes · Microsoft Edge").tag(ReplySpeechPreferences.Provider.hermesEdge)
                        Text("Apple · on this device").tag(ReplySpeechPreferences.Provider.apple)
                    }
                    if device.replyPreferences.provider == .kokoro {
                        if device.replyProvidersLoading {
                            ProgressView("Checking server voices…")
                        } else if let provider = device.replyProviders.first(where: { $0.id == "kokoro-local" && $0.available }) {
                            Picker("Kokoro voice", selection: Binding(get: { device.replyPreferences.kokoroVoiceID }, set: {
                                device.stopPreview(); device.replyPreferences.kokoroVoiceID = $0
                            })) {
                                ForEach(provider.voices) { Text($0.name).tag($0.id) }
                            }
                            Text("Ready on your paired server").foregroundStyle(.secondary)
                        } else {
                            Text("Kokoro is not ready yet. The server may be warming up; refresh shortly. Replies use your Apple fallback voice while it is unavailable.").foregroundStyle(.secondary)
                            Button("Refresh server voices") { Task { await device.refreshReplyProviders() } }
                        }
                    }
                    if device.replyPreferences.provider == .hermesEdge {
                        if let provider = device.replyProviders.first(where: { $0.id == "hermes-edge" && $0.available }) {
                            Picker("Hermes voice", selection: Binding(get: { device.replyPreferences.edgeVoiceID ?? provider.defaultVoiceID }, set: {
                                device.stopPreview(); device.replyPreferences.edgeVoiceID = $0
                            })) {
                                ForEach(provider.voices) { Text($0.name).tag($0.id) }
                            }
                        } else {
                            Text("Hermes speech is unavailable on this server. Replies use the Apple voice until it is available.").foregroundStyle(.secondary)
                        }
                    }
                    if let notice = device.replySpeechNotice { Text(notice).foregroundStyle(.secondary) }
                } header: { Text("Reply speech") } footer: {
                    if device.replyPreferences.provider == .hermesEdge {
                        Text("Hermes sends spoken reply text to Microsoft’s online Edge speech service. Microphone audio stays on this device. Internet access is required; Apple is the on-device fallback.")
                    } else if device.replyPreferences.provider == .kokoro {
                        Text("Kokoro generates speech on your paired server using af_heart. Spoken reply text is sent to that server. A connection to your server is required; Apple is the on-device fallback.")
                    } else {
                        Text("Apple generates speech on this device. Your downloaded Apple voice selection is preserved when switching providers.")
                    }
                }
                Section {
                    Picker("Language & region", selection: Binding(get: { preferences.language }, set: {
                        device.stopPreview(); preferences.selectLanguage($0)
                    })) {
                        ForEach(languages, id: \.self) { Text(languageName($0)).tag($0) }
                    }
                    Picker("Voice", selection: Binding(get: { preferences.identifier ?? "" }, set: { id in
                        device.stopPreview(); preferences.select(voices.first { $0.id == id })
                    })) {
                        Text("Automatic").tag("")
                        ForEach(available) { voice in Text("\(voice.name) · \(voice.quality.label)").tag(voice.id) }
                        if let id = preferences.identifier, !voices.contains(where: { $0.id == id }) {
                            Text("Saved voice unavailable").tag(id)
                        }
                    }
                    if let chosen { LabeledContent("Using", value: "\(chosen.name) · \(chosen.quality.label)") }
                    if let identifier = preferences.identifier, !voices.contains(where: { $0.id == identifier }) {
                        Text("Your saved voice is no longer installed. Using \(chosen?.name ?? "the system voice") until it returns or you choose another.")
                            .font(.callout).foregroundStyle(.secondary)
                    }
                    if available.isEmpty { Text("No installed voices for this region. Using the closest available system voice.").foregroundStyle(.secondary) }
                } header: { Text(device.replyPreferences.provider == .apple ? "Apple reply voice" : "Apple fallback voice") } footer: {
                    Text("Apple voices installed on this device. Automatic prefers Premium, then Enhanced quality. This choice is remembered on this device.")
                }
                Section("Apple speaking rate") {
                    Slider(value: Binding(get: { preferences.rate }, set: { device.stopPreview(); preferences.rate = $0 }),
                           in: SpeechPreferences.rateRange) { Text("Speaking rate") }
                    HStack {
                        Text("Slower"); Spacer(); Text("Faster")
                    }.font(.caption).foregroundStyle(.secondary)
                    Button("Use default rate") { device.stopPreview(); preferences.rate = SpeechPreferences.defaultRate }
                        .disabled(preferences.rate == SpeechPreferences.defaultRate)
                    Button((device.speech.isPreviewing || device.replyIsPreviewing) ? "Stop preview" : "Preview selected provider", systemImage: (device.speech.isPreviewing || device.replyIsPreviewing) ? "stop.fill" : "play.fill") {
                        if device.speech.isPreviewing || device.replyIsPreviewing { device.stopPreview() }
                        else { device.previewVoice(identifier: chosen?.id) }
                    }.accessibilityIdentifier("voice.preview")
                }
                Section("Open voice quickly") {
                    #if os(macOS)
                    Text("Press Control–Option–Command–Space while Omni is running, or choose Talk to Omni from the menu bar.")
                    Text("For experimental Hey Omni, enable it in the menu bar. Wait for Listening before speaking your request.")
                    #else
                    Text("On iPhone, open Settings → Action Button → Shortcut → Choose a Shortcut, then choose Talk to Omni.")
                    Text("On iPad, add Omni’s Talk to Omni action to a shortcut, then put it on your Home Screen or in a Shortcuts widget.")
                    #endif
                    Text("Unlock and sign in when asked. Repeated presses keep the current conversation.").font(.callout).foregroundStyle(.secondary)
                }
                Section("More voices") {
                    if !available.contains(where: { $0.quality > .standard }) {
                        Text("Only standard voices are installed for this region. Download an Enhanced or Premium voice in system settings to try a higher-quality option.")
                    }
                    #if os(macOS)
                    Text("System Settings → Accessibility → Read & Speak → System voice → Manage Voices.")
                    #else
                    Text("Settings → Accessibility → Read & Speak → Voices. Choose a language and tap a voice to download it.")
                    #endif
                    Text("Return here after downloading; the installed list refreshes automatically. Siri voices are not available to Omni through Apple's speech API.")
                        .font(.callout).foregroundStyle(.secondary)
                    Button("Refresh installed voices") { refresh() }
                }
            }
            .formStyle(.grouped)
            .navigationTitle("Voice & Playback")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            #if os(macOS)
            .frame(minWidth: 380, idealWidth: 460, minHeight: 480, idealHeight: 640)
            #endif
        }
        .onAppear {
            recognitionVocabulary = device.recognitionVocabulary.joined(separator: ", ")
            refresh()
        }
        .task { await device.refreshReplyProviders() }
        .onChange(of: phase) { if phase == .active { refresh() } else { device.stopPreview() } }
        .onDisappear { device.stopPreview() }
    }
    private func refresh() { voices = AppleVoiceCatalog.installed() }
    private func languageName(_ tag: String) -> String { Locale.current.localizedString(forIdentifier: tag) ?? tag }
}
