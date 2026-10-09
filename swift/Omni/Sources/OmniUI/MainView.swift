import OmniClient
import OmniCore
import SwiftUI

/// The signed-in window. Mac and iPad: a sidebar (Today, Needs you, threads by state,
/// Recurring) and the selected content. iPhone: tabs Today · Needs you · Threads
/// (product-spec.md § 4).
struct MainView: View {
    let app: AppModel
    @Bindable var session: SessionModel

    var body: some View {
        #if os(macOS)
        SplitMainView(app: app, session: session)
        #else
        TabMainView(app: app, session: session)
        #endif
    }
}

/// The content for a destination (the split view's detail; an iPhone tab's pushed screen).
struct DestinationView: View {
    @Bindable var session: SessionModel
    let destination: Destination?

    var body: some View {
        switch destination {
        case .today, nil:
            TodayView(session: session)
        case .needsYou:
            NeedsYouView(session: session)
        case .thread(let id):
            ThreadView(session: session, model: session.threadModel(for: id)).id(id)
        case .newThread:
            NewThreadView(session: session)
        case .recurring:
            JobsView(model: session.jobs)
        }
    }
}

// MARK: Sidebar rows (shared)

struct ThreadRow: View {
    let thread: OmniThread

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: thread.gone ? "bubble.left.and.exclamationmark.bubble.right" : StateStyle.symbol(thread.state))
                .foregroundStyle(thread.gone ? Color.secondary : StateStyle.color(thread.state))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(ThreadGrouping.displayTitle(thread))
                    .fontWeight(thread.unread > 0 ? .semibold : .regular)
                    .foregroundStyle(thread.gone ? .secondary : .primary)
                    .lineLimit(1)
                if let subtitle = ThreadGrouping.subtitle(thread) {
                    Text(subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            Spacer(minLength: 4)
            if thread.unread > 0 {
                Circle().fill(.tint).frame(width: 8, height: 8).accessibilityHidden(true)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityText)
    }

    private var accessibilityText: String {
        var parts = [ThreadGrouping.displayTitle(thread), thread.gone ? "no longer available" : ThreadGrouping.title(for: thread.state)]
        if thread.unread > 0 { parts.append("unread") }
        if !thread.gone, let subtitle = ThreadGrouping.subtitle(thread) { parts.append(subtitle) }
        return parts.joined(separator: ", ")
    }
}

enum StateStyle {
    static func symbol(_ state: ThreadState) -> String {
        switch state {
        case .needsYou: return "exclamationmark.circle.fill"
        case .working: return "circle.dotted"
        case .waiting: return "clock"
        case .scheduled: return "calendar"
        case .done: return "checkmark.circle"
        default: return "circle"
        }
    }

    static func color(_ state: ThreadState) -> Color {
        switch state {
        case .needsYou: return .orange
        case .working: return .accentColor
        default: return .secondary
        }
    }
}

/// The thread sections, the empty state and the "agent unreachable" note, as list content.
struct ThreadSections: View {
    let threads: ThreadListModel
    /// Take a thread out of the list (the row's menu).
    var remove: (String) -> Void = { _ in }

