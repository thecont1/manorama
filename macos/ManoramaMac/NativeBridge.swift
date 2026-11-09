import AppKit
import Foundation
import Security
import WebKit

/// The native shell's implementation of the desktop bundle's runtime API.
///
/// The Library is the desktop bundle, unchanged, and that bundle is written
/// against Tauri's runtime. Tauri's JavaScript surface is thin — every
/// machine-touching call goes through `invoke` — so the shell answers the
/// same commands here and the app's code stays exactly one implementation.
///
/// The rules the Tauri build already follows are kept:
///
/// - the renderer never supplies a path that is not inside a root the user
///   picked, and
/// - the private files are a fixed allowlist, not a general write primitive.
///
/// The vault's storage and its keys live here rather than in JavaScript:
/// ciphertext without the Keychain keys is dead bytes, which is what keeps a
/// saved gallery viewable only inside this app.
@MainActor
final class NativeBridge {
    /// The live webview, so an answer can be handed back to the page.
    weak var webView: WKWebView?

    /// The roots the user has granted, and the picker that asks for more.
    private let folderStore: FolderStore

    /// Where the app's private documents and the vault live.
    ///
    /// The same directory the Tauri build uses, deliberately: the session,
    /// the local catalogue and the vault are one app's state, and a user who
    /// signs in once and saves a gallery offline should find both in the
    /// other shell.
    private let configDir: URL

    /// The vault's ciphertext root.
    private let vaultRoot: URL

    /// The Keychain service the per-gallery keys live under.
    private static let keychainService = "in.thecontrarian.manorama.vault"

    /// The private documents the renderer may read and write.
    ///
    /// A fixed allowlist, never a caller-supplied path — the same list the
    /// Tauri build keeps.
    private static let privateFiles: Set<String> = ["session.json", "catalogue.json", "providers.json"]

    /// The logical prefix the vault's own paths carry.
    private static let vaultDirName = "manorama-vault-v1"

    /// The label this Mac reports to the account.
    private let deviceLabel: String
    /// The folder a test run hands back instead of asking for one.
    private var seededPickPath: String?

    /// The cached picker-approved roots, and the lock that guards them.
    private var cachedRoots: [String]?
    private let rootsLock = NSLock()

    /// The folders the user has granted, shared with the media handler.
    private let grantedRoots: GrantedRoots

    init(folderStore: FolderStore, grantedRoots: GrantedRoots, configDir: URL? = nil) {
        self.folderStore = folderStore
        self.grantedRoots = grantedRoots
        let resolved = configDir ?? Self.defaultConfigDir()
        self.configDir = resolved
        self.vaultRoot = resolved.appendingPathComponent(Self.vaultDirName, isDirectory: true)
        self.deviceLabel = Host.current().localizedName ?? "This Mac"

        // `--seed-folder <path>` both answers the picker and tells the app
        // to add that folder at launch.
        let arguments = CommandLine.arguments
        if let index = arguments.firstIndex(of: "--seed-folder"), index + 1 < arguments.count {
            seededPickPath = arguments[index + 1]
        }
    }

    /// The folder a test run asked to be added, if any.
    static var seededFolder: String? {
        let arguments = CommandLine.arguments
        guard let index = arguments.firstIndex(of: "--seed-folder"), index + 1 < arguments.count else { return nil }
        return arguments[index + 1]
    }

    /// The app's private directory — the Tauri build's, so the two shells
    /// share one account, one catalogue and one vault.
    static func defaultConfigDir() -> URL {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
        return support.appendingPathComponent("in.thecontrarian.manorama.desktop", isDirectory: true)
    }

    // MARK: - The channel

