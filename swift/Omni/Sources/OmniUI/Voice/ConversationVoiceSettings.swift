import OmniCore
import SwiftUI

/// Installed Apple playback voices. Recognition engine settings remain in Voice options.
struct ConversationVoiceSettings: View {
    let device: ConversationDevice
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var phase
    @State private var voices: [SpeechVoice] = []
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
                    Toggle("Interrupt by speaking", isOn: Binding(get: { device.turnPreferences.acousticInterruption }, set: { device.turnPreferences.acousticInterruption = $0 }))
                } header: { Text("Experimental") } footer: {
                    Text("Listen for your voice while Omni speaks, using on-device echo cancellation. If playback interrupts itself, turn this off and use Interrupt and speak. Changes apply to the next session.")
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
                } header: { Text("Spoken reply voice") } footer: {
                    Text("Apple voices installed on this device. Automatic prefers Premium, then Enhanced quality. This choice is remembered on this device.")
                }
                Section("Speaking rate") {
                    Slider(value: Binding(get: { preferences.rate }, set: { device.stopPreview(); preferences.rate = $0 }),
                           in: SpeechPreferences.rateRange) { Text("Speaking rate") }
                    HStack {
                        Text("Slower"); Spacer(); Text("Faster")
                    }.font(.caption).foregroundStyle(.secondary)
                    Button("Use default rate") { device.stopPreview(); preferences.rate = SpeechPreferences.defaultRate }
                        .disabled(preferences.rate == SpeechPreferences.defaultRate)
                    Button(device.speech.isPreviewing ? "Stop preview" : "Preview voice", systemImage: device.speech.isPreviewing ? "stop.fill" : "play.fill") {
                        if device.speech.isPreviewing { device.stopPreview() }
                        else { device.previewVoice(identifier: chosen?.id) }
                    }.accessibilityIdentifier("voice.preview")
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
        .onAppear { refresh() }
        .onChange(of: phase) { if phase == .active { refresh() } else { device.stopPreview() } }
        .onDisappear { device.stopPreview() }
    }
    private func refresh() { voices = AppleVoiceCatalog.installed() }
    private func languageName(_ tag: String) -> String { Locale.current.localizedString(forIdentifier: tag) ?? tag }
}
