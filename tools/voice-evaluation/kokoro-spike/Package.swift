// swift-tools-version: 6.2
import PackageDescription
import Foundation
let checkout = ProcessInfo.processInfo.environment["OMNI_FLUIDAUDIO_CHECKOUT"] ?? "/private/tmp/omni-kokoro-fluid-audio"
let package = Package(name: "KokoroSpike", platforms: [.macOS(.v26)],
    dependencies: [.package(path: checkout, traits: [])],
    targets: [.executableTarget(name: "KokoroSpike", dependencies: [.product(name: "FluidAudio", package: "omni-kokoro-fluid-audio")])])
