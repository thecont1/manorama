import Foundation

/// A folder the user granted access to, remembered across launches.
///
/// The Mac's answer to "re-open the folder you picked last week" is a
/// **security-scoped bookmark** — a token the system issues when the user
/// picks a folder, which survives relaunch and re-grants access even under
/// the App Sandbox. The Tauri shell instead records the *path* in
/// `roots.json` and re-grants the runtime scope, which only works because
/// that app is not sandboxed: under the sandbox a plain path grants nothing.
///
/// This type is the boundary seam. It stores the bookmark, resolves it on
/// launch, and hands out a scoped URL whose access must be balanced by
/// `stopAccessingSecurityScopedResource()`.
struct ScopedFolder: Identifiable, Hashable {
    let id: UUID
    let name: String
    let url: URL
    /// The bookmark data — the only durable record of the grant.
    let bookmark: Data

    /// Resolve a bookmark to a live, security-scoped URL.
    ///
    /// `stale` comes back true when the folder has moved since the
    /// bookmark was made; the bookmark itself is still usable, and the
    /// caller should re-save the fresh one so the next launch is quiet.
    static func resolve(_ bookmark: Data) -> (url: URL, stale: Bool)? {
        var stale = false
        var error: Unmanaged<CFError>?
        guard let url = try? URL(
            resolvingBookmarkData: bookmark,
            options: [.withSecurityScope],
            relativeTo: nil,
            bookmarkDataIsStale: &stale
        ) else { return nil }
        return (url, stale)
    }

    /// Ask the system for a bookmark for a URL the user just picked.
    static func makeBookmark(for url: URL) throws -> Data {
        try url.bookmarkData(
            options: [.withSecurityScope],
            includingResourceValuesForKeys: nil,
            relativeTo: nil
        )
    }
}

/// One gallery's metadata, derived from a folder at scan time.
struct LocalGallery: Identifiable, Hashable {
    let id: UUID
    let title: String
    /// Count of media files found — metadata only, never the bytes.
    let itemCount: Int
    /// Where the gallery came from: a folder on the Mac or a mounted card.
    let sourceKind: SourceKind

    enum SourceKind: String, Hashable {
        case folder
        case card

        var label: String { self == .card ? "Memory card" : "Folder on this Mac" }
    }
}

/// The native scanner — the Swift counterpart of `desktop/lib/local-scan.ts`.
///
/// Same contract, deliberately: read the root and exactly one level of
/// subdirectories, keep a deterministic order, and reference the originals
/// in place. Nothing is copied, moved, renamed or deleted, and no byte is
/// re-encoded. The manifest is metadata only.
enum LocalScanner {
    /// Formats the viewer can decode in a WKWebView. RAW and TIFF are out
    /// of scope for the same reason they are out of scope in the Tauri
    /// shell: listing a format the renderer cannot decode produces a dead
    /// frame.
    static let imageExtensions: Set<String> = [
        "jpg", "jpeg", "png", "webp", "avif", "heic", "heif",
    ]

    /// One referenced original. The path never leaves the device.
    struct Item: Hashable {
        /// Relative path inside the root — the stable id across rescans.
        let id: String
        let name: String
        let url: URL
    }

    static func isImageName(_ name: String) -> Bool {
        guard !name.hasPrefix(".") else { return false }
        let ext = (name as NSString).pathExtension.lowercased()
        return imageExtensions.contains(ext)
    }

    /// Scan the root and one level of subdirectories.
    ///
    /// Deep enough for `DCIM/<camera>/` layouts on a card, shallow enough
    /// that picking a large tree never becomes a filesystem crawl.
    static func scan(root: URL) -> [Item] {
        var collected: [Item] = []

        guard let entries = try? FileManager.default.contentsOfDirectory(
            at: root,
            includingPropertiesForKeys: [.isDirectoryKey, .isRegularFileKey],
            options: [.skipsHiddenFiles]
        ) else { return [] }

        for entry in entries {
            let values = try? entry.resourceValues(forKeys: [.isDirectoryKey, .isRegularFileKey])
            if values?.isRegularFile == true, isImageName(entry.lastPathComponent) {
                collected.append(Item(id: entry.lastPathComponent, name: entry.lastPathComponent, url: entry))
            }
        }

        // One level of subdirectories, in natural collation so IMG_2
        // precedes IMG_10.
        let subdirs = entries
            .filter { entry in
                let values = try? entry.resourceValues(forKeys: [.isDirectoryKey])
                return values?.isDirectory == true && !entry.lastPathComponent.hasPrefix(".")
            }
            .sorted { $0.lastPathComponent.localizedStandardCompare($1.lastPathComponent) == .orderedAscending }

        for subdir in subdirs {
            guard let children = try? FileManager.default.contentsOfDirectory(
                at: subdir,
                includingPropertiesForKeys: [.isRegularFileKey],
                options: [.skipsHiddenFiles]
            ) else { continue }
            for child in children {
                let values = try? child.resourceValues(forKeys: [.isRegularFileKey])
                guard values?.isRegularFile == true, isImageName(child.lastPathComponent) else { continue }
                let relative = "\(subdir.lastPathComponent)/\(child.lastPathComponent)"
                collected.append(Item(id: relative, name: child.lastPathComponent, url: child))
            }
        }

        // One deterministic order: relative path, natural collation, so a
        // rescan preserves positions for surviving files.
        return collected.sorted { $0.id.localizedStandardCompare($1.id) == .orderedAscending }
    }

    /// A card is a mount under /Volumes that is not the boot volume.
    static func classify(root: URL) -> LocalGallery.SourceKind {
        let volumes = URL(fileURLWithPath: "/Volumes")
        let parent = root.deletingLastPathComponent()
        guard parent.path.hasPrefix(volumes.path) else { return .folder }
        return .card
    }
}
