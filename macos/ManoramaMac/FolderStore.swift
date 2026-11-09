import Foundation

/// The folders the media handler answers for.
///
/// The set changes when the user picks a folder — rarely. The media
/// handler asks about it for every photograph it serves — constantly.
/// So the list is computed once, on the main actor, and read from
/// whichever thread the request arrived on. Computing it per request meant
/// re-reading `roots.json` and re-resolving a security-scoped bookmark
/// for every single image, which is what a photograph gallery should
/// never be paying for.
final class GrantedRoots: @unchecked Sendable {
    private let lock = NSLock()
    private var roots: [URL] = []

    /// Replace the whole set.
    func replace(_ next: [URL]) {
        lock.lock()
        roots = next
        lock.unlock()
    }

    /// The roots as they stand right now.
    func all() -> [URL] {
        lock.lock()
        defer { lock.unlock() }
        return roots
    }
}

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
    ///
    /// This is a pure read, and it stays one: `resolve` is called from the
    /// media handler's queue for every photograph the shell serves, so a
    /// write in here would mutate published state off the main thread.
    /// Stale bookmarks are renewed by `renewStaleBookmarks()`.
    func resolve(_ entry: Entry) -> URL? {
        guard let data = Data(base64Encoded: entry.bookmark) else { return nil }
        guard let (url, _) = ScopedFolder.resolve(data) else { return nil }
        return url
    }

    /// Renew the bookmarks of folders that have moved.
    ///
    /// A stale bookmark still resolves — the folder works — but macOS
    /// charges for resolving it on every later launch. The renewal is a
    /// write, so it happens here, in one pass, rather than inside `resolve`.
    func renewStaleBookmarks() {
        var changed = false
        for index in entries.indices {
            guard let data = Data(base64Encoded: entries[index].bookmark),
                  let (url, stale) = ScopedFolder.resolve(data),
                  stale,
                  let fresh = try? ScopedFolder.makeBookmark(for: url) else { continue }
            entries[index].bookmark = fresh.base64EncodedString()
            changed = true
        }
        if changed { save() }
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
        renewStaleBookmarks()
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

    /// Every granted root, resolved.
    ///
    /// The bridge needs this to decide whether a path the page named is one
    /// the user actually granted. A root that no longer resolves is not
    /// granted, so it is not listed.
    func grantedRoots() -> [URL] {
        entries.compactMap { resolve($0) }
    }

    /// Take the security scope for a root the user has already chosen.
    ///
    /// The path is only a lookup key: the grant is the bookmark, and a path
    /// that matches no bookmark grants nothing. Returns the scoped URL when
    /// the root was known.
    @discardableResult
    func grantIfKnown(_ path: String) -> URL? {
        let wanted = URL(fileURLWithPath: path).standardizedFileURL
        for entry in entries {
            guard let url = resolve(entry),
                  url.standardizedFileURL == wanted else { continue }
            _ = url.startAccessingSecurityScopedResource()
            return url
        }
        return nil
    }
}
