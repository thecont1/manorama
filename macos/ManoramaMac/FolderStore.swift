import Foundation

/// The durable record of which folders the user has granted access to.
///
/// Stored as JSON under Application Support, one entry per folder, each
/// carrying its security-scoped bookmark. The bookmark is the grant; the
/// path beside it is a convenience for display only and is re-derived from
/// the bookmark whenever it resolves.
///
/// Nothing here is a path the app trusts for access. Access is always
/// requested through `startAccessingSecurityScopedResource()` on a URL
/// resolved from the bookmark — the same rule the Tauri shell enforces
/// with its picker-provenance file, but with the system's own token
/// instead of a self-issued one.
final class FolderStore: ObservableObject {
    /// One remembered folder.
    struct Entry: Codable, Identifiable, Hashable {
        var id: UUID
        var name: String
        /// Bookmark data — base64 in JSON.
        var bookmark: String
        /// Whether the folder is still reachable. Recomputed on load.
        var isAvailable: Bool = true
        /// The source kind, kept so the UI can label it without re-stat'ing.
        var sourceKind: String = "folder"
    }

    @Published private(set) var entries: [Entry] = []

    private let fileURL: URL

    init(fileURL: URL? = nil) {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
        let dir = base.appendingPathComponent("in.thecontrarian.manorama.mac", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        self.fileURL = fileURL ?? dir.appendingPathComponent("folders.json")
        load()
    }

    // MARK: - Persistence

    private func load() {
        guard let data = try? Data(contentsOf: fileURL) else { return }
        let decoder = JSONDecoder()
        guard var decoded = try? decoder.decode([Entry].self, from: data) else { return }
        // Availability is runtime truth, not stored truth: a folder can be
        // ejected while the app is closed.
        for index in decoded.indices {
            decoded[index].isAvailable = resolve(decoded[index]) != nil
        }
        entries = decoded
    }

    private func save() {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        guard let data = try? encoder.encode(entries) else { return }
        try? data.write(to: fileURL, options: [.atomic])
    }

    // MARK: - Access

    /// Resolve an entry to a live scoped URL.
    ///
    /// Returns nil when the bookmark no longer resolves — the folder moved
    /// and macOS could not follow it, or the grant was revoked.
    func resolve(_ entry: Entry) -> URL? {
        guard let data = Data(base64Encoded: entry.bookmark) else { return nil }
        guard let (url, _) = ScopedFolder.resolve(data) else { return nil }
        return url
    }

    /// Open a security scope for an entry. The caller must balance it with
    /// `stopAccessingSecurityScopedResource()`.
    ///
    /// `startAccessing` returning false is not fatal — an unsandboxed app
    /// already has access to a user-chosen path, and the system reports
    /// false when no scope is needed.
    func startAccess(_ entry: Entry) -> URL? {
        guard let url = resolve(entry) else { return nil }
        _ = url.startAccessingSecurityScopedResource()
        return url
    }

    /// Add a folder the user just picked in an `NSOpenPanel`.
    func add(folder url: URL) -> Entry? {
        guard let bookmark = try? ScopedFolder.makeBookmark(for: url) else { return nil }
        let entry = Entry(
            id: UUID(),
            name: url.lastPathComponent.isEmpty ? "Folder" : url.lastPathComponent,
            bookmark: bookmark.base64EncodedString(),
            isAvailable: true,
            sourceKind: LocalScanner.classify(root: url).rawValue
        )
        entries.append(entry)
        save()
        return entry
    }

    func remove(_ entry: Entry) {
        entries.removeAll { $0.id == entry.id }
        save()
    }

    /// Re-check every entry after a mount change or a rescan.
    func refreshAvailability() {
        for index in entries.indices {
            entries[index].isAvailable = resolve(entries[index]) != nil
        }
    }

    /// Resolve every entry, returning only the live ones.
    func availableFolders() -> [(entry: Entry, url: URL)] {
        entries.compactMap { entry in
            resolve(entry).map { (entry, $0) }
        }
    }
}
