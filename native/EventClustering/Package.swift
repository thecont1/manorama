// swift-tools-version:5.9

/*
 * The event-clustering core, as a package so its unit tests run headless
 * with `swift test` on any machine that has a toolchain — no simulator,
 * no signing, no window.
 *
 * The app builds do NOT consume this manifest. `scripts/build-macos.sh`
 * compiles the Swift files under `Sources/ManoramaEventClustering` straight
 * into the shell binary, and the iOS project references the same files, which is
 * how the two platforms keep one clustering engine rather than two
 * dialects of it. The package exists for the tests; the source list is
 * the contract.
 *
 * Foundation only, deliberately: the grouping of a chronological camera
 * dump is a spatiotemporal problem, and every dependency added here is a
 * dependency the Rust and TypeScript ports would have to answer for.
 */

import PackageDescription

let package = Package(
    name: "ManoramaEventClustering",
    platforms: [
        // Floors below the apps' own targets on purpose: this manifest only
        // has to build and run the tests, and the deployment target that
        // matters is set by `scripts/build-macos.sh` and the iOS project.
        .macOS(.v13),
        .iOS(.v16),
    ],
    products: [
        .library(name: "ManoramaEventClustering", targets: ["ManoramaEventClustering"]),
    ],
    targets: [
        .target(
            name: "ManoramaEventClustering",
            path: "Sources/ManoramaEventClustering"
        ),
        .testTarget(
            name: "EventClusteringTests",
            dependencies: ["ManoramaEventClustering"],
            path: "Tests/EventClusteringTests"
        ),
    ]
)