    /// Answer one command from the page.
    ///
    /// The command runs off the main actor where it touches the disk: a
    /// vault record is megabytes, and the window must not stall while one
    /// is written. The picker is the exception — a panel has to be on the
    /// main thread.
    func handle(_ body: [String: Any]) {
        guard let type = body["type"] as? String, type == "invoke" else { return }
        guard let id = body["id"] as? Int else { return }
        let cmd = body["cmd"] as? String ?? ""
        let args = body["args"] as? [String: Any] ?? [:]
        let headers = body["headers"] as? [String: String] ?? [:]

        Task { [weak self] in
            guard let self else { return }
            do {
                let value = try await self.run(cmd, args: args, headers: headers)
                Trace.log("invoke \(cmd) → ok")
                self.reply(id: id, ok: true, value: value)
            } catch {
                Trace.log("invoke \(cmd) → error \(error.localizedDescription)")
                self.reply(id: id, ok: false, error: error.localizedDescription)
            }
        }
    }

    /// Hand the answer back to the page.
    private func reply(id: Int, ok: Bool, value: Any? = nil, error: String? = nil) {
        var payload: [String: Any] = ["id": id, "ok": ok]
        if let value { payload["value"] = value }
        if let error { payload["error"] = error }
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        webView?.evaluateJavaScript("window.__manoramaShellSettle && window.__manoramaShellSettle(\(json));")
    }

    // MARK: - Commands

    /// Run one command. The names are Tauri's, so the bundle needs no fork.
    private func run(_ cmd: String, args: [String: Any], headers: [String: String]) async throws -> Any? {
        switch cmd {
        case "device_label":
            return deviceLabel

        case "read_private_file":
            let name = try privateName(args)
            return try readPrivateFile(name)
        case "write_private_file":
            let name = try privateName(args)
            guard let contents = args["contents"] as? String else {
                throw BridgeError.badArguments("write_private_file needs contents")
            }
            try writePrivateFile(name, contents: contents)
            return nil
        case "delete_private_file":
            let name = try privateName(args)
            try deletePrivateFile(name)
            return nil

        case "pick_gallery_root":
            return try pickGalleryRoot()
        case "register_saved_gallery_roots":
            try registerSavedGalleryRoots()
            return nil

        case "plugin:fs|exists":
            let path = try grantedPath(args)
            return FileManager.default.fileExists(atPath: path.path)
        case "plugin:fs|read_dir":
            return try readDir(args)
        case "plugin:fs|read_file":
            return try await readFile(args)

        case "vault_read":
            let path = try vaultPath(args["path"] as? String ?? "")
            let data = try await offMain { try? Data(contentsOf: path) }
            guard let data else { return NSNull() }
            return ["__bytes": data.base64EncodedString()]
        case "vault_write":
            let path = try vaultPath(headers["x-vault-path"] ?? "")
            guard let bytes = decodeBytes(args) else {
                throw BridgeError.badArguments("vault_write needs bytes")
            }
            try await offMain { try self.writeVaultFile(path, bytes: bytes) }
            return nil
        case "vault_move":
            let from = try vaultPath(args["from"] as? String ?? "")
            let to = try vaultPath(args["to"] as? String ?? "")
            try await offMain {
                try FileManager.default.createDirectory(at: to.deletingLastPathComponent(), withIntermediateDirectories: true)
                if FileManager.default.fileExists(atPath: to.path) {
                    try FileManager.default.removeItem(at: to)
                }
                try FileManager.default.moveItem(at: from, to: to)
            }
            return nil
        case "vault_remove":
            let path = try vaultPath(args["path"] as? String ?? "")
            try await offMain {
                if FileManager.default.fileExists(atPath: path.path) {
                    try FileManager.default.removeItem(at: path)
                }
                // A resolved delete is not proof of deletion.
                if FileManager.default.fileExists(atPath: path.path) {
                    throw BridgeError.failed("the vault record survived the delete")
                }
            }
            return nil
        case "vault_list":
            return try await offMain { try self.listVault() }
        case "vault_log":
            let line = args["line"] as? String ?? ""
            try appendVaultLog(line)
            return nil

        case "vault_key_get":
            return try keychainGet(args["name"] as? String ?? "")
        case "vault_key_set":
            guard let name = args["name"] as? String, let value = args["value"] as? String else {
                throw BridgeError.badArguments("vault_key_set needs a name and a value")
            }
            try keychainSet(name, value)
            return nil
        case "vault_key_remove":
            try keychainRemove(args["name"] as? String ?? "")
            return nil

        default:
            throw BridgeError.failed("the native shell does not implement \(cmd)")
        }
    }

