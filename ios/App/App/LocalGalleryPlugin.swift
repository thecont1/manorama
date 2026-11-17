import UIKit
import Capacitor
import UniformTypeIdentifiers
import ImageIO

/// Local galleries on iOS: pick a folder, copy its photographs into the app
/// container, and hand the web layer a manifest-ready item list. The pick is
/// a copy — bytes are preserved verbatim (never decoded, never re-encoded) —
/// so the record survives the source's security scope, an ejected drive, and
/// Files-app reorganisation without bookmark bookkeeping.
///
/// Paths stay on the phone by contract: the catalogue stores them, the sync
/// projection emits title/kind/count/deviceId only. `removeGallery` refuses
/// anything outside the LocalGalleries root the plugin itself created.
@objc(LocalGalleryPlugin)
public class LocalGalleryPlugin: CAPPlugin, CAPBridgedPlugin, UIDocumentPickerDelegate {
    public let identifier = "LocalGalleryPlugin"
    public let jsName = "LocalGallery"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "importFolder", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "removeGallery", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "exists", returnType: CAPPluginReturnPromise),
    ]

    private var pendingCall: CAPPluginCall?
    private var pendingExtensions: Set<String> = []
    private var pendingMaxItems = Int.max

    private var localGalleriesRoot: URL {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return support.appendingPathComponent("LocalGalleries", isDirectory: true)
    }

    @objc func importFolder(_ call: CAPPluginCall) {
        guard pendingCall == nil else {
            call.reject("A folder pick is already open")
            return
        }
        pendingCall = call
        pendingExtensions = Set((call.getArray("extensions", String.self) ?? []).map { $0.lowercased() })
        pendingMaxItems = call.getInt("maxItems") ?? Int.max
        DispatchQueue.main.async {
            guard let host = self.bridge?.viewController else {
                self.pendingCall = nil
                call.reject("There is nowhere to present the folder picker")
                return
            }
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder], asCopy: false)
            picker.delegate = self
            picker.allowsMultipleSelection = false
            host.present(picker, animated: true)
        }
    }

    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        pendingCall?.resolve(["cancelled": true])
        pendingCall = nil
    }

    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let call = pendingCall else { return }
        pendingCall = nil
        guard let source = urls.first else {
            call.resolve(["cancelled": true])
            return
        }
        let extensions = pendingExtensions
        let maxItems = pendingMaxItems
        // A large folder's copy belongs off the presentation thread; the
        // picked URL's security scope is process-wide, so the background
        // enumeration is still inside it.
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let result = try self.copyGallery(source, extensions: extensions, maxItems: maxItems)
                DispatchQueue.main.async { call.resolve(result) }
            } catch {
                DispatchQueue.main.async { call.reject("That folder could not be copied: \(error.localizedDescription)") }
            }
        }
    }

    @objc func removeGallery(_ call: CAPPluginCall) {
        guard let path = call.getString("path") else {
            call.reject("A path is required")
            return
        }
        let target = URL(fileURLWithPath: path).standardizedFileURL
        let root = localGalleriesRoot.standardizedFileURL
        guard target.path.hasPrefix(root.path + "/") else {
            call.reject("Only folders this app copied can be removed")
            return
        }
        do {
            try FileManager.default.removeItem(at: target)
            call.resolve()
        } catch {
            call.reject("The folder could not be removed: \(error.localizedDescription)")
        }
    }

    @objc func exists(_ call: CAPPluginCall) {
        guard let path = call.getString("path") else {
            call.reject("A path is required")
            return
        }
        call.resolve(["exists": FileManager.default.fileExists(atPath: path)])
    }

    /// Root files plus exactly one level of subdirectories — the depth the
    /// shared scanner contract specifies, enough for DCIM layouts, shallow
    /// enough that picking a drive root never becomes a crawl.
    private func copyGallery(_ source: URL, extensions: Set<String>, maxItems: Int) throws -> [String: Any] {
        let accessing = source.startAccessingSecurityScopedResource()
        defer { if accessing { source.stopAccessingSecurityScopedResource() } }

        let fileManager = FileManager.default
        let galleryId = UUID().uuidString.lowercased()
        let destination = localGalleriesRoot.appendingPathComponent(galleryId, isDirectory: true)
        try fileManager.createDirectory(at: destination, withIntermediateDirectories: true)

        let keys: [URLResourceKey] = [.isDirectoryKey, .isHiddenKey]
        let options: FileManager.DirectoryEnumerationOptions = [.skipsPackageDescendants]
        let rootEntries = (try? fileManager.contentsOfDirectory(at: source, includingPropertiesForKeys: keys, options: options)) ?? []

        var matched: [(url: URL, relative: String)] = []
        var total = 0
        let imageFile = { (url: URL) -> Bool in
            guard let values = try? url.resourceValues(forKeys: Set(keys)),
                  values.isDirectory != true, values.isHidden != true,
                  !url.lastPathComponent.hasPrefix(".") else { return false }
            return extensions.contains("." + url.pathExtension.lowercased())
        }
        let naturalOrder = { (a: URL, b: URL) -> Bool in
            a.lastPathComponent.localizedStandardCompare(b.lastPathComponent) == .orderedAscending
        }

        var pending = rootEntries.filter(imageFile).map { (url: $0, relative: $0.lastPathComponent) }
        // One subdirectory level, in the same natural order the files take.
        let subdirs = rootEntries
            .filter { url in
                guard let values = try? url.resourceValues(forKeys: Set(keys)) else { return false }
                return values.isDirectory == true && values.isHidden != true
                    && !url.lastPathComponent.hasPrefix(".")
            }
            .sorted(by: naturalOrder)
        for subdir in subdirs {
            let entries = (try? fileManager.contentsOfDirectory(at: subdir, includingPropertiesForKeys: keys, options: options)) ?? []
            pending.append(contentsOf: entries.filter(imageFile).map { (url: $0, relative: "\(subdir.lastPathComponent)/\($0.lastPathComponent)") })
        }
        // One deterministic order — relative path, natural collation — the
        // same contract the shared scanner keeps so IMG_2 precedes IMG_10.
        pending.sort { $0.relative.localizedStandardCompare($1.relative) == .orderedAscending }
        total = pending.count
        matched = Array(pending.prefix(maxItems))

        var items: [[String: Any]] = []
        for entry in matched {
            let target = destination.appendingPathComponent(entry.relative)
            try fileManager.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
            if fileManager.fileExists(atPath: target.path) {
                try fileManager.removeItem(at: target)
            }
            try fileManager.copyItem(at: entry.url, to: target)
            var item: [String: Any] = ["id": entry.relative, "name": entry.url.lastPathComponent, "path": target.path]
            if let dims = LocalGalleryPlugin.pixelDimensions(of: target) {
                item["width"] = dims.width
                item["height"] = dims.height
            }
            items.append(item)
        }

        // A removable volume (SD card, USB drive in Files) is a card; the
        // volume lookup failing just means we cannot tell — folder is the
        // honest default, never a guess.
        let removable = (try? source.resourceValues(forKeys: [.volumeURLKey]).volume)
            .flatMap { try? $0.resourceValues(forKeys: [.volumeIsRemovableKey]).volumeIsRemovable } ?? false
        var result: [String: Any] = [
            "galleryId": galleryId,
            "title": source.lastPathComponent,
            "rootPath": destination.path,
            "sourceKind": removable ? "card" : "folder",
            "items": items,
        ]
        if total > items.count { result["truncated"] = total }
        return result
    }

    /// Displayed-pixel dims from the image header — no decode, so a 24 MP
    /// original costs a metadata read, not a bitmap.
    private static func pixelDimensions(of url: URL) -> (width: Int, height: Int)? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int,
              width > 0, height > 0 else { return nil }
        return (width, height)
    }
}