    var body: some View {
        if threads.phase == .loading, threads.threads.isEmpty {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Loading threads…").font(.callout).foregroundStyle(.secondary)
            }
            .accessibilityElement(children: .combine)
        }
        if let problem = threads.removeError {
            Label(problem, systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.secondary)
        }
        if threads.agentUnavailable {
            Label("The server can't reach the agent right now. This list may be incomplete.", systemImage: "exclamationmark.triangle")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        if let failure = threads.phase.failure {
            Label(failure, systemImage: "wifi.exclamationmark").font(.caption).foregroundStyle(.secondary)
        }
        if threads.isEmpty {
            Section("Threads") {
                Text(threads.isSearching ? "No threads match that search." : "No threads yet. Start one to hand something to Omni.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
        }
        ForEach(threads.sections) { section in
            Section(section.title) {
                ForEach(section.threads) { thread in
                    Group {
                        #if os(macOS)
                        ThreadRow(thread: thread).tag(Destination.thread(thread.id))
                        #else
                        NavigationLink(value: Destination.thread(thread.id)) { ThreadRow(thread: thread) }
                        #endif
                    }
                    .contextMenu {
                        Button(thread.gone ? "Remove from List" : "Archive Thread") { remove(thread.id) }
                    }
                }
            }
        }
    }
}

// MARK: macOS

#if os(macOS)
struct SplitMainView: View {
    let app: AppModel
    @Bindable var session: SessionModel
    @State private var searchPresented = false

    var body: some View {
        @Bindable var threads = session.threads
        NavigationSplitView {
            List(selection: $session.destination) {
                Label("Today", systemImage: "sun.max").tag(Destination.today)
                Label("Needs you", systemImage: "hand.raised")
                    .badge(session.approvals.pendingCount)
                    .tag(Destination.needsYou)
                ThreadSections(threads: session.threads) { id in Task { await session.removeThread(id) } }
                Section("Recurring") {
                    Label("Recurring jobs", systemImage: "arrow.triangle.2.circlepath").tag(Destination.recurring)
                }
            }
            .navigationSplitViewColumnWidth(min: 220, ideal: 260)
            .searchable(text: $threads.searchText, isPresented: $searchPresented, placement: .sidebar, prompt: "Search threads")
            .toolbar {
                ToolbarItem {
                    Button {
                        session.requestNewThread()
                    } label: {
                        Label("New Thread", systemImage: "square.and.pencil")
                    }
                    .help("New thread (⌘N)")
                }
            }
        } detail: {
            DestinationView(session: session, destination: session.destination)
        }
        .environment(\.navigator, Navigator { session.destination = $0 })
        .onChange(of: session.searchRequests) { searchPresented = true }
        .task(id: threads.searchText) {
            // Wait for a pause in typing before asking the server.
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }
            await session.threads.refresh()
        }
        .task { await session.approvals.refresh() }
    }
}
#endif

// MARK: iPhone / iPad

#if os(iOS)
struct TabMainView: View {
    let app: AppModel
    @Bindable var session: SessionModel
    @State private var tab = Tab.today
    @State private var path: [Destination] = []
    @State private var showingNewThread = false
    @State private var showingSettings = false

    enum Tab: Hashable {
        case today, needsYou, threads
    }

    var body: some View {
        TabView(selection: $tab) {
            SwiftUI.Tab("Today", systemImage: "sun.max", value: Tab.today) {
                NavigationStack {
                    TodayView(session: session)
                        .toolbar {
                            ToolbarItem(placement: .topBarTrailing) {
                                Button {
                                    showingSettings = true
                                } label: {
                                    Label("Settings", systemImage: "gearshape")
                                }
                            }
                        }
                }
            }
            SwiftUI.Tab("Needs you", systemImage: "hand.raised", value: Tab.needsYou) {
                NavigationStack { NeedsYouView(session: session) }
            }
            .badge(session.approvals.pendingCount)
            SwiftUI.Tab("Threads", systemImage: "bubble.left.and.text.bubble.right", value: Tab.threads) {
                NavigationStack(path: $path) {
                    ThreadListScreen(session: session, showingNewThread: $showingNewThread)
                        .navigationDestination(for: Destination.self) { destination in
                            DestinationView(session: session, destination: destination)
                        }
                }
            }
        }
        .environment(\.navigator, Navigator { open($0) })
        .sheet(isPresented: $showingNewThread) {
            NavigationStack {
                NewThreadView(session: session)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Cancel") { showingNewThread = false }
                        }
                    }
            }
        }
        .sheet(isPresented: $showingSettings) {
            NavigationStack {
                SettingsView(app: app)
                    .navigationTitle("Settings")
                    .toolbar {
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Done") { showingSettings = false }
                        }
                    }
            }
        }
        .onChange(of: session.destination) { _, destination in
            // A thread was just created from the sheet: show it.
            if case .thread = destination, showingNewThread {
                showingNewThread = false
                if let destination { open(destination) }
            }
        }
        .onChange(of: session.newThreadRequests) { showingNewThread = true }
        .task { await session.approvals.refresh() }
    }

    private func open(_ destination: Destination) {
        switch destination {
        case .today:
            tab = .today
        case .needsYou:
            tab = .needsYou
        case .newThread:
            showingNewThread = true
        case .thread, .recurring:
            tab = .threads
            path = [destination]
        }
        session.destination = destination
    }
}

struct ThreadListScreen: View {
    @Bindable var session: SessionModel
    @Binding var showingNewThread: Bool

    var body: some View {
        @Bindable var threads = session.threads
        List {
            ThreadSections(threads: session.threads) { id in Task { await session.removeThread(id) } }
            Section("Recurring") {
                NavigationLink(value: Destination.recurring) {
                    Label("Recurring jobs", systemImage: "arrow.triangle.2.circlepath")
                }
            }
        }
        .navigationTitle("Threads")
        .searchable(text: $threads.searchText, prompt: "Search threads")
        .refreshable { await session.threads.refresh() }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showingNewThread = true
                } label: {
                    Label("New Thread", systemImage: "square.and.pencil")
                }
            }
        }
        .task(id: threads.searchText) {
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }
            await session.threads.refresh()
        }
    }
}
#endif
