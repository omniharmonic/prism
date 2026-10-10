// swift-tools-version: 6.2
import PackageDescription
let package = Package(
    name: "OmniVoiceKit", platforms: [.iOS(.v26), .macOS(.v26)],
    products: [.library(name: "OmniVoiceKit", targets: ["OmniVoiceKit"])],
    dependencies: [.package(url: "https://github.com/FluidInference/FluidAudio.git", exact: "0.17.7", traits: [])],
    targets: [
        .target(name: "OmniVoiceKit", dependencies: [.product(name: "FluidAudio", package: "FluidAudio")]),
        .testTarget(name: "OmniVoiceKitTests", dependencies: ["OmniVoiceKit"])
    ], swiftLanguageModes: [.v6])
