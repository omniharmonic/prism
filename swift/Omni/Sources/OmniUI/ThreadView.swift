import OmniClient
import OmniCore
import SwiftUI

/// One thread: its transcript and the composer.
struct ThreadView: View {
    let session: SessionModel
    @Bindable var model: ThreadModel

    var body: some View {
        VStack(spacing: 0) {
            transcript
            if !model.isUnavailable {
                banners
                Divider()
                Composer(
                    text: $model.draft,
                    placeholder: "Message Omni…",
                    canSend: model.canSend,
                    isRunning: model.isRunning,
                    isStopping: model.isStopping,
                    onSend: { Task { await model.send() } },
                    onStop: { Task { await model.stop() } }
                )
            }
        }
        .navigationTitle(model.title)
        .toolbar {
            if let thread = model.thread {
                ToolbarItem {
                    Label(ThreadGrouping.title(for: thread.state), systemImage: StateStyle.symbol(thread.state))
                        .labelStyle(.titleAndIcon)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .accessibilityLabel("State: \(ThreadGrouping.title(for: thread.state))")
                }
            }
        }
        .task(id: model.threadID) { await session.openThread(model) }
        .onDisappear { model.close() }
    }

    @ViewBuilder private var transcript: some View {
        switch model.phase {
        case .idle, .loading:
            ProgressView("Loading the thread…").frame(maxWidth: .infinity, maxHeight: .infinity)
        case .failed where model.isUnavailable:
            // The agent no longer has it: say so once, and offer the way out. Nothing retries.
            ContentUnavailableView {
                Label("This conversation is no longer available", systemImage: "bubble.left.and.exclamationmark.bubble.right")
            } description: {
                Text("The agent no longer has it, so it can't be opened or continued. You can remove it from your list.")
                if let problem = session.threads.removeError {
                    Text(problem).foregroundStyle(.red)
                }
            } actions: {
                Button("Remove from List") { Task { await session.removeThread(model.threadID) } }
                    .buttonStyle(.borderedProminent)
                    .disabled(session.threads.removingID != nil)
                    .accessibilityHint("Takes this thread out of your list")
                Button("Check Again") { Task { await model.checkAgain() } }
                    .accessibilityHint("Asks the server for this conversation once more")
            }
        case .failed(let message):
            ContentUnavailableView {
                Label("Couldn't open this thread", systemImage: "exclamationmark.bubble")
            } description: {
                Text(message)
            } actions: {
                Button("Try Again") { Task { await model.checkAgain() } }
            }
        case .loaded:
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 14) {
                        if model.timeline.isEmpty {
                            Text("Nothing here yet.").foregroundStyle(.secondary).frame(maxWidth: .infinity)
                        }
                        ForEach(model.timeline) { item in
                            TimelineRow(item: item, model: model, approvals: session.approvals)
                        }
                        Color.clear.frame(height: 1).id("bottom")
                    }
                    .padding()
                    .frame(maxWidth: 820, alignment: .leading)
                    .frame(maxWidth: .infinity)
                }
                .defaultScrollAnchor(.bottom)
                .refreshable { await model.reload() }
                .onChange(of: model.timeline) { proxy.scrollTo("bottom", anchor: .bottom) }
            }
        }
    }

    @ViewBuilder private var banners: some View {
        if model.connection == .reconnecting {
            Banner(symbol: "arrow.triangle.2.circlepath", text: "Reconnecting… Omni keeps working on the server.")
        }
        if let problem = model.streamProblem {
            Banner(symbol: "exclamationmark.triangle", text: problem) {
                Button("Reload") { Task { await model.reload() } }
            }
        }
        if case .failed(let message) = model.sendState {
            Banner(symbol: "exclamationmark.bubble", text: message) {
                Button("Try Again") { Task { await model.retrySend() } }
                    .accessibilityHint("Sends the same message again; it cannot be delivered twice")
                Button("Edit") { model.discardPending() }
                    .accessibilityHint("Puts the message back in the box without sending it")
            }
        }
    }
}

struct Banner<Actions: View>: View {
    let symbol: String
    let text: String
    @ViewBuilder var actions: Actions

    init(symbol: String, text: String, @ViewBuilder actions: () -> Actions = { EmptyView() }) {
        self.symbol = symbol
        self.text = text
        self.actions = actions()
    }

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: symbol).foregroundStyle(.secondary).accessibilityHidden(true)
            Text(text).font(.callout).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 8)
            actions.controlSize(.small)
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
        .background(.bar)
    }
}

