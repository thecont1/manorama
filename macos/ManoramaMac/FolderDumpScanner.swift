import CoreFoundation
import Darwin
import Dispatch
import Foundation
import ImageIO
import Security

/*
 * The ingestion adapter for a raw dump folder.
 *
 * Two rules shape this whole file, and both come from what a raw dump
 * actually is: years of photographs in a sync folder that the user chose
 * precisely because they did not want to look at them.
 *
 *  1. The walk never stops early. `LocalScanner` reads one level and caps
 *     at 1000 items because a curated gallery is a human choice and a long
 *     one is a mistake. A backup laid out `2019/07 … 2026/03` is neither:
 *     capping it would cut the timeline wherever the volume's directory
 *     order happened to fall, and the events page would show a camera roll
 *     that stops in the middle of a year.
 *  2. Nothing here decodes a pixel. The EXIF header is read with
 *     `kCGImageSourceShouldCache` false — the same few kilobytes
 *     `NativeBridge.imageDimensions` already pays for — because a very
 *     large share of these files are stubs whose contents live in the
 *     cloud, and a full read tells a sync client to download the user's
 *     gigabytes in order to answer a question about a timestamp.
 */

/// One image in the dump, as far as ingestion is concerned.
///
/// The dates and the hydration answer come from the directory entry, which
/// every file has whether or not its bytes are present. The header, which
/// not every file may be opened for, is read later, per file, only when
/// the cache cannot answer for it.
struct DumpedFile {
    let url: URL
    /// The id on the wire and in the cache: the path relative to the dump
    /// root, `/`-separated. Relative because the container moves — a Drive
    /// tree remounts under a different volume name, a backup is copied to
    /// a new disk — and an id that moved with it would invalidate every
    /// cached header and re-read the whole dump.
    let relativePath: String
    let modificationDate: Date?
    let creationDate: Date?
    /// Whether the file's contents are on this disk, as opposed to being
    /// kept in the cloud with a stub here. Governs byte access only: the
    /// item still gets a timestamp from the dates above.
    let pixelsAreLocal: Bool
}

/// What ingesting one file produced, and what it cost.
///
/// The cost is not a detail. "First scan reads N headers, an unchanged
/// rescan reads none" is the claim the incremental cache makes to the
/// user, and it is only checkable if the scan reports which files it
/// actually opened.
struct DumpIngest {
    /// The item, or nil when the file carries no time at all — a frame with
    /// no timestamp cannot be placed on a timeline, and guessing "now"
    /// would invent an event.
    let item: MediaMetadataItem?
    /// Whether ImageIO was asked for the header, which is the expensive
    /// thing an incremental scan is judged by. A file whose bytes are not
    /// on this disk produces an item without opening the file at all.
    let headerWasOpened: Bool
}

enum FolderDumpScanner {
    /// The formats the renderer can decode. Reused from `LocalScanner`
    /// rather than restated: one list decides what counts as a photograph
    /// in this app, and a dump item the viewer cannot open is a dead frame
    /// in an event cover.
    static var imageExtensions: Set<String> { LocalScanner.imageExtensions }

    /// The read options that keep a header read a header read.
    ///
    /// `kCGImageSourceShouldCache` false is what stops ImageIO holding a
    /// decoded bitmap behind the property dictionaries.
    static var headerOnlyOptions: CFDictionary {
        [kCGImageSourceShouldCache: false] as CFDictionary
    }

    /// The image files under `root`, at any depth, in a deterministic
    /// order.
    ///
    /// - Throws: `BridgeError.failed` when the root itself cannot be
    ///   opened — an unmounted drive, or a grant that no longer resolves.
    ///   A partial walk is never reported as success: half a timeline that
    ///   the page cannot tell from a whole one is worse than an error.
    static func enumerate(root: URL) throws -> [DumpedFile] {
        try autoreleasepool {
            let base = root.standardizedFileURL.path
            var found: [DumpedFile] = []

            // Leaf resource values query provider metadata; stat reads local fields without hydration.
            func walk(_ directory: String, relativeDirectory: String) throws {
                guard let handle = opendir(directory) else {
                    throw BridgeError.failed("the raw dump folder could not be opened for reading")
                }
                defer { closedir(handle) }
                while let entry = readdir(handle) {
                    let name = withUnsafeBytes(of: entry.pointee.d_name) { bytes in
                        String(cString: bytes.bindMemory(to: CChar.self).baseAddress!)
                    }
                    if name.hasPrefix(".") || !LocalScanner.isImageName(name) && entry.pointee.d_type == DT_REG {
                        continue
                    }
                    let path = directory + "/" + name
                    let relative = relativeDirectory.isEmpty ? name : relativeDirectory + "/" + name
                    var info = stat()
                    guard lstat(path, &info) == 0 else {
                        if errno == ENOENT { continue }
                        throw BridgeError.failed("the raw dump folder could not be read completely")
                    }
                    if (info.st_flags & UInt32(UF_HIDDEN)) != 0 { continue }
                    if (info.st_mode & S_IFMT) == S_IFLNK { continue }
                    if (info.st_mode & S_IFMT) == S_IFDIR {
                        let isPackage = try? URL(fileURLWithPath: path, isDirectory: true)
                            .resourceValues(forKeys: [.isPackageKey]).isPackage
                        if isPackage != true { try walk(path, relativeDirectory: relative) }
                        continue
                    }
                    guard (info.st_mode & S_IFMT) == S_IFREG, LocalScanner.isImageName(name) else { continue }
                    let logicalSize = Int64(info.st_size)
                    let allocatedSize = Int64(info.st_blocks) * 512
                    found.append(DumpedFile(
                        url: URL(fileURLWithPath: path),
                        relativePath: relative,
                        modificationDate: Date(
                            timeIntervalSince1970: TimeInterval(info.st_mtimespec.tv_sec)
                                + TimeInterval(info.st_mtimespec.tv_nsec) / 1_000_000_000
                        ),
                        creationDate: Date(
                            timeIntervalSince1970: TimeInterval(info.st_birthtimespec.tv_sec)
                                + TimeInterval(info.st_birthtimespec.tv_nsec) / 1_000_000_000
                        ),
                        pixelsAreLocal: logicalSize <= 0 || allocatedSize > 0
                    ))
                }
            }

            try walk(base, relativeDirectory: "")
            return found.sorted { $0.relativePath.localizedStandardCompare($1.relativePath) == .orderedAscending }
        }
    }

