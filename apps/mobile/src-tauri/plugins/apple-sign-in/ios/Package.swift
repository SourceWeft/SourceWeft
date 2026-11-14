// swift-tools-version:5.3

import PackageDescription

let package = Package(
  name: "tauri-plugin-apple-sign-in",
  platforms: [
    .iOS(.v13)
  ],
  products: [
    .library(
      name: "tauri-plugin-apple-sign-in",
      type: .static,
      targets: ["tauri-plugin-apple-sign-in"])
  ],
  dependencies: [
    // Tauri copies its Swift API next to this package on every build.
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(
      name: "tauri-plugin-apple-sign-in",
      dependencies: [
        .byName(name: "Tauri")
      ],
      path: "Sources")
  ]
)
