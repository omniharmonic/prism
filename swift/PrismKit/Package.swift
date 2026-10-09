// swift-tools-version: 6.0
// PrismKit — the shared Swift package under the Omni app (macOS + iOS).
// Benjamin Life. No third-party dependencies.
import PackageDescription

let package = Package(
    name: "PrismKit",
    platforms: [.macOS(.v14), .iOS(.v17)],
    products: [
        .library(name: "PrismKit", targets: ["PrismAuth", "PrismTransport", "PrismSSE", "PrismModels", "OmniClient"]),
        .library(name: "PrismAuth", targets: ["PrismAuth"]),
        .library(name: "PrismTransport", targets: ["PrismTransport"]),
        .library(name: "PrismSSE", targets: ["PrismSSE"]),
        .library(name: "PrismModels", targets: ["PrismModels"]),
        .library(name: "OmniClient", targets: ["OmniClient"]),
    ],
    targets: [
        .target(name: "PrismAuth"),
        .target(name: "PrismTransport", dependencies: ["PrismAuth", "PrismModels"]),
        .target(name: "PrismSSE"),
        .target(name: "PrismModels"),
        .target(name: "OmniClient", dependencies: ["PrismTransport", "PrismSSE", "PrismModels"]),

        .target(name: "PrismTestSupport", dependencies: ["PrismAuth"], path: "Tests/PrismTestSupport"),
        .testTarget(name: "PrismAuthTests", dependencies: ["PrismAuth", "PrismTestSupport"]),
        .testTarget(name: "PrismTransportTests", dependencies: ["PrismTransport", "PrismTestSupport"]),
        .testTarget(name: "PrismSSETests", dependencies: ["PrismSSE"]),
        .testTarget(name: "PrismModelsTests", dependencies: ["PrismModels"], resources: [.copy("Fixtures")]),
        .testTarget(name: "OmniClientTests", dependencies: ["OmniClient", "PrismTestSupport"]),
    ],
    swiftLanguageModes: [.v6]
)
