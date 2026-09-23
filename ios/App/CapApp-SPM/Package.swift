// swift-tools-version: 5.9
import PackageDescription

// DO NOT MODIFY THIS FILE - managed by Capacitor CLI commands
let package = Package(
    name: "CapApp-SPM",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "CapApp-SPM",
            targets: ["CapApp-SPM"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.5.2"),
        .package(name: "AparajitaCapacitorSecureStorage", path: "../../../../manorama/node_modules/@aparajita/capacitor-secure-storage"),
        .package(name: "CapacitorCommunityAdmob", path: "../../../../manorama/node_modules/@capacitor-community/admob"),
        .package(name: "CapacitorApp", path: "../../../../manorama/node_modules/@capacitor/app"),
        .package(name: "CapacitorBrowser", path: "../../../../manorama/node_modules/@capacitor/browser"),
        .package(name: "CapacitorFilesystem", path: "../../../../manorama/node_modules/@capacitor/filesystem"),
        .package(name: "CapacitorPreferences", path: "../../../../manorama/node_modules/@capacitor/preferences"),
        .package(name: "CapacitorShare", path: "../../../../manorama/node_modules/@capacitor/share"),
        .package(name: "CapacitorSplashScreen", path: "../../../../manorama/node_modules/@capacitor/splash-screen"),
        .package(name: "CapacitorStatusBar", path: "../../../../manorama/node_modules/@capacitor/status-bar"),
        .package(name: "RevenuecatPurchasesCapacitor", path: "../../../../manorama/node_modules/@revenuecat/purchases-capacitor"),
        .package(name: "RevenuecatPurchasesCapacitorUi", path: "../../../../manorama/node_modules/@revenuecat/purchases-capacitor-ui")
    ],
    targets: [
        .target(
            name: "CapApp-SPM",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                .product(name: "AparajitaCapacitorSecureStorage", package: "AparajitaCapacitorSecureStorage"),
                .product(name: "CapacitorCommunityAdmob", package: "CapacitorCommunityAdmob"),
                .product(name: "CapacitorApp", package: "CapacitorApp"),
                .product(name: "CapacitorBrowser", package: "CapacitorBrowser"),
                .product(name: "CapacitorFilesystem", package: "CapacitorFilesystem"),
                .product(name: "CapacitorPreferences", package: "CapacitorPreferences"),
                .product(name: "CapacitorShare", package: "CapacitorShare"),
                .product(name: "CapacitorSplashScreen", package: "CapacitorSplashScreen"),
                .product(name: "CapacitorStatusBar", package: "CapacitorStatusBar"),
                .product(name: "RevenuecatPurchasesCapacitor", package: "RevenuecatPurchasesCapacitor"),
                .product(name: "RevenuecatPurchasesCapacitorUi", package: "RevenuecatPurchasesCapacitorUi")
            ]
        )
    ]
)