/// The message box. Mac: Return sends, Shift-Return (or Option-Return) starts a new line.
/// iPhone: Return starts a new line; the button sends.
///
/// `accessory` is the seam for the voice track: the microphone button goes there, and what
/// it hears lands in `text` (or starts a thread with `source: "voice"`). Nothing is built
/// for it yet.
struct Composer<Accessory: View>: View {
    @Binding var text: String
    let placeholder: String
    let canSend: Bool
    var isRunning = false
    var isStopping = false
    let onSend: () -> Void
    var onStop: () -> Void = {}
    @ViewBuilder var accessory: Accessory
    @FocusState private var focused: Bool

    init(
        text: Binding<String>,
        placeholder: String,
        canSend: Bool,
        isRunning: Bool = false,
        isStopping: Bool = false,
        onSend: @escaping () -> Void,
        onStop: @escaping () -> Void = {},
        @ViewBuilder accessory: () -> Accessory = { EmptyView() }
    ) {
        _text = text
        self.placeholder = placeholder
        self.canSend = canSend
        self.isRunning = isRunning
        self.isStopping = isStopping
        self.onSend = onSend
        self.onStop = onStop
        self.accessory = accessory()
    }

    var body: some View {
        HStack(alignment: .bottom, spacing: 10) {
            // An invisible copy of the text sets the height; the editor fills it.
            Text(text.isEmpty ? placeholder : text + (text.hasSuffix("\n") ? " " : ""))
                .font(.body)
                .lineLimit(1...8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 5)
                .padding(.vertical, Self.verticalInset)
                .foregroundStyle(text.isEmpty ? AnyShapeStyle(.tertiary) : AnyShapeStyle(.clear))
                .accessibilityHidden(true)
                .overlay {
                    TextEditor(text: $text)
                        .font(.body)
                        .scrollContentBackground(.hidden)
                        .focused($focused)
                        .accessibilityLabel(placeholder)
                        #if os(macOS)
                        .onKeyPress(.return, phases: .down) { press in
                            // Shift- or Option-Return: let the editor insert the new line.
                            if press.modifiers.contains(.shift) || press.modifiers.contains(.option) { return .ignored }
                            if canSend { onSend() }
                            return .handled
                        }
                        #endif
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 6)
                .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 12))
            accessory
            if isRunning {
                Button(action: onStop) {
                    Image(systemName: "stop.circle.fill").font(.title2)
                }
                .buttonStyle(.plain)
                .disabled(isStopping)
                .help("Stop (⌘.)")
                .accessibilityLabel("Stop")
                .accessibilityHint("Stops what Omni is doing in this thread")
            } else {
                Button(action: onSend) {
                    Image(systemName: "arrow.up.circle.fill").font(.title2)
                }
                .buttonStyle(.plain)
                .foregroundStyle(canSend ? AnyShapeStyle(.tint) : AnyShapeStyle(.tertiary))
                .disabled(!canSend)
                .help("Send (Return)")
                .accessibilityLabel("Send")
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 10)
        .onAppear { focused = true }
    }

    private static var verticalInset: CGFloat {
        #if os(macOS)
        0
        #else
        8
        #endif
    }
}

/// ⌘N: an empty composer. Sending creates the thread and opens it.
struct NewThreadView: View {
    let session: SessionModel
    @State private var text = ""

    var body: some View {
        VStack(spacing: 0) {
            ContentUnavailableView {
                Label("New thread", systemImage: "square.and.pencil")
            } description: {
                Text("Say what you want done. Omni works on it in its own thread and asks before anything goes out.")
            }
            if let error = session.threads.createError {
                Banner(symbol: "exclamationmark.triangle", text: error) {
                    Button("Dismiss") { session.threads.clearCreateError() }
                }
            }
            Divider()
            Composer(
                text: $text,
                placeholder: "What should Omni do?",
                canSend: canSend,
                onSend: {
                    let prompt = text
                    Task {
                        if await session.startThread(prompt: prompt) { text = "" }
                    }
                }
            )
            .disabled(session.threads.isCreating)
        }
        .navigationTitle("New Thread")
    }

    private var canSend: Bool {
        !session.threads.isCreating && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}