    /// The same walk with the selected directory pinned for its duration.
    /// A replacement at either end fails the whole operation.
    static func enumerate(root: EventAssetSupport.VerifiedRoot) throws -> [DumpedFile] {
        guard root.isStillCurrent() else {
            throw EventAssetSupportError.reselectionRequired
        }
        let files = try enumerate(root: root.url)
        guard root.isStillCurrent() else {
            throw EventAssetSupportError.reselectionRequired
        }
        return files
    }

    /// The bare minimum: how many images are in there, for a pick's
    /// `itemCount`. Same walk, no items kept.
    static func countImages(root: URL) throws -> Int {
        try enumerate(root: root).count
    }

    static func countImages(root: EventAssetSupport.VerifiedRoot) throws -> Int {
        try enumerate(root: root).count
    }

    /// ImageIO's property dictionaries for one file, read without
    /// decoding. Nil when the header cannot be opened — a stub whose bytes
    /// the cloud has not delivered, a truncated file, a format WebKit's
    /// decoder list rejects at the container level.
    static func headerProperties(at url: URL) -> ImageHeaderProperties? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, headerOnlyOptions) else { return nil }
        guard let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, headerOnlyOptions) as? [String: Any] else { return nil }
        return ImageHeaderProperties(from: properties)
    }

    /// Turn one enumerated file into the core's item.
    ///
    /// The timestamp order is the one the plan sets, and it is an order of
    /// trust: what the camera wrote, then what the filesystem says the file
    /// was born with, then what it says last changed. The last two differ
    /// more than they look like they should — a Drive backup's creation
    /// date is the day it was uploaded, not the day the shutter fired — so
    /// they are a fallback and never a preference.
    static func ingest(_ file: DumpedFile) -> DumpIngest {
        // A placeholder is not opened at all. `CGImageSourceCreateWithURL`
        // reads from byte zero, and for a dataless file that is a fetch
        // request to the cloud: exactly the download this feature promises
        // never to cause. Its dates still place it on the timeline.
        guard file.pixelsAreLocal else {
            return DumpIngest(item: item(from: file, header: nil), headerWasOpened: false)
        }
        let header = headerProperties(at: file.url)
        return DumpIngest(item: item(from: file, header: header), headerWasOpened: true)
    }

    /// Chunked reads keep ImageIO memory bounded while preserving the walk's deterministic order.
    static func ingestMany(_ files: [DumpedFile]) -> [DumpIngest] {
        let chunkSize = 128
        guard files.count > chunkSize else { return autoreleasepool { files.map(ingest) } }
        let chunkCount = (files.count + chunkSize - 1) / chunkSize
        let workerCount = min(8, ProcessInfo.processInfo.activeProcessorCount, chunkCount)
        var chunks = [[DumpIngest]?](repeating: nil, count: chunkCount)
        let lock = NSLock()
        DispatchQueue.concurrentPerform(iterations: workerCount) { worker in
            for chunk in stride(from: worker, to: chunkCount, by: workerCount) {
                let start = chunk * chunkSize
                let end = min(start + chunkSize, files.count)
                let values = autoreleasepool { files[start..<end].map(ingest) }
                lock.lock()
                chunks[chunk] = values
                lock.unlock()
            }
        }
        return chunks.flatMap { $0 ?? [] }
    }

    /// The item for one file, from its header when there is one.
    private static func item(from file: DumpedFile, header: ImageHeaderProperties?) -> MediaMetadataItem? {
        let properties = header ?? ImageHeaderProperties()
        guard let timestamp = DumpMetadataParser.captureDate(exif: properties.exif)
            ?? file.creationDate
            ?? file.modificationDate else {
            return nil
        }
        let coordinate = DumpMetadataParser.coordinate(gps: properties.gps)
        let isScreenshot = DumpMetadataParser.isScreenshot(
            tiff: properties.tiff,
            pathExtension: file.url.pathExtension,
            fileName: file.url.lastPathComponent
        )
        return MediaMetadataItem(
            id: file.relativePath,
            timestamp: timestamp,
            latitude: coordinate?.latitude,
            longitude: coordinate?.longitude,
            isScreenshot: isScreenshot,
            // No burst token exists for a file on a filesystem. The
            // clusterer's own sub-second rule does the grouping, which is
            // why the field is allowed to be nil rather than guessed.
            burstIdentifier: nil,
            // A placeholder carries no mod time on purpose. The core's
            // `needsMetadataRead` treats a missing mod time as "look
            // again", so the row re-reads itself — and only itself — once
            // the file has hydrated, without this adapter remembering
            // which ones it had skipped.
            fileModTime: file.pixelsAreLocal ? file.modificationDate?.timeIntervalSince1970 : nil
        )
    }

    /// Whether a file's contents are on this disk right now.
    ///
    /// `ubiquitousItemDownloadingStatus` answers for iCloud Drive: anything
    /// short of `.current` is a stub. The File Provider trees — Google
    /// Drive for Desktop, Proton Drive, Dropbox's recent architecture —
    /// answer nothing to that key, and this SDK exposes no public URL
    /// resource key that means "this is a placeholder": the brief's
    /// `isFileProviderEnumerated` is not part of Foundation's
    /// `URLResourceKey`. What both kinds of placeholder do share is the
    /// allocation: a dataless file keeps its size in the directory entry
    /// while allocating no blocks of its own. Unknown answers local. That
    /// default is deliberate — refusing to read a photograph that really
    /// is on disk would lose frames from the user's events, and a read
    /// that turns out to fault in one file costs one file, not a library.
    static func pixelsAreLocal(_ values: URLResourceValues?) -> Bool {
        guard let values else { return true }
        if let status = values.ubiquitousItemDownloadingStatus, status != .current {
            return false
        }
        if let allocated = values.totalFileAllocatedSize,
           let logical = values.totalFileSize ?? values.fileSize,
           logical > 0, allocated == 0 {
            return false
        }
        return true
    }

    /// The same question for one URL, asked on its own.
    static func pixelsAreLocal(at url: URL) -> Bool {
        pixelsAreLocal(try? url.resourceValues(forKeys: [
            .ubiquitousItemDownloadingStatusKey, .totalFileSizeKey, .totalFileAllocatedSizeKey, .fileSizeKey,
        ]))
    }
}

