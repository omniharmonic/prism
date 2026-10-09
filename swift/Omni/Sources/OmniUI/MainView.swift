import OmniClient
import OmniCore
import SwiftUI

/// The signed-in window. Mac, and an iPad at full or wide width: a sidebar (Today, Needs
/// you, threads by state, Recurring) beside the selected content. iPhone, and an iPad in a
/// narrow Split View or Slide Over: tabs Today · Needs you · Threads (product-spec.md § 4).
struct MainView: View {
    let app: AppModel
    @Bindable var session: SessionModel
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var widthClass
    #endif

    var body: some View {
        #if os(macOS)
        SplitMainView(app: app, session: session)
        #else
        if widthClass == .regular {
            SplitMainView(app: app, session: session)
        } else {
            TabMainView(app: app, session: session)
        }
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
    /// true in a sidebar whose list holds the selection; false where a row is a link that
    /// pushes the thread (the iPhone's list).
    var selectable = true
    /// Take a thread out of the list (the row's menu, or a swipe).
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
            VStack(alignment: .leading, spacing: 6) {
                Label(failure, systemImage: "wifi.exclamationmark").font(.callout).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Button("Try Again") { Task { await threads.refresh() } }
                    .accessibilityHint("Reads the thread list again")
                    .accessibilityIdentifier("threads.retry")
            }
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
                        if selectable {
                            ThreadRow(thread: thread).tag(Destination.thread(thread.id))
                        } else {
                            NavigationLink(value: Destination.thread(thread.id)) { ThreadRow(thread: thread) }
                        }
                    }
                    .accessibilityIdentifier("thread.\(thread.id)")
                    .contextMenu {
                        Button(thread.gone ? "Remove from List" : "Archive Thread") { remove(thread.id) }
                    }
                    #if os(iOS)
                    .swipeActions(edge: .trailing) {
                        Button(thread.gone ? "Remove" : "Archive") { remove(thread.id) }
                            .tint(.gray)
                    }
                    #endif
                }
            }
        }
    }
}

// MARK: Sidebar + content (Mac, iPad)

/// The sidebar's list: Today, Needs you, the threads by state, Recurring.
struct SidebarList: View {
    @Bindable var session: SessionModel

    var body: some View {
        List(selection: $session.destination) {
            Label("Today", systemImage: "sun.max").tag(Destination.today)
                .accessibilityIdentifier("nav.today")
            Label("Needs you", systemImage: "hand.raised")
                .badge(session.approvals.pendingCount)
                .tag(Destination.needsYou)
                .accessibilityIdentifier("nav.needsYou")
            ThreadSections(threads: session.threads) { id in Task { await session.removeThread(id) } }
            Section("Recurring") {
                Label("Recurring jobs", systemImage: "arrow.triangle.2.circlepath").tag(Destination.recurring)
                    .accessibilityIdentifier("nav.recurring")
            }
        }
    }
}

struct SplitMainView: View {
    let app: AppModel
    @Bindable var session: SessionModel
    @State private var searchPresented = false
    #if os(iOS)
    @State private var showingSettings = false
    #endif

    var body: some View {
        @Bindable var threads = session.threads
        NavigationSplitView {
            SidebarList(session: session)
            .navigationSplitViewColumnWidth(min: 220, ideal: 260)
            #if os(iOS)
            .navigationTitle("Omni")
            .refreshable { await session.threads.refresh() }
            #endif
            .searchable(text: $threads.searchText, isPresented: $searchPresented, placement: .sidebar, prompt: "Search threads")
            .toolbar {
                #if os(iOS)
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        showingSettings = true
                    } label: {
                        Label("Settings", systemImage: "gearshape")
                    }
                    .accessibilityIdentifier("settings.open")
                }
                #endif
                ToolbarItem {
                    Button {
                        session.requestNewThread()
                    } label: {
                        Label("New Thread", systemImage: "square.and.pencil")
                    }
                    .help("New thread (⌘N)")
                    .accessibilityIdentifier("thread.new")
                }
            }
        } detail: {
            #if os(iOS)
            NavigationStack {
                DestinationView(session: session, destination: session.destination)
                    .navigationBarTitleDisplayMode(.inline)
            }
            #else
            DestinationView(session: session, destination: session.destination)
            #endif
        }
        #if os(iOS)
        // The list stays beside the content in portrait too: it is the work queue.
        .navigationSplitViewStyle(.balanced)
        .sheet(isPresented: $showingSettings) { SettingsSheet(app: app, isPresented: $showingSettings) }
        #endif
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
                                .accessibilityIdentifier("settings.open")
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
        .sheet(isPresented: $showingSettings) { SettingsSheet(app: app, isPresented: $showingSettings) }
        .onAppear {
            // Coming from the sidebar layout (an iPad window made narrow): stay where it was.
            switch session.destination {
            case .needsYou: tab = .needsYou
            case .thread, .recurring:
                tab = .threads
                if let destination = session.destination { path = [destination] }
            case .newThread: tab = .threads
            case .today, nil: break
            }
        }
        .onChange(of: path) { _, path in
            // What is pushed is where the session is (Stop, Refresh and "remove this thread"
            // act on it); back at the list, nothing is open.
            if let top = path.last {
                if session.destination != top { session.destination = top }
            } else if tab == .threads, session.destination != .newThread {
                session.destination = nil
            }
        }
        .onChange(of: session.destination) { _, destination in
            // The open thread was taken out of the list: go back to the list, not a dead screen.
            if destination == .today, !path.isEmpty, tab == .threads { path = [] }
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

/// Settings as a sheet (iPhone, iPad).
struct SettingsSheet: View {
    let app: AppModel
    @Binding var isPresented: Bool

    var body: some View {
        NavigationStack {
            SettingsView(app: app)
                .navigationTitle("Settings")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { isPresented = false }
                    }
                }
        }
    }
}

struct ThreadListScreen: View {
    @Bindable var session: SessionModel
    @Binding var showingNewThread: Bool

    var body: some View {
        @Bindable var threads = session.threads
        List {
            ThreadSections(threads: session.threads, selectable: false) { id in Task { await session.removeThread(id) } }
            Section("Recurring") {
                NavigationLink(value: Destination.recurring) {
                    Label("Recurring jobs", systemImage: "arrow.triangle.2.circlepath")
                }
                .accessibilityIdentifier("nav.recurring")
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
                .accessibilityIdentifier("thread.new")
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
