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
        .navigationTitle(barTitle)
        #if os(iOS)
        // A thread's own title, whole, in the bar; its state under it. (A label in the bar
        // was cut down to a sliver on an iPhone.)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 0) {
                    Text(barTitle).font(.headline).lineLimit(1)
                    if let state = model.thread.map({ $0.gone ? "No longer available" : ThreadGrouping.title(for: $0.state) }) {
                        Text(state).font(.caption).foregroundStyle(Color.quietText).lineLimit(1)
                    }
                }
                // A bar does not grow with the text size (the system shows its items large
                // on a long press instead); held to sizes that fit it.
                .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(.isHeader)
            }
        }
        #else
        .toolbar {
            if let thread = model.thread {
                ToolbarItem {
                    Label(ThreadGrouping.title(for: thread.state), systemImage: StateStyle.symbol(thread.state))
                        .labelStyle(.titleAndIcon)
                        .font(.callout)
                        .foregroundStyle(Color.quietText)
                        .accessibilityLabel("State: \(ThreadGrouping.title(for: thread.state))")
                }
            }
        }
        #endif
        .task(id: model.threadID) { await session.openThread(model) }
        .onDisappear { model.close() }
    }

    /// The thread's title; the list's, while the thread itself has not loaded (or never will).
    private var barTitle: String {
        model.thread == nil ? session.threads.thread(model.threadID).map(ThreadGrouping.displayTitle) ?? model.title : model.title
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
                            Text("Nothing here yet.").foregroundStyle(Color.quietText).frame(maxWidth: .infinity)
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
                // A short conversation starts at the top; a long one opens at its end and
                // stays there as the answer grows.
                .defaultScrollAnchor(.top, for: .alignment)
                .defaultScrollAnchor(.bottom, for: .initialOffset)
                .defaultScrollAnchor(.bottom, for: .sizeChanges)
                .accessibilityIdentifier("transcript")
                #if os(iOS)
                // Dragging the conversation puts the keyboard away (there is no other way to on an iPhone).
                .scrollDismissesKeyboard(.immediately)
                // A focused TextEditor can retain its keyboard at the largest text sizes
                // even when the enclosing conversation is dragged. Keep scrolling's
                // gesture and explicitly relinquish the editor's first responder.
                .simultaneousGesture(DragGesture(minimumDistance: 10).onChanged { _ in
                    UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
                })
                #endif
                .refreshable { await model.reload() }
                .onChange(of: model.timeline) { proxy.scrollTo("bottom", anchor: .bottom) }
                // The keyboard came up, or the message box grew: the room for the conversation
                // shrank, and its end must not slide under the box.
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { old, new in
                    if new < old { proxy.scrollTo("bottom", anchor: .bottom) }
                }
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
            Image(systemName: symbol).foregroundStyle(Color.quietText).accessibilityHidden(true)
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
    /// Put the cursor in the box when it appears. Always on the Mac (a thread opens ready to
    /// type in). On iPhone and iPad only where typing is the whole point — a new thread —
    /// because there the cursor brings the keyboard up over half the conversation.
    var focusOnAppear = Composer.focusesByDefault
    @ViewBuilder var accessory: Accessory
    @FocusState private var focused: Bool
    @Environment(\.dynamicTypeSize) private var typeSize

    init(
        text: Binding<String>,
        placeholder: String,
        canSend: Bool,
        isRunning: Bool = false,
        isStopping: Bool = false,
        onSend: @escaping () -> Void,
        onStop: @escaping () -> Void = {},
        focusOnAppear: Bool = Composer.focusesByDefault,
        @ViewBuilder accessory: () -> Accessory = { EmptyView() }
    ) {
        self.focusOnAppear = focusOnAppear
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
                // Up to eight lines, then the box scrolls. Four at the accessibility text
                // sizes, where eight would fill the screen and push Send under the keyboard.
                .lineLimit(1...(typeSize.isAccessibilitySize ? 4 : 8))
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 5)
                .padding(.vertical, Self.verticalInset)
                .foregroundStyle(text.isEmpty ? AnyShapeStyle(Color.quietText) : AnyShapeStyle(.clear))
                .accessibilityHidden(true)
                .overlay {
                    TextEditor(text: $text)
                        .font(.body)
                        .scrollContentBackground(.hidden)
                        .focused($focused)
                        .accessibilityLabel(placeholder)
                        .accessibilityIdentifier("composer")
                        #if os(iOS)
                        // Return starts a new line here, so the keyboard needs its own way out.
                        .toolbar {
                            if focused {
                                ToolbarItemGroup(placement: .keyboard) {
                                    Spacer()
                                    Button("Done") { focused = false }
                                        .accessibilityLabel("Hide keyboard")
                                        .accessibilityIdentifier("composer.hideKeyboard")
                                }
                            }
                        }
                        #endif
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
                .accessibilityIdentifier("composer.stop")
                .accessibilityHint("Stops what Omni is doing in this thread")
            } else {
                Button(action: onSend) {
                    Image(systemName: "arrow.up.circle.fill").font(.title2)
                }
                .buttonStyle(.plain)
                .foregroundStyle(canSend ? AnyShapeStyle(.tint) : AnyShapeStyle(Color.quietText))
                .opacity(canSend ? 1 : 0.6)
                .disabled(!canSend)
                .help("Send (Return)")
                .accessibilityLabel("Send message")
                .accessibilityIdentifier("composer.send")
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 10)
        .onAppear { if focusOnAppear { focused = true } }
    }

    static var focusesByDefault: Bool {
        #if os(macOS)
        true
        #else
        false
        #endif
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
            // Centred when there is room; scrolls under the keyboard at the largest text sizes.
            GeometryReader { area in
                ScrollView {
                    ContentUnavailableView {
                        Label("New thread", systemImage: "square.and.pencil")
                    } description: {
                        Text("Say what you want done. Omni works on it in its own thread and asks before anything goes out.")
                    }
                    .frame(maxWidth: .infinity, minHeight: area.size.height)
                }
                .scrollBounceBehavior(.basedOnSize)
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
                },
                focusOnAppear: true
            )
            .disabled(session.threads.isCreating)
            // The box keeps the height its text needs; the words above give way.
            .fixedSize(horizontal: false, vertical: true)
            .layoutPriority(1)
        }
        .navigationTitle("New Thread")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
    }

    private var canSend: Bool {
        !session.threads.isCreating && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}