/// Desktop Camera Roll asset policy, kept separate from the bridge so the
/// renderer-facing command stays a small adapter around a testable boundary.
enum EventAssetSupport {
    static let headerByteLimit = 4 * 1024 * 1024

    enum Purpose: String {
        case thumbnail
        case viewer
    }

    struct Request {
        let ids: [String]
        let purpose: Purpose
        let imageExtensions: Set<String>

        static func parse(_ args: [String: Any], imageExtensions: Set<String>) throws -> Request {
            guard let ids = args["ids"] as? [String] else {
                throw EventAssetSupportError.badArguments("get_event_asset_image needs ids")
            }
            guard !ids.isEmpty, ids.count <= 64 else {
                throw EventAssetSupportError.badArguments("Event asset batch must contain 1 to 64 ids")
            }
            guard ids.allSatisfy({ validID($0, imageExtensions: imageExtensions) }) else {
                throw EventAssetSupportError.badArguments("Invalid event asset id")
            }
            guard Set(ids).count == ids.count else {
                throw EventAssetSupportError.badArguments("Duplicate event asset id")
            }
            guard let rawPurpose = args["purpose"] as? String,
                  let purpose = Purpose(rawValue: rawPurpose) else {
                throw EventAssetSupportError.badArguments("purpose must be thumbnail or viewer")
            }
            if let rawSize = args["maxPixelSize"] {
                guard CFGetTypeID(rawSize as CFTypeRef) == CFNumberGetTypeID(),
                      let number = rawSize as? NSNumber else {
                    throw EventAssetSupportError.badArguments("maxPixelSize must be an integer from 1 to 8192")
                }
                let size = number.doubleValue
                guard size.isFinite, size >= 1, size <= 8192, size.rounded() == size else {
                    throw EventAssetSupportError.badArguments("maxPixelSize must be an integer from 1 to 8192")
                }
            }
            if let rawNetwork = args["allowNetwork"] {
                guard CFGetTypeID(rawNetwork as CFTypeRef) == CFBooleanGetTypeID(),
                      let allowed = rawNetwork as? Bool else {
                    throw EventAssetSupportError.badArguments("allowNetwork must be a boolean")
                }
                guard !allowed else {
                    throw EventAssetSupportError.badArguments("Desktop event assets never download")
                }
            }
            return Request(ids: ids, purpose: purpose, imageExtensions: imageExtensions)
        }

        static func parseRevealID(_ args: [String: Any], imageExtensions: Set<String>) throws -> String {
            guard let id = args["id"] as? String else {
                throw EventAssetSupportError.badArguments("reveal_event_asset needs id")
            }
            guard validID(id, imageExtensions: imageExtensions) else {
                throw EventAssetSupportError.badArguments("Invalid event asset id")
            }
            return id
        }
    }

