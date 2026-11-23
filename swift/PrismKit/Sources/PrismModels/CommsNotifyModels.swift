import Foundation

// Comms read state + notifications (Sprint Task 1). Mirrors apps/server/src/comms/notify-settings.ts
// and routes/comms-notify.ts.

/// A folder's notification rule (`settings.folders[<folderId>]`). `.default` is the absence of a
/// rule: the folder follows the status and network switches. Precedence on the server: thread
/// Mute > `.off` ("None") > `.all` > status / network rules; spam never notifies.
/// (`.off`, not `.none`: `.none` on an Optional means nil.)
public enum CommsFolderNotify: String, Codable, Hashable, Sendable, CaseIterable {
    case `default`, all
    case off = "none"

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = CommsFolderNotify(rawValue: raw) ?? .default
    }
}

/// The owner's notification + read-receipt settings (`GET/PUT /api/comms/notifications/settings`).
/// Defaults (D18): only Needs attention (urgent + action-required) notifies; every other triage
/// status is a switch, off by default. Strangers and spam never notify (a folder set to "All
/// Messages" lets strangers through, never spam). Full previews by default. Read receipts +
/// typing (D10): off.
public struct CommsNotifySettings: Codable, Hashable, Sendable {
    public struct Statuses: Codable, Hashable, Sendable {
        public var urgent: Bool
        public var actionRequired: Bool
        public var informational: Bool
        public var low: Bool
        public var social: Bool
        /// Prism's `triaged` tag ("Reviewed").
        public var triaged: Bool
        public var handled: Bool
        /// Not yet sorted (no tag yet, or the classifier failed).
        public var unclassified: Bool

        enum CodingKeys: String, CodingKey {
            case urgent
            case actionRequired = "action-required"
            case informational, low, social, triaged, handled, unclassified
        }

        public init(urgent: Bool = true, actionRequired: Bool = true, informational: Bool = false, low: Bool = false, social: Bool = false,
                    triaged: Bool = false, handled: Bool = false, unclassified: Bool = false) {
            self.urgent = urgent
            self.actionRequired = actionRequired
            self.informational = informational
            self.low = low
            self.social = social
            self.triaged = triaged
            self.handled = handled
            self.unclassified = unclassified
        }

        /// An older server sends only some keys: the missing ones read as their defaults.
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            let d = Statuses()
            urgent = try c.decodeIfPresent(Bool.self, forKey: .urgent) ?? d.urgent
            actionRequired = try c.decodeIfPresent(Bool.self, forKey: .actionRequired) ?? d.actionRequired
            informational = try c.decodeIfPresent(Bool.self, forKey: .informational) ?? d.informational
            low = try c.decodeIfPresent(Bool.self, forKey: .low) ?? d.low
            social = try c.decodeIfPresent(Bool.self, forKey: .social) ?? d.social
            triaged = try c.decodeIfPresent(Bool.self, forKey: .triaged) ?? d.triaged
            handled = try c.decodeIfPresent(Bool.self, forKey: .handled) ?? d.handled
            unclassified = try c.decodeIfPresent(Bool.self, forKey: .unclassified) ?? d.unclassified
        }

