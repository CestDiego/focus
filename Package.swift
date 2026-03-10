// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "Focus",
    platforms: [.macOS(.v13)],
    dependencies: [
        .package(url: "https://github.com/groue/GRDB.swift.git", from: "6.24.0")
    ],
    targets: [
        .executableTarget(
            name: "Focus",
            dependencies: [
                .product(name: "GRDB", package: "GRDB.swift")
            ]
        )
    ]
)
