// swift-tools-version: 6.2
import PackageDescription
import Foundation
let checkout = ProcessInfo.processInfo.environment["OMNI_FLUIDAUDIO_CHECKOUT"] ?? "/private/tmp/omni-kokoro-fluid-audio"
let package = Package(name: "KokoroWorker", platforms: [.macOS(.v26)],
    dependencies: [.package(path: checkout, traits: [])],
    targets: [.executableTarget(name: "KokoroWorker", dependencies: [.product(name: "FluidAudio", package: "omni-kokoro-fluid-audio")])])
