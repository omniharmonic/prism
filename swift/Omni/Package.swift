// swift-tools-version: 6.2
// Omni — the native client for Benjamin Life's agent (macOS first, iOS compiling).
// Builds on ../PrismKit. No third-party dependencies.
import PackageDescription

let package = Package(
    name: "Omni",
    platforms: [.macOS(.v26), .iOS(.v26)],
    products: [
        .library(name: "OmniCore", targets: ["OmniCore"]),
        .library(name: "OmniUI", targets: ["OmniUI"]),
        .executable(name: "OmniSmoke", targets: ["OmniSmoke"]),
    ],
    dependencies: [
        .package(path: "../PrismKit"),
    ],
    targets: [
        // View models, stores and navigation state. No SwiftUI; tested with fake clients.
        .target(
            name: "OmniCore",
            dependencies: [
                .product(name: "PrismAuth", package: "PrismKit"),
                .product(name: "PrismTransport", package: "PrismKit"),
                .product(name: "OmniClient", package: "PrismKit"),
            ]
        ),
        // The shared SwiftUI screens. The app target (App/, Omni.xcodeproj) is a thin shell.
        .target(name: "OmniUI", dependencies: ["OmniCore"]),
        // A command-line walk through the same calls the app makes, against the laptop dev
        // gateway only (Scripts/smoke.sh).
        .executableTarget(
            name: "OmniSmoke",
            dependencies: [
                "OmniCore",
                .product(name: "PrismAuth", package: "PrismKit"),
                .product(name: "PrismTransport", package: "PrismKit"),
                .product(name: "OmniClient", package: "PrismKit"),
            ]
        ),
        .testTarget(name: "OmniCoreTests", dependencies: ["OmniCore"]),
    ],
    swiftLanguageModes: [.v6]
)
