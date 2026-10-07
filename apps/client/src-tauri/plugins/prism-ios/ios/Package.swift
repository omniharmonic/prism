// swift-tools-version:5.7
import PackageDescription

let package = Package(
  name: "tauri-plugin-prism-ios",
  platforms: [
    .iOS(.v16)
  ],
  products: [
    .library(
      name: "tauri-plugin-prism-ios",
      type: .static,
      targets: ["tauri-plugin-prism-ios"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(
      name: "tauri-plugin-prism-ios",
      dependencies: [
        .byName(name: "Tauri")
      ],
      path: "Sources")
  ]
)