        /// The server key of each switch, in the order Settings lists them.
        public static var keys: [(key: String, path: WritableKeyPath<Statuses, Bool>)] {
            [("urgent", \.urgent), ("action-required", \.actionRequired), ("informational", \.informational), ("low", \.low),
             ("social", \.social), ("triaged", \.triaged), ("handled", \.handled), ("unclassified", \.unclassified)]
        }
    }

    public var enabled: Bool
    public var statuses: Statuses
    /// Network wire name → false = never notify for it. Missing = on.
    public var networks: [String: Bool]
    public var knownPeopleImmediately: Bool
    /// Lock-screen privacy: "New message" only — no sender, no text.
    public var hidePreviews: Bool
    public var readReceipts: Bool
    public var readReceiptsByNetwork: [String: Bool]
    /// Owner folder id → its rule; a folder not listed is `.default`.
    public var folders: [String: CommsFolderNotify]

    public init(enabled: Bool = true, statuses: Statuses = Statuses(), networks: [String: Bool] = [:], knownPeopleImmediately: Bool = true,
                hidePreviews: Bool = false, readReceipts: Bool = false, readReceiptsByNetwork: [String: Bool] = [:],
                folders: [String: CommsFolderNotify] = [:]) {
        self.enabled = enabled
        self.statuses = statuses
        self.networks = networks
        self.knownPeopleImmediately = knownPeopleImmediately
        self.hidePreviews = hidePreviews
        self.readReceipts = readReceipts
        self.readReceiptsByNetwork = readReceiptsByNetwork
        self.folders = folders.filter { $0.value != .default }
    }

    enum CodingKeys: String, CodingKey {
        case enabled, statuses, networks, knownPeopleImmediately, hidePreviews, readReceipts, readReceiptsByNetwork, folders
    }

    /// Missing keys (an older server) read as the defaults.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = CommsNotifySettings()
        enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? d.enabled
        statuses = try c.decodeIfPresent(Statuses.self, forKey: .statuses) ?? d.statuses
        networks = try c.decodeIfPresent([String: Bool].self, forKey: .networks) ?? [:]
        knownPeopleImmediately = try c.decodeIfPresent(Bool.self, forKey: .knownPeopleImmediately) ?? d.knownPeopleImmediately
        hidePreviews = try c.decodeIfPresent(Bool.self, forKey: .hidePreviews) ?? d.hidePreviews
        readReceipts = try c.decodeIfPresent(Bool.self, forKey: .readReceipts) ?? d.readReceipts
        readReceiptsByNetwork = try c.decodeIfPresent([String: Bool].self, forKey: .readReceiptsByNetwork) ?? [:]
        folders = (try c.decodeIfPresent([String: CommsFolderNotify].self, forKey: .folders) ?? [:]).filter { $0.value != .default }
    }

    /// A folder's rule (`.default` when none is set).
    public func notify(folder id: String) -> CommsFolderNotify { folders[id] ?? .default }

    public static let defaults = CommsNotifySettings()

    /// Is this network switched on (missing = on)?
    public func notifies(network: CommsNetwork) -> Bool { networks[network.wire] ?? true }
    public func receipts(network: CommsNetwork) -> Bool { readReceiptsByNetwork[network.wire] ?? readReceipts }
}

/// A partial settings change: only the keys that differ (nil = untouched; maps hold only the
/// changed entries). Encodes without the nil keys.
public struct CommsNotifySettingsPatch: Codable, Hashable, Sendable {
    public var enabled: Bool?
    /// Server keys ("urgent", "action-required", "informational", "unclassified").
    public var statuses: [String: Bool]?
    public var networks: [String: Bool]?
    public var knownPeopleImmediately: Bool?
    public var hidePreviews: Bool?
    public var readReceipts: Bool?
    public var readReceiptsByNetwork: [String: Bool]?
    /// Folder id → "default" | "all" | "none" ("default" removes the folder's rule).
    public var folders: [String: CommsFolderNotify]?

    public init() {}

    public var isEmpty: Bool { self == CommsNotifySettingsPatch() }

    /// What changed from `old` to `new`.
    public static func diff(from old: CommsNotifySettings, to new: CommsNotifySettings) -> CommsNotifySettingsPatch {
        var p = CommsNotifySettingsPatch()
        if old.enabled != new.enabled { p.enabled = new.enabled }
        var st: [String: Bool] = [:]
        for (key, path) in CommsNotifySettings.Statuses.keys where old.statuses[keyPath: path] != new.statuses[keyPath: path] {
            st[key] = new.statuses[keyPath: path]
        }
        if !st.isEmpty { p.statuses = st }
        var fo: [String: CommsFolderNotify] = [:]
        for k in Set(old.folders.keys).union(new.folders.keys) where old.notify(folder: k) != new.notify(folder: k) {
            fo[k] = new.notify(folder: k)
        }
        if !fo.isEmpty { p.folders = fo }
        func mapDiff(_ a: [String: Bool], _ b: [String: Bool]) -> [String: Bool]? {
            var out: [String: Bool] = [:]
            for k in Set(a.keys).union(b.keys) where (a[k] ?? true) != (b[k] ?? true) {
                out[k] = b[k] ?? true
            }
            return out.isEmpty ? nil : out
        }
        p.networks = mapDiff(old.networks, new.networks)
        if old.knownPeopleImmediately != new.knownPeopleImmediately { p.knownPeopleImmediately = new.knownPeopleImmediately }
        if old.hidePreviews != new.hidePreviews { p.hidePreviews = new.hidePreviews }
        if old.readReceipts != new.readReceipts { p.readReceipts = new.readReceipts }
        // A removed per-network override cannot be expressed as a merge; it is sent as the global value.
        var rr: [String: Bool] = [:]
        for k in Set(old.readReceiptsByNetwork.keys).union(new.readReceiptsByNetwork.keys) where old.readReceiptsByNetwork[k] != new.readReceiptsByNetwork[k] {
            rr[k] = new.readReceiptsByNetwork[k] ?? new.readReceipts
        }
        if !rr.isEmpty { p.readReceiptsByNetwork = rr }
        return p
    }
}