    // MARK: - Private documents

    private func privateName(_ args: [String: Any]) throws -> String {
        guard let name = args["name"] as? String, Self.privateFiles.contains(name) else {
            throw BridgeError.failed("unknown private file")
        }
        return name
    }

    private func readPrivateFile(_ name: String) throws -> String? {
        let url = configDir.appendingPathComponent(name)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        return try String(contentsOf: url, encoding: .utf8)
    }

    private func writePrivateFile(_ name: String, contents: String) throws {
        let url = configDir.appendingPathComponent(name)
        try FileManager.default.createDirectory(at: configDir, withIntermediateDirectories: true)
        // Write-then-rename, so a crash never leaves half a session behind.
        let tmp = configDir.appendingPathComponent(".\(name).tmp")
        try Data(contents.utf8).write(to: tmp, options: [.atomic])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: tmp.path)
        if FileManager.default.fileExists(atPath: url.path) {
            _ = try FileManager.default.replaceItemAt(url, withItemAt: tmp)
        } else {
            try FileManager.default.moveItem(at: tmp, to: url)
        }
    }

    private func deletePrivateFile(_ name: String) throws {
        let url = configDir.appendingPathComponent(name)
        if FileManager.default.fileExists(atPath: url.path) {
            try FileManager.default.removeItem(at: url)
        }
    }

    // MARK: - Folder grants

    /// Ask the user for a folder and remember the grant.
    @MainActor
    private func pickGalleryRoot() throws -> String? {
        // A test hook: `--seed-folder <path>` answers the picker with that
        // path instead of showing a panel, so the app's own add flow can be
        // exercised end to end without a human at the file dialog. The grant
        // is still made the same way — the path is recorded and bookmarked
        // exactly as a picked folder is.
        if let seeded = seededPickPath {
            seededPickPath = nil
            let url = URL(fileURLWithPath: seeded)
            guard folderStore.add(folder: url) != nil else {
                throw BridgeError.failed("that folder could not be remembered for access")
            }
            recordGalleryRoot(url.path)
            return url.path
        }
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.prompt = "Add"
        panel.message = "Choose a folder of photographs to view in place."

        guard panel.runModal() == .OK, let url = panel.url else { return nil }
        guard folderStore.add(folder: url) != nil else {
            throw BridgeError.failed("that folder could not be remembered for access")
        }
        // The path is the catalogue's record of what the user chose; the
        // grant itself is the bookmark, which only this binary can resolve.
        recordGalleryRoot(url.path)
        return url.path
    }

    /// Re-open the scopes for the roots the user has already chosen.
    ///
    /// Security scopes are runtime state and reset when the app restarts, so
    /// every launch has to take them again. The renderer cannot forge an
    /// entry here: the list comes from the picker-approved roots, never from
    /// the page.
    private func registerSavedGalleryRoots() throws {
        let roots = savedGalleryRoots()
        for root in roots {
            _ = folderStore.grantIfKnown(root)
        }
        // The grant has to be in place before the page's next call, not
        // after the shell's refresh lands: the page asks for the folder it
        // was just told about, and a cache that is a moment behind answers
        // "outside every folder you have granted".
        grantedRoots.replace(grantedRoots.all() + roots.map { URL(fileURLWithPath: $0) })
        onRootsChanged?()
    }

    /// The picker-approved roots, as paths.
    ///
    /// Cached: the fs plugin asks about the roots for every path it is
    /// handed, and re-reading `roots.json` for each one is a cost the app
    /// does not need to pay. The cache is dropped when a root is recorded.
    func savedGalleryRoots() -> [String] {
        rootsLock.lock()
        defer { rootsLock.unlock() }
        if let cached = cachedRoots { return cached }
        let url = configDir.appendingPathComponent("roots.json")
        guard let data = try? Data(contentsOf: url),
              let roots = try? JSONSerialization.jsonObject(with: data) as? [String] else {
            cachedRoots = []
            return []
        }
        cachedRoots = roots
        return roots
    }

    /// Told when the granted roots change, so the shell can refresh what
    /// the media handler answers for.
    var onRootsChanged: (() -> Void)?

    /// Record a picker-approved root.
    private func recordGalleryRoot(_ root: String) {
        var roots = savedGalleryRoots()
        guard !roots.contains(root) else { return }
        roots.append(root)
        guard let data = try? JSONSerialization.data(withJSONObject: roots) else { return }
        try? FileManager.default.createDirectory(at: configDir, withIntermediateDirectories: true)
        let url = configDir.appendingPathComponent("roots.json")
        try? data.write(to: url, options: [.atomic])
        rootsLock.lock()
        cachedRoots = roots
        rootsLock.unlock()
        // The page scans the folder it has just picked, so the grant has to
        // be in place now — not when the shell's refresh lands.
        grantedRoots.replace(grantedRoots.all() + [URL(fileURLWithPath: root)])
        onRootsChanged?()
    }

    /// A path the renderer asked for, checked against the granted roots.
    ///
    /// The renderer may name a path, but never a path outside a root the
    /// user picked — the same rule the Tauri build's fs scopes enforce.
    private func grantedPath(_ args: [String: Any]) throws -> URL {
        guard let raw = args["path"] as? String else {
            throw BridgeError.badArguments("a path is required")
        }
        let url = URL(fileURLWithPath: raw).standardizedFileURL.resolvingSymlinksInPath()
        for root in grantedRoots.all() {
            let resolved = root.standardizedFileURL.resolvingSymlinksInPath()
            let rootParts = resolved.pathComponents
            let parts = url.pathComponents
            if parts.count >= rootParts.count, parts.starts(with: rootParts) { return url }
        }
        throw BridgeError.failed("that path is outside every folder you have granted")
    }

    private func readDir(_ args: [String: Any]) throws -> [[String: Any]] {
        let url = try grantedPath(args)
        let entries = try FileManager.default.contentsOfDirectory(
            at: url,
            includingPropertiesForKeys: [.isDirectoryKey, .isRegularFileKey, .isSymbolicLinkKey],
            options: [.skipsHiddenFiles]
        )
        return entries.map { entry in
            let values = try? entry.resourceValues(forKeys: [.isDirectoryKey, .isRegularFileKey, .isSymbolicLinkKey])
            return [
                "name": entry.lastPathComponent,
                "isDirectory": values?.isDirectory ?? false,
                "isFile": values?.isRegularFile ?? false,
                "isSymlink": values?.isSymbolicLink ?? false,
            ]
        }
    }

    private func readFile(_ args: [String: Any]) async throws -> [String: Any] {
        let url = try grantedPath(args)
        let data = try await offMain { try Data(contentsOf: url, options: [.mappedIfSafe]) }
        return ["__bytes": data.base64EncodedString()]
    }

    // MARK: - The vault

    /// A vault path, checked against the vault root.
    ///
    /// The path arrives from the page, so it is never trusted: it must carry
    /// the vault's own prefix and must not climb out of the root.
    private func vaultPath(_ logical: String) throws -> URL {
        let prefix = "\(Self.vaultDirName)/"
        guard logical.hasPrefix(prefix) else {
            throw BridgeError.failed("that is not a vault path")
        }
        let relative = String(logical.dropFirst(prefix.count))
        let components = relative.split(separator: "/", omittingEmptySubsequences: false)
        guard !components.isEmpty, !components.contains("..") else {
            throw BridgeError.failed("that vault path escapes the vault")
        }
        let root = vaultRoot.standardizedFileURL.resolvingSymlinksInPath()
        let candidate = vaultRoot.appendingPathComponent(relative)
            .standardizedFileURL.resolvingSymlinksInPath()
        let rootParts = root.pathComponents
        let parts = candidate.pathComponents
        guard parts.count >= rootParts.count, parts.starts(with: rootParts) else {
            throw BridgeError.failed("that vault path escapes the vault")
        }
        return candidate
    }

    private func writeVaultFile(_ url: URL, bytes: Data) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try bytes.write(to: url, options: [.atomic])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }

    /// Every file under the vault root, with its logical path and size.
    ///
    /// A missing root is an empty walk, not an error — a fresh vault reports
    /// zero files.
    private func listVault() throws -> [[String: Any]] {
        var files: [[String: Any]] = []
        let root = vaultRoot
        guard FileManager.default.fileExists(atPath: root.path) else { return files }
        guard let enumerator = FileManager.default.enumerator(
            at: root,
            includingPropertiesForKeys: [.fileSizeKey, .isRegularFileKey],
            options: [.skipsHiddenFiles]
        ) else { return files }
        for case let url as URL in enumerator {
            let values = try? url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
            guard values?.isRegularFile == true else { continue }
            let relative = url.path.replacingOccurrences(of: root.path + "/", with: "")
            files.append([
                "path": "\(Self.vaultDirName)/\(relative)",
                "bytes": values?.fileSize ?? 0,
            ])
        }
        return files
    }

    private func appendVaultLog(_ line: String) throws {
        let url = vaultRoot.appendingPathComponent("vault-debug.log")
        try FileManager.default.createDirectory(at: vaultRoot, withIntermediateDirectories: true)
        let stamp = ISO8601DateFormatter().string(from: Date())
        let text = "\(stamp) \(line)\n"
        if let handle = try? FileHandle(forWritingTo: url) {
            handle.seekToEndOfFile()
            handle.write(Data(text.utf8))
            try? handle.close()
        } else {
            try Data(text.utf8).write(to: url, options: [.atomic])
        }
    }

    // MARK: - The Keychain

    private func keychainGet(_ name: String) throws -> String? {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.keychainService,
            kSecAttrAccount as String: name,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data else {
            throw BridgeError.failed("the keychain refused the read")
        }
        return String(data: data, encoding: .utf8)
    }

    private func keychainSet(_ name: String, _ value: String) throws {
        let data = Data(value.utf8)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.keychainService,
            kSecAttrAccount as String: name,
        ]
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
        ]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var insert = query
            insert.merge(attributes) { current, _ in current }
            let addStatus = SecItemAdd(insert as CFDictionary, nil)
            guard addStatus == errSecSuccess else {
                throw BridgeError.failed("the keychain refused the write")
            }
            return
        }
        guard status == errSecSuccess else {
            throw BridgeError.failed("the keychain refused the write")
        }
    }

    private func keychainRemove(_ name: String) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.keychainService,
            kSecAttrAccount as String: name,
        ]
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw BridgeError.failed("the keychain refused the delete")
        }
        // A resolved delete is not proof of deletion.
        if (try? keychainGet(name)) != nil {
            throw BridgeError.failed("the key survived the delete")
        }
    }

    // MARK: - Bytes

    /// The bytes a command's arguments carried, if any.
    private func decodeBytes(_ args: [String: Any]) -> Data? {
        guard let encoded = args["__bytes"] as? String else { return nil }
        return Data(base64Encoded: encoded)
    }
}

/// Run a blocking piece of work off the main actor.
///
/// The window must never stall while a vault record — megabytes of
/// ciphertext — is read or written.
private func offMain<T>(_ work: @escaping () throws -> T) async throws -> T {
    try await withCheckedThrowingContinuation { continuation in
        DispatchQueue.global(qos: .userInitiated).async {
            do { continuation.resume(returning: try work()) }
            catch { continuation.resume(throwing: error) }
        }
    }
}

/// A command the shell could not carry out.
enum BridgeError: LocalizedError {
    case badArguments(String)
    case failed(String)

    var errorDescription: String? {
        switch self {
        case .badArguments(let why): return why
        case .failed(let why): return why
        }
    }
}