    enum State: String {
        case ready
        case cloudOnly
        case missing
        case failed
    }

    struct Item {
        let id: String
        let url: String?
        let width: Int
        let height: Int
        let state: State

        var wireValue: [String: Any] {
            let urlValue: Any = url.map { $0 as Any } ?? NSNull()
            return [
                "id": id,
                "url": urlValue,
                "width": width,
                "height": height,
                "state": state.rawValue,
            ]
        }
    }

    static func items(
        root: VerifiedRoot,
        request: Request,
        pixelsAreLocal: (URL) -> Bool,
        registry: EventAssetRegistry,
        sourceID: UUID
    ) throws -> [Item] {
        // Purpose and size are presentation hints only. Desktop returns an
        // opaque URI over the original descriptor and never creates or
        // changes a thumbnail.
        _ = request.purpose
        return try request.ids.map { id in
            try item(
                root: root,
                id: id,
                imageExtensions: request.imageExtensions,
                pixelsAreLocal: pixelsAreLocal,
                registry: registry,
                sourceID: sourceID
            )
        }
    }

    static func item(
        root: VerifiedRoot,
        id: String,
        imageExtensions: Set<String>,
        pixelsAreLocal: (URL) -> Bool,
        registry: EventAssetRegistry,
        sourceID: UUID
    ) throws -> Item {
        let member: VerifiedMember
        do {
            member = try authorize(root: root, id: id, imageExtensions: imageExtensions)
        } catch EventAssetSupportError.badArguments {
            throw EventAssetSupportError.badArguments("Invalid event asset id")
        } catch EventAssetSupportError.unavailable {
            throw EventAssetSupportError.unavailable("the raw dump folder could not be reached")
        } catch EventAssetSupportError.reselectionRequired {
            throw EventAssetSupportError.reselectionRequired
        } catch {
            return Item(id: id, url: nil, width: 0, height: 0, state: .missing)
        }

        // Ask the scanner's metadata-only question before opening the leaf.
        // A dataless file must not turn a header read into a provider fetch.
        guard !member.isDataless, pixelsAreLocal(member.fileURL) else {
            return Item(id: id, url: nil, width: 0, height: 0, state: .cloudOnly)
        }
        switch member.readHeaderPrefix() {
        case .cloudOnly:
            return Item(id: id, url: nil, width: 0, height: 0, state: .cloudOnly)
        case .failed:
            return Item(id: id, url: nil, width: 0, height: 0, state: .failed)
        case .data(let bytes):
            guard let dimensions = headerDimensions(bytes), member.isStillCurrent() else {
                return Item(id: id, url: nil, width: 0, height: 0, state: .failed)
            }
            let uri = try registry.issue(member, sourceID: sourceID).absoluteString
            return Item(id: id, url: uri, width: dimensions.width, height: dimensions.height, state: .ready)
        }
    }

    /// Authorize a reveal without reducing the verified object to a path.
    /// The caller hands this object to `reveal(_:confirmSource:select:)`.
    static func reveal(root: VerifiedRoot, id: String, imageExtensions: Set<String>) throws -> VerifiedMember {
        let member = try authorize(root: root, id: id, imageExtensions: imageExtensions)
        // Reveal is metadata-only, so a cloud placeholder is valid here.
        guard member.isStillCurrent() else {
            throw EventAssetSupportError.missing
        }
        return member
    }

    /// The last native boundary before Finder's pathname-only API.
    static func reveal(
        _ member: VerifiedMember,
        confirmSource: () throws -> Void,
        select: (String, String) -> Bool
    ) throws {
        try withExtendedLifetime(member) {
            try confirmSource()
            guard member.isStillCurrent() else { throw EventAssetSupportError.missing }
            // NSWorkspace has no handle-based select API; retained FDs and this final check narrow the unavoidable path handoff to the call itself.
            guard select(member.path, member.revealDirectoryPath) else {
                throw EventAssetSupportError.failed("Finder could not reveal that event asset")
            }
        }
    }