/// What the server can actually do: push needs COMMS_NOTIFY_ENABLED + APNs; receipts need
/// COMMS_READ_RECEIPTS_ENABLED. A toggle the server cannot honour is shown with a footnote.
public struct CommsNotifyAvailability: Codable, Hashable, Sendable {
    public var push: Bool
    public var readReceipts: Bool
    public init(push: Bool, readReceipts: Bool) {
        self.push = push
        self.readReceipts = readReceipts
    }
}

public struct CommsNotifySettingsResponse: Codable, Hashable, Sendable {
    public var settings: CommsNotifySettings
    public var available: CommsNotifyAvailability
    /// The owner's registered Comms devices and what APNs last answered for each (owner-testing
    /// round 4). nil from an older server.
    public var devices: [CommsPushDevice]?
    public init(settings: CommsNotifySettings, available: CommsNotifyAvailability, devices: [CommsPushDevice]? = nil) {
        self.settings = settings
        self.available = available
        self.devices = devices
    }
}

/// One Comms device registered for push: platform, APNs environment and the last answer from
/// Apple (status + reason; never the token).
public struct CommsPushDevice: Codable, Hashable, Sendable {
    public struct Delivery: Codable, Hashable, Sendable {
        /// The HTTP status APNs answered (nil = no answer: timeout, network, not configured).
        public var status: Int?
        /// Apple's reason (`BadDeviceToken`, `BadEnvironmentKeyInToken`, …), "" on success.
        public var reason: String
        /// sent | pruned | failed
        public var outcome: String
        public var at: Date
        public init(status: Int?, reason: String, outcome: String, at: Date) {
            self.status = status
            self.reason = reason
            self.outcome = outcome
            self.at = at
        }
    }
    /// ios | macos
    public var platform: String
    /// sandbox | production
    public var environment: String
    public var thisDevice: Bool
    public var registeredAt: Date?
    public var lastSeenAt: Date?
    public var lastDelivery: Delivery?
    public init(platform: String, environment: String, thisDevice: Bool, registeredAt: Date? = nil, lastSeenAt: Date? = nil, lastDelivery: Delivery? = nil) {
        self.platform = platform
        self.environment = environment
        self.thisDevice = thisDevice
        self.registeredAt = registeredAt
        self.lastSeenAt = lastSeenAt
        self.lastDelivery = lastDelivery
    }
}

/// `POST /notifications/test` → the devices with their fresh answers.
public struct CommsPushTestResult: Codable, Hashable, Sendable {
    public var devices: [CommsPushDevice]
    public init(devices: [CommsPushDevice]) { self.devices = devices }
}

/// `POST /threads/:id/read` → the thread as it is now and whether a network receipt was sent.
public struct CommsReadResult: Codable, Hashable, Sendable {
    /// sent | off | unsupported | nothing | failed
    public var receipt: String
    public var thread: CommsThread?
}

/// `POST /threads/:id/unread`.
public struct CommsUnreadResult: Codable, Hashable, Sendable {
    public var thread: CommsThread?
}

/// `GET /threads/status-counts` (unread added in Sprint Task 1; nil from an older server).
public struct CommsStatusCounts: Codable, Hashable, Sendable {
    public struct Unread: Codable, Hashable, Sendable {
        public var threads: Int
        /// Unread threads that Need attention — the app badge.
        public var attention: Int
        public init(threads: Int, attention: Int) {
            self.threads = threads
            self.attention = attention
        }
    }
    public var folder: String
    public var counts: [String: Int]
    public var attention: Int
    public var unread: Unread?
}

public enum CommsPushEnvironment: String, Codable, Sendable { case sandbox, production }
public enum CommsPushPlatform: String, Codable, Sendable { case ios, macos }

public struct CommsPushRegistration: Codable, Hashable, Sendable {
    public var ok: Bool
    /// The server will actually push (flag on + APNs configured).
    public var pushEnabled: Bool
    public init(ok: Bool, pushEnabled: Bool) {
        self.ok = ok
        self.pushEnabled = pushEnabled
    }
}
