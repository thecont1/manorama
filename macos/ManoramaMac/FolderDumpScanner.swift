import Foundation
import ImageIO

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
        let keys: Set<URLResourceKey> = [
            .isRegularFileKey, .isDirectoryKey, .isSymbolicLinkKey, .isPackageKey,
            .contentModificationDateKey, .creationDateKey,
            .ubiquitousItemDownloadingStatusKey, .totalFileSizeKey, .totalFileAllocatedSizeKey,
        ]
        let base = root.standardizedFileURL.path
        // `.skipsHiddenFiles` answers both kinds of hidden the dump
        // collects: the dot files a sync client scatters around its
        // contents, and the folders whose name begins with one.
        // `.skipsPackageDescendants` treats a `.photoslibrary`, a `.app` or
        // an `.imoviewindow` as the single object the Finder shows rather
        // than as a tree to walk into.
        guard let walker = FileManager.default.enumerator(
            at: root,
            includingPropertiesForKeys: Array(keys),
            options: [.skipsHiddenFiles, .skipsPackageDescendants]
        ) else {
            throw BridgeError.failed("the raw dump folder could not be opened for reading")
        }
        var found: [DumpedFile] = []
        for case let url as URL in walker {
            let values = try? url.resourceValues(forKeys: keys)
            guard values?.isRegularFile == true else { continue }
            // A symlink is skipped rather than followed. `LocalSchemeHandler`
            // resolves them and refuses any that leaves the granted root,
            // so a cached row for an escaping link would be an event member
            // that opens as nothing; and a link into another part of the
            // same dump would be the same photograph twice.
            guard values?.isSymbolicLink != true else { continue }
            let name = url.lastPathComponent
            guard LocalScanner.isImageName(name) else { continue }
            let path = url.standardizedFileURL.path
            let relative = path.hasPrefix(base + "/")
                ? String(path.dropFirst(base.count + 1))
                : name
            found.append(DumpedFile(
                url: url,
                relativePath: relative,
                modificationDate: values?.contentModificationDate,
                creationDate: values?.creationDate,
                pixelsAreLocal: pixelsAreLocal(values)
            ))
        }
        // The same collation `LocalScanner` uses, so a rescan of an
        // unchanged dump hands back the same sequence, and so a directory
        // named `2` sorts after `10` the way a human reads a year folder.
        return found.sorted { $0.relativePath.localizedStandardCompare($1.relativePath) == .orderedAscending }
    }

    /// The bare minimum: how many images are in there, for a pick's
    /// `itemCount`. Same walk, no items kept.
    static func countImages(root: URL) throws -> Int {
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