    static func validID(_ id: String, imageExtensions: Set<String>) -> Bool {
        guard !id.isEmpty, id.utf8.count <= 4096,
              !id.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
              !id.contains("\\"), !id.contains(":"), !id.hasPrefix("/") else { return false }
        let parts = id.split(separator: "/", omittingEmptySubsequences: false)
        guard !parts.isEmpty, parts.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }) else { return false }
        let ext = (id as NSString).pathExtension.lowercased()
        return imageExtensions.contains(ext)
    }

    /// Intrinsic displayed dimensions from a bounded prefix. ImageIO only
    /// parses the container and EXIF header here; no bitmap is created and
    /// caching is disabled. Orientations 5–8 swap the pair, as Tauri does.
    static func headerDimensions(_ bytes: Data) -> (width: Int, height: Int)? {
        guard !bytes.isEmpty else { return nil }
        let options = FolderDumpScanner.headerOnlyOptions
        guard let source = CGImageSourceCreateWithData(bytes as CFData, options),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, options) as? [String: Any],
              let widthNumber = properties[kCGImagePropertyPixelWidth as String] as? NSNumber,
              let heightNumber = properties[kCGImagePropertyPixelHeight as String] as? NSNumber else { return nil }
        let rawWidth = widthNumber.doubleValue
        let rawHeight = heightNumber.doubleValue
        guard rawWidth.isFinite, rawHeight.isFinite,
              rawWidth > 0, rawHeight > 0,
              rawWidth <= Double(UInt16.max), rawHeight <= Double(UInt16.max),
              rawWidth.rounded() == rawWidth, rawHeight.rounded() == rawHeight else { return nil }
        let width = Int(rawWidth), height = Int(rawHeight)
        let orientation = (properties[kCGImagePropertyOrientation as String] as? NSNumber)?.intValue ?? 1
        return (5...8).contains(orientation) ? (height, width) : (width, height)
    }

    /// Read no more than the header window from an already-authorized file.
    /// Nil is an I/O failure; EOF before the limit is a complete short file.
    static func readHeaderPrefix(fileFD: Int32) -> Data? {
        var bytes = Data()
        bytes.reserveCapacity(64 * 1024)
        while bytes.count < headerByteLimit {
            let chunk = min(64 * 1024, headerByteLimit - bytes.count)
            var buffer = [UInt8](repeating: 0, count: chunk)
            let count = buffer.withUnsafeMutableBytes { pread(fileFD, $0.baseAddress, chunk, off_t(bytes.count)) }
            if count > 0 {
                bytes.append(contentsOf: buffer.prefix(count))
            } else if count == 0 {
                return bytes
            } else if errno != EINTR {
                return nil
            }
        }
        return bytes
    }

    static func openRoot(_ url: URL, expected: NativeFileIdentity?) throws -> VerifiedRoot {
        try VerifiedRoot(url: url, expected: expected)
    }

    /// A selected directory held by descriptor, with its persisted identity.
    final class VerifiedRoot: @unchecked Sendable {
        let url: URL
        let canonicalPath: String
        let identity: NativeFileIdentity
        let directoryFD: Int32

        init(url: URL, expected: NativeFileIdentity?) throws {
            let standardized = url.standardizedFileURL
            self.url = standardized
            let canonical = standardized.resolvingSymlinksInPath().standardizedFileURL
            // Open the selected name without following a final-component
            // symlink. Resolving first would let a replacement alias to the
            // same old directory pass as the originally selected root.
            let directoryFD = open(standardized.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            guard directoryFD >= 0 else {
                throw EventAssetSupportError.unavailable("the raw dump folder could not be opened for reading")
            }
            var opened = stat()
            guard fstat(directoryFD, &opened) == 0, (opened.st_mode & S_IFMT) == S_IFDIR else {
                _ = close(directoryFD)
                throw EventAssetSupportError.unavailable("the raw dump folder could not be opened for reading")
            }
            let openedIdentity = NativeFileIdentity(opened)!
            var named = stat()
            guard canonical.path.withCString({ lstat($0, &named) }) == 0,
                  (named.st_mode & S_IFMT) == S_IFDIR,
                  NativeFileIdentity(named) == openedIdentity else {
                _ = close(directoryFD)
                if let expected, let current = Self.identityAt(canonical.path), current != expected {
                    throw EventAssetSupportError.reselectionRequired
                }
                throw EventAssetSupportError.unavailable("the raw dump folder could not be opened for reading")
            }
            if let expected, expected != openedIdentity {
                _ = close(directoryFD)
                throw EventAssetSupportError.reselectionRequired
            }
            self.canonicalPath = canonical.path
            self.identity = openedIdentity
            self.directoryFD = directoryFD
        }

        deinit { _ = close(directoryFD) }

        func isStillCurrent() -> Bool {
            guard let current = Self.identityAt(canonicalPath), current == identity else { return false }
            var pinned = stat()
            guard fstat(directoryFD, &pinned) == 0,
                  (pinned.st_mode & S_IFMT) == S_IFDIR,
                  NativeFileIdentity(pinned) == identity else { return false }
            var metadata = stat()
            return canonicalPath.withCString({ lstat($0, &metadata) }) == 0
                && (metadata.st_mode & S_IFMT) == S_IFDIR
                && NativeFileIdentity(metadata) == identity
        }

        private static func identityAt(_ path: String) -> NativeFileIdentity? {
            var metadata = stat()
            guard path.withCString({ lstat($0, &metadata) }) == 0 else { return nil }
            return NativeFileIdentity(metadata)
        }
    }

    private static func authorize(root: VerifiedRoot, id: String, imageExtensions: Set<String>) throws -> VerifiedMember {
        guard validID(id, imageExtensions: imageExtensions) else {
            throw EventAssetSupportError.badArguments("Invalid event asset id")
        }
        guard root.isStillCurrent() else { throw EventAssetSupportError.reselectionRequired }

        var directoryFD = dup(root.directoryFD)
        guard directoryFD >= 0 else {
            throw EventAssetSupportError.unavailable("the raw dump folder could not be opened for reading")
        }
        var transferred = false
        defer { if !transferred { _ = close(directoryFD) } }

        let parts = id.split(separator: "/")
        var directories: [(name: String, identity: NativeFileIdentity)] = []
        for part in parts.dropLast() {
            let nextFD = part.withCString {
                openat(directoryFD, $0, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            }
            guard nextFD >= 0 else {
                if errno == ELOOP { throw EventAssetSupportError.unauthorized }
                throw EventAssetSupportError.missing
            }
            var metadata = stat()
            guard fstat(nextFD, &metadata) == 0, (metadata.st_mode & S_IFMT) == S_IFDIR,
                  let identity = NativeFileIdentity(metadata) else {
                _ = close(nextFD)
                throw EventAssetSupportError.missing
            }
            directories.append((name: String(part), identity: identity))
            _ = close(directoryFD)
            directoryFD = nextFD
        }

        let leaf = String(parts.last ?? "")
        var metadata = stat()
        guard leaf.withCString({ fstatat(directoryFD, $0, &metadata, AT_SYMLINK_NOFOLLOW) }) == 0 else {
            throw EventAssetSupportError.missing
        }
        guard (metadata.st_mode & S_IFMT) == S_IFREG else {
            if (metadata.st_mode & S_IFMT) == S_IFLNK { throw EventAssetSupportError.unauthorized }
            throw EventAssetSupportError.missing
        }
        let identity = NativeFileIdentity(metadata)!
        let path = (root.canonicalPath as NSString).appendingPathComponent(id)
        let member = VerifiedMember(
            root: root,
            path: path,
            leaf: leaf,
            directoryFD: directoryFD,
            directories: directories,
            identity: identity,
            isDataless: metadata.st_size > 0 && metadata.st_blocks == 0
        )
        transferred = true
        return member
    }

    /// One authorized object: root, every traversed directory and the leaf are
    /// pinned. Paths are retained only for metadata probes and Finder's final
    /// public-API handoff; byte reads use `pread` on the pinned leaf.
    final class VerifiedMember: @unchecked Sendable {
        let root: VerifiedRoot
        let path: String
        let leaf: String
        let directoryFD: Int32
        let directories: [(name: String, identity: NativeFileIdentity)]
        let identity: NativeFileIdentity
        let isDataless: Bool
        private var fileFD: Int32?

        init(
            root: VerifiedRoot,
            path: String,
            leaf: String,
            directoryFD: Int32,
            directories: [(name: String, identity: NativeFileIdentity)],
            identity: NativeFileIdentity,
            isDataless: Bool
        ) {
            self.root = root
            self.path = path
            self.leaf = leaf
            self.directoryFD = directoryFD
            self.directories = directories
            self.identity = identity
            self.isDataless = isDataless
        }

        deinit {
            _ = close(directoryFD)
            if let fileFD { _ = close(fileFD) }
        }

        var fileURL: URL { URL(fileURLWithPath: path) }
        var revealDirectoryPath: String { (path as NSString).deletingLastPathComponent }
        var canServeBytes: Bool { fileFD != nil && !isDataless }

        var byteCount: UInt64? {
            guard let fileFD else { return nil }
            var metadata = stat()
            guard fstat(fileFD, &metadata) == 0, metadata.st_size >= 0,
                  (metadata.st_mode & S_IFMT) == S_IFREG,
                  NativeFileIdentity(metadata) == identity else { return nil }
            return UInt64(metadata.st_size)
        }

        func isStillCurrent() -> Bool {
            guard root.isStillCurrent() else { return false }
            var currentFD = dup(root.directoryFD)
            guard currentFD >= 0 else { return false }
            defer { _ = close(currentFD) }
            for directory in directories {
                let nextFD = directory.name.withCString {
                    openat(currentFD, $0, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
                }
                guard nextFD >= 0 else { return false }
                var metadata = stat()
                guard fstat(nextFD, &metadata) == 0,
                      (metadata.st_mode & S_IFMT) == S_IFDIR,
                      NativeFileIdentity(metadata) == directory.identity else {
                    _ = close(nextFD)
                    return false
                }
                _ = close(currentFD)
                currentFD = nextFD
            }
            var current = stat()
            guard leaf.withCString({ fstatat(currentFD, $0, &current, AT_SYMLINK_NOFOLLOW) }) == 0,
                  (current.st_mode & S_IFMT) == S_IFREG,
                  NativeFileIdentity(current) == identity,
                  (current.st_size > 0 && current.st_blocks == 0) == isDataless else { return false }
            if let fileFD {
                var opened = stat()
                guard fstat(fileFD, &opened) == 0,
                      (opened.st_mode & S_IFMT) == S_IFREG,
                      NativeFileIdentity(opened) == identity else { return false }
            }
            return true
        }

        /// Open only after the metadata-only placeholder checks have passed.
        /// The descriptor is then retained for every registry read.
        private func pinForReading() -> Bool {
            if fileFD != nil { return isStillCurrent() }
            guard !isDataless, isStillCurrent() else { return false }
            let openedFD = leaf.withCString { openat(directoryFD, $0, O_RDONLY | O_NOFOLLOW | O_CLOEXEC) }
            guard openedFD >= 0 else { return false }
            var opened = stat()
            guard fstat(openedFD, &opened) == 0,
                  (opened.st_mode & S_IFMT) == S_IFREG,
                  NativeFileIdentity(opened) == identity,
                  !(opened.st_size > 0 && opened.st_blocks == 0) else {
                _ = close(openedFD)
                return false
            }
            fileFD = openedFD
            return true
        }

        func readHeaderPrefix() -> HeaderRead {
            guard pinForReading(), let fileFD else { return .failed }
            guard let bytes = EventAssetSupport.readHeaderPrefix(fileFD: fileFD), isStillCurrent() else {
                return .failed
            }
            return .data(bytes)
        }

        func readBytes(offset: Int, length: Int) -> Data? {
            guard length >= 0, let fileFD, isStillCurrent() else { return nil }
            var data = Data(count: length)
            var written = 0
            while written < length {
                guard isStillCurrent() else { return nil }
                let position = offset.addingReportingOverflow(written)
                guard !position.overflow else { return nil }
                let count = data.withUnsafeMutableBytes { buffer -> Int in
                    guard let base = buffer.baseAddress else { return -1 }
                    return pread(fileFD, base.advanced(by: written), length - written, off_t(position.partialValue))
                }
                if count > 0 {
                    written += count
                } else if count == 0 || errno != EINTR {
                    return nil
                }
            }
            guard isStillCurrent() else { return nil }
            return data
        }
    }

    enum HeaderRead {
        case data(Data)
        case cloudOnly
        case failed
    }
}

/// A bounded, process-local capability registry for event originals.
///
/// The URL is only a lookup key. Every entry owns the verified root, directory
/// and leaf descriptors, and every response rechecks their identities before
/// reading with `pread`; no request reopens the pathname.
final class EventAssetRegistry: @unchecked Sendable {
    struct Response {
        let statusCode: Int
        let headers: [String: String]
        let body: Data
    }

    private struct Entry {
        let member: EventAssetSupport.VerifiedMember
        let sourceID: UUID
        let expiresAt: Date
    }

    private enum ByteRange {
        case full
        case partial(offset: Int, length: Int)
        case unsatisfiable
        case invalid
    }

    private let lock = NSLock()
    private var entries: [String: Entry] = [:]
    private var order: [String] = []
    private let capacity: Int
    private let ttl: TimeInterval

    init(capacity: Int = 128, ttl: TimeInterval = 30 * 60) {
        self.capacity = max(1, capacity)
        self.ttl = max(1, ttl)
    }

    var count: Int {
        lock.lock()
        defer { lock.unlock() }
        pruneExpiredLocked()
        return entries.count
    }

    func issue(_ member: EventAssetSupport.VerifiedMember, sourceID: UUID) throws -> URL {
        guard member.canServeBytes, member.isStillCurrent() else {
            throw EventAssetSupportError.failed("Event asset is not available for descriptor delivery")
        }
        lock.lock()
        defer { lock.unlock() }
        pruneExpiredLocked()
        for _ in 0..<8 {
            let token = try Self.newToken()
            guard entries[token] == nil else { continue }
            while order.count >= capacity {
                let oldest = order.removeFirst()
                entries[oldest] = nil
            }
            entries[token] = Entry(member: member, sourceID: sourceID, expiresAt: Date().addingTimeInterval(ttl))
            order.append(token)
            return URL(string: "manorama-event://localhost/\(token)")!
        }
        throw EventAssetSupportError.failed("Could not issue an event asset capability")
    }

    func revokeSource(_ sourceID: UUID) {
        lock.lock()
        defer { lock.unlock() }
        order = order.filter { token in
            guard entries[token]?.sourceID == sourceID else { return true }
            entries[token] = nil
            return false
        }
    }

    func revokeAll() {
        lock.lock()
        entries.removeAll()
        order.removeAll()
        lock.unlock()
    }

    func response(for url: URL, method: String, range: String?) -> Response {
        var headers = [
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
        ]
        guard method == "GET" || method == "HEAD" else {
            headers["Allow"] = "GET, HEAD"
            return Response(statusCode: 405, headers: headers, body: Data())
        }
        guard let token = Self.token(from: url), let member = resolve(token) else {
            return Response(statusCode: 404, headers: headers, body: Data())
        }
        guard member.canServeBytes, let fileSize = member.byteCount, fileSize <= UInt64(Int.max) else {
            revoke(token)
            return Response(statusCode: 404, headers: headers, body: Data())
        }
        let size = Int(fileSize)
        let selected: ByteRange
        if let range {
            selected = Self.parseRange(range, size: size)
        } else {
            selected = .full
        }
        let offset: Int
        let length: Int
        var partial = false
        switch selected {
        case .full:
            offset = 0
            length = size
        case .partial(let start, let count):
            offset = start
            length = count
            partial = true
        case .invalid, .unsatisfiable:
            headers["Content-Range"] = "bytes */\(size)"
            return Response(statusCode: 416, headers: headers, body: Data())
        }
        headers["Content-Type"] = LocalMediaResolver.mimeType(for: (member.leaf as NSString).pathExtension)
        headers["Accept-Ranges"] = "bytes"
        headers["Content-Length"] = "\(length)"
        if partial {
            headers["Content-Range"] = "bytes \(offset)-\(offset + length - 1)/\(size)"
        }
        guard method == "GET" else {
            return Response(statusCode: partial ? 206 : 200, headers: headers, body: Data())
        }
        let body: Data
        if length == 0 {
            body = Data()
        } else {
            guard let bytes = member.readBytes(offset: offset, length: length) else {
                revoke(token)
                headers["Content-Length"] = "0"
                headers.removeValue(forKey: "Content-Range")
                return Response(statusCode: 404, headers: headers, body: Data())
            }
            body = bytes
        }
        return Response(statusCode: partial ? 206 : 200, headers: headers, body: body)
    }

    static func isEventURL(_ url: URL) -> Bool {
        url.scheme?.lowercased() == "manorama-event"
    }

    static func token(from url: URL) -> String? {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.scheme == "manorama-event",
              components.host == "localhost",
              components.user == nil, components.password == nil, components.port == nil,
              components.query == nil, components.fragment == nil,
              components.percentEncodedPath.hasPrefix("/") else { return nil }
        let token = String(components.percentEncodedPath.dropFirst())
        guard validToken(token), url.absoluteString == "manorama-event://localhost/\(token)" else { return nil }
        return token
    }

    private func resolve(_ token: String) -> EventAssetSupport.VerifiedMember? {
        lock.lock()
        let entry = entries[token]
        lock.unlock()
        guard let entry, entry.expiresAt > Date() else {
            revoke(token)
            return nil
        }
        guard entry.member.isStillCurrent() else {
            revoke(token)
            return nil
        }
        return entry.member
    }

    private func revoke(_ token: String) {
        lock.lock()
        entries[token] = nil
        order.removeAll { $0 == token }
        lock.unlock()
    }

    private func pruneExpiredLocked() {
        let now = Date()
        order = order.filter { token in
            guard let entry = entries[token] else { return false }
            guard entry.expiresAt > now else {
                entries[token] = nil
                return false
            }
            return true
        }
    }

    private static func validToken(_ token: String) -> Bool {
        guard token.utf8.count == 32 else { return false }
        // Match the portable core's native-lease grammar: a UUID-shaped,
        // 128-bit random capability, never a path or a renderer-chosen name.
        return token.utf8.allSatisfy { byte in
            (byte >= 48 && byte <= 57) || (byte >= 65 && byte <= 70) || (byte >= 97 && byte <= 102)
        }
    }

    private static func newToken() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 16)
        let status = bytes.withUnsafeMutableBytes { buffer -> OSStatus in
            guard let base = buffer.baseAddress else { return errSecParam }
            return SecRandomCopyBytes(kSecRandomDefault, buffer.count, base)
        }
        guard status == errSecSuccess else {
            throw EventAssetSupportError.failed("Could not create an event asset capability")
        }
        return bytes.map { String(format: "%02x", $0) }.joined()
    }

    private static func parseRange(_ header: String, size: Int) -> ByteRange {
        let text = header.trimmingCharacters(in: .whitespaces)
        guard text.lowercased().hasPrefix("bytes="), !text.contains(",") else { return .invalid }
        let specification = String(text.dropFirst("bytes=".count))
        let bounds = specification.split(separator: "-", omittingEmptySubsequences: false)
        guard bounds.count == 2, bounds.allSatisfy({ !$0.isEmpty || specification.hasPrefix("-") || specification.hasSuffix("-") }) else {
            return .invalid
        }
        func integer(_ value: Substring) -> Int? {
            guard !value.isEmpty, value.allSatisfy({ $0 >= "0" && $0 <= "9" }) else { return nil }
            return Int(value)
        }
        if bounds[0].isEmpty {
            guard let suffix = integer(bounds[1]), suffix > 0, size > 0 else { return .invalid }
            let count = min(suffix, Self.maxRangeBytes, size)
            return .partial(offset: size - count, length: count)
        }
        guard let start = integer(bounds[0]), start < size else { return .unsatisfiable }
        let end: Int
        if bounds[1].isEmpty {
            end = size - 1
        } else {
            guard let requestedEnd = integer(bounds[1]), requestedEnd >= start else { return .invalid }
            end = min(requestedEnd, size - 1)
        }
        let length = end - start + 1
        guard length <= Self.maxRangeBytes else { return .invalid }
        return .partial(offset: start, length: length)
    }

    private static let maxRangeBytes = 64 * 1024 * 1024
}

enum EventAssetSupportError: LocalizedError {
    case badArguments(String)
    case unavailable(String)
    case failed(String)
    case missing
    case unauthorized
    case reselectionRequired

    var errorDescription: String? {
        switch self {
        case .badArguments(let why): return why
        case .unavailable(let why): return why
        case .failed(let why): return why
        case .missing: return "Event asset is missing"
        case .unauthorized: return "Event asset is outside the declared raw dump"
        case .reselectionRequired: return "The raw dump folder changed; choose it again"
        }
    }
}
