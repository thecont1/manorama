import Foundation
import Photos
import UIKit
import ImageIO
import CryptoKit
import UniformTypeIdentifiers
import Darwin

/// Native-owned event files only. Establish privacy before any bytes are
/// written; atomic replacement keeps the protected inode and backup flag.
enum EventPrivateFiles {
    static func exclude(_ url: URL) throws {
        var url = url
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        try url.setResourceValues(values)
    }
    static func directory(_ url: URL) throws {
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.complete, .posixPermissions: 0o700])
        // createDirectory does not repair attributes on an existing directory.
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete, .posixPermissions: 0o700], ofItemAtPath: url.path)
        try exclude(url)
    }
    static func create(_ url: URL) throws -> FileHandle {
        guard FileManager.default.createFile(atPath: url.path, contents: nil,
            attributes: [.protectionKey: FileProtectionType.complete, .posixPermissions: 0o600]) else {
            throw CocoaError(.fileWriteUnknown)
        }
        do {
            try exclude(url)
            return try FileHandle(forWritingTo: url)
        } catch {
            try? FileManager.default.removeItem(at: url)
            throw error
        }
    }
    static func write(_ data: Data, to url: URL) throws {
        try directory(url.deletingLastPathComponent())
        let staging = url.deletingLastPathComponent().appendingPathComponent(".event-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: staging) }
        let handle = try create(staging)
        do {
            try handle.write(contentsOf: data)
            try handle.synchronize()
            try handle.close()
        } catch {
            try? handle.close()
            throw error
        }
        guard rename(staging.path, url.path) == 0 else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
        }
    }
}

struct EventPhotoAsset {
    let id: String
    let width: Int
    let height: Int
    let modified: Date?
    let fileExtension: String
}

/// PhotoKit is the injected boundary: tests observe the actual options
/// used, without pretending a simulator can manufacture iCloud assets.
protocol EventPhotoBackend {
    func asset(_ id: String) -> EventPhotoAsset?
    func thumbnail(_ asset: EventPhotoAsset, target: CGSize, allowNetwork: Bool,
                   completion: @escaping (UIImage?, Bool, Bool) -> Void) -> PHImageRequestID
    func cancelThumbnail(_ id: PHImageRequestID)
    func requestData(_ asset: EventPhotoAsset, allowNetwork: Bool,
                     progress: @escaping (Double) -> Void, dataReceived: @escaping (Data) -> Void,
                     completion: @escaping (Error?) -> Void) -> PHAssetResourceDataRequestID
    func cancelDataRequest(_ id: PHAssetResourceDataRequestID)
}

final class PhotoKitEventBackend: EventPhotoBackend {
    private let images = PHCachingImageManager()
    private let resources = PHAssetResourceManager.default()
    private func fetch(_ id: String) -> PHAsset? {
        PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil).firstObject
    }
    private func original(_ asset: PHAsset) -> PHAssetResource? {
        PHAssetResource.assetResources(for: asset).first { $0.type == .photo }
    }
    func asset(_ id: String) -> EventPhotoAsset? {
        guard let asset = fetch(id), asset.mediaType == .image else { return nil }
        let ext = original(asset).flatMap { UTType($0.uniformTypeIdentifier)?.preferredFilenameExtension } ?? "bin"
        return EventPhotoAsset(id: id, width: asset.pixelWidth, height: asset.pixelHeight,
                               modified: asset.modificationDate, fileExtension: ext)
    }
    func thumbnail(_ asset: EventPhotoAsset, target: CGSize, allowNetwork: Bool,
                   completion: @escaping (UIImage?, Bool, Bool) -> Void) -> PHImageRequestID {
        guard let photo = fetch(asset.id) else { completion(nil, false, true); return PHInvalidImageRequestID }
        let options = PHImageRequestOptions()
        options.deliveryMode = .opportunistic
        options.resizeMode = .fast
        options.isNetworkAccessAllowed = false // Not even the preference can override this.
        return images.requestImage(for: photo, targetSize: target, contentMode: .aspectFit, options: options) { image, info in
            let cloud = (info?[PHImageResultIsInCloudKey] as? Bool) == true
            let degraded = (info?[PHImageResultIsDegradedKey] as? Bool) == true
            // A degraded local rendition is sufficient for a thumbnail;
            // the service leases only the first safe result and cancels extras.
            if image != nil || !degraded { completion(image, cloud, info?[PHImageErrorKey] != nil) }
        }
    }
    func cancelThumbnail(_ id: PHImageRequestID) { images.cancelImageRequest(id) }
    func requestData(_ asset: EventPhotoAsset, allowNetwork: Bool,
                     progress: @escaping (Double) -> Void, dataReceived: @escaping (Data) -> Void,
                     completion: @escaping (Error?) -> Void) -> PHAssetResourceDataRequestID {
        guard let photo = fetch(asset.id), let resource = original(photo) else {
            completion(CocoaError(.fileNoSuchFile)); return 0
        }
        let options = PHAssetResourceRequestOptions()
        options.isNetworkAccessAllowed = allowNetwork
        options.progressHandler = progress
        // Resource chunks, including ICC/C2PA and EXIF, pass through untouched.
        return resources.requestData(for: resource, options: options,
            dataReceivedHandler: dataReceived, completionHandler: completion)
    }
    func cancelDataRequest(_ id: PHAssetResourceDataRequestID) { resources.cancelDataRequest(id) }
}

/// All methods and completion state belong to the plugin's serial queue.
/// Cancellation stops PhotoKit itself as well as retiring the file lease.
final class EventAssetImages {
    struct Reply {
        let id: String
        let url: URL?
        let width: Int
        let height: Int
        let state: String
        var wire: [String: Any] {
            ["id": id, "url": url?.absoluteString as Any? ?? NSNull(),
             "width": width, "height": height, "state": state]
        }
    }
    private final class Pending {
        let token = UUID()
        let asset: EventPhotoAsset
        let url: URL?
        let complete: (Reply) -> Void
        var thumbnail: PHImageRequestID?
        var resource: PHAssetResourceDataRequestID?
        var file: FileHandle?
        init(asset: EventPhotoAsset, url: URL?, complete: @escaping (Reply) -> Void) {
            self.asset = asset; self.url = url; self.complete = complete
        }
    }
    private let queue: DispatchQueue
    private let queueKey = DispatchSpecificKey<Bool>()
    private let backend: EventPhotoBackend
    let thumbs: URL
    let originals: URL
    private let budget: Int
    private var pending: [String: Pending] = [:]
    private var issued: [URL: String] = [:]
    var progress: ((String, Double) -> Void)?

    init(queue: DispatchQueue, backend: EventPhotoBackend = PhotoKitEventBackend(), thumbs: URL, originals: URL,
         budget: Int = 200 * 1024 * 1024) {
        self.queue = queue; self.backend = backend; self.thumbs = thumbs; self.originals = originals; self.budget = budget
        queue.setSpecific(key: queueKey, value: true)
    }
    deinit {
        // Snapshot only when the last owner has gone; perform all handle
        // teardown on the owner queue, without synchronously re-entering it.
        let jobs = Array(pending.values), urls = Array(issued.keys), backend = backend
        let cleanup = {
            for job in jobs {
                try? job.file?.close()
                job.file = nil
                if let url = job.url { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
                if let handle = job.thumbnail { backend.cancelThumbnail(handle) }
                if let handle = job.resource { backend.cancelDataRequest(handle) }
                job.complete(Reply(id: job.asset.id, url: nil, width: job.asset.width, height: job.asset.height, state: "failed"))
            }
            for url in urls { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        }
        if DispatchQueue.getSpecific(key: queueKey) == true { cleanup() }
        else { queue.async(execute: cleanup) }
    }
    static func validId(_ id: String) -> Bool {
        !id.isEmpty && id.count <= 4096 && !id.unicodeScalars.contains { $0.value < 32 || $0.value == 127 }
        && !id.contains("\\") && !id.contains(":")
        && !id.components(separatedBy: "/").contains { $0.isEmpty || $0 == "." || $0 == ".." }
    }
    static func target(_ asset: EventPhotoAsset, maxPixelSize: Int) -> CGSize {
        let edge = Double(min(512, maxPixelSize, max(asset.width, asset.height)))
        let scale = edge / Double(max(1, max(asset.width, asset.height)))
        // PhotoKit rounds a fractional short edge up; ask for that bound ourselves.
        return CGSize(width: max(1, ceil(Double(asset.width) * scale)), height: max(1, ceil(Double(asset.height) * scale)))
    }
    private static func boundedThumbnail(_ image: UIImage, target: CGSize, sourceWidth: Int, sourceHeight: Int) -> UIImage? {
        guard let cg = image.cgImage, cg.width > 0, cg.height > 0 else { return nil }
        let width = image.size.width * image.scale
        let height = image.size.height * image.scale
        guard width > 0, height > 0 else { return nil }
        let scale = min(1, target.width / width, target.height / height,
                        CGFloat(sourceWidth) / width, CGFloat(sourceHeight) / height)
        let size = CGSize(width: max(1, floor(width * scale)), height: max(1, floor(height * scale)))
        if size.width == width && size.height == height { return image }
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        return UIGraphicsImageRenderer(size: size, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: size))
        }
    }
    static func cacheKey(_ asset: EventPhotoAsset, target: CGSize) -> String {
        let key = "\(asset.id)|\(asset.modified?.timeIntervalSince1970 ?? 0)|\(Int(target.width))x\(Int(target.height))"
        return SHA256.hash(data: Data(key.utf8)).map { String(format: "%02x", $0) }.joined()
    }
    private func directory(_ url: URL) throws { try EventPrivateFiles.directory(url) }
    private func dimensions(_ url: URL) -> (Int, Int)? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = props[kCGImagePropertyPixelWidth] as? Int,
              let height = props[kCGImagePropertyPixelHeight] as? Int else { return nil }
        let orientation = (props[kCGImagePropertyOrientation] as? Int) ?? 1
        return orientation >= 5 && orientation <= 8 ? (height, width) : (width, height)
    }
    func sweepLaunch() {
        dispatchPrecondition(condition: .onQueue(queue))
        for key in Array(pending.keys) { cancelKey(key) }
        try? FileManager.default.removeItem(at: originals)
        issued.removeAll()
        evict()
    }
    func request(ids: [String], purpose: String, maxPixelSize: Int, allowNetwork: Bool, complete: @escaping ([Reply]) -> Void) {
        dispatchPrecondition(condition: .onQueue(queue))
        var results = Array<Reply?>(repeating: nil, count: ids.count)
        var remaining = ids.count
        for (index, id) in ids.enumerated() {
            request(id: id, purpose: purpose, maxPixelSize: maxPixelSize, allowNetwork: allowNetwork) { reply in
                results[index] = reply; remaining -= 1
                if remaining == 0 { complete(results.compactMap { $0 }) }
            }
        }
    }
    private func request(id: String, purpose: String, maxPixelSize: Int, allowNetwork: Bool, complete: @escaping (Reply) -> Void) {
        let key = purpose == "thumbnail" ? "thumbnail:\(id)" : id
        cancelKey(key)
        guard let asset = backend.asset(id), asset.width > 0, asset.height > 0 else {
            complete(Reply(id: id, url: nil, width: 0, height: 0, state: "missing")); return
        }
        let isThumb = purpose == "thumbnail"
        let target = Self.target(asset, maxPixelSize: maxPixelSize)
        let url: URL
        do {
            if isThumb {
                try directory(thumbs)
                url = thumbs.appendingPathComponent(Self.cacheKey(asset, target: target) + ".jpg")
                if let (width, height) = dimensions(url), width > 0, height > 0,
                   width <= 512, height <= 512, width <= asset.width, height <= asset.height {
                    try FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete, .posixPermissions: 0o600, .modificationDate: Date()], ofItemAtPath: url.path)
                    try EventPrivateFiles.exclude(url)
                    complete(Reply(id: id, url: url, width: width, height: height, state: "ready")); return
                }
            } else {
                try directory(originals)
                let lease = originals.appendingPathComponent(UUID().uuidString.lowercased())
                try directory(lease)
                let ext = asset.fileExtension.allSatisfy { $0.isLetter || $0.isNumber } ? asset.fileExtension : "bin"
                url = lease.appendingPathComponent(UUID().uuidString.lowercased() + "." + ext)
            }
        } catch { complete(Reply(id: id, url: nil, width: asset.width, height: asset.height, state: "failed")); return }
        let operation = Pending(asset: asset, url: isThumb ? nil : url, complete: complete)
        pending[key] = operation
        if isThumb {
            let handle = backend.thumbnail(asset, target: target, allowNetwork: false) { [weak self] image, cloud, failed in
                guard let self else { return }
                self.queue.async {
                    guard self.pending[key]?.token == operation.token else { return }
                    guard let image,
                          let bounded = Self.boundedThumbnail(image, target: target, sourceWidth: asset.width, sourceHeight: asset.height),
                          let cg = bounded.cgImage, cg.width > 0, cg.height > 0,
                          cg.width <= Int(target.width), cg.height <= Int(target.height), cg.width <= asset.width, cg.height <= asset.height,
                          let data = bounded.jpegData(compressionQuality: 0.85) else {
                        self.finish(key, operation: operation, url: nil, width: asset.width, height: asset.height,
                                    state: cloud && !failed ? "cloudOnly" : "failed"); return
                    }
                    do {
                        try EventPrivateFiles.write(data, to: url)
                        self.evict()
                        guard FileManager.default.fileExists(atPath: url.path) else { throw CocoaError(.fileNoSuchFile) }
                        self.finish(key, operation: operation, url: url, width: cg.width, height: cg.height, state: "ready")
                    } catch { self.finish(key, operation: operation, url: nil, width: asset.width, height: asset.height, state: "failed") }
                }
            }
            operation.thumbnail = handle
        } else {
            do { operation.file = try EventPrivateFiles.create(url) }
            catch { cancelKey(key); return }
            // Always enqueue callbacks, even synchronous mock callbacks. The
            // returned request ID is installed before any callback can finish
            // or cancel the job; no sync onto our own serial queue is needed.
            operation.resource = backend.requestData(asset, allowNetwork: allowNetwork, progress: { [weak self] fraction in
                guard let self else { return }
                self.queue.async {
                    guard self.pending[key]?.token == operation.token, allowNetwork, fraction.isFinite else { return }
                    self.progress?(id, min(1, max(0, fraction)))
                }
            }, dataReceived: { [weak self] data in
                guard let self else { return }
                self.queue.async {
                    guard self.pending[key]?.token == operation.token, let file = operation.file else { return }
                    do { try file.write(contentsOf: data) }
                    catch { self.cancelKey(key) }
                }
            }, completion: { [weak self] error in
                guard let self else { return }
                self.queue.async {
                    guard self.pending[key]?.token == operation.token else { return }
                    if let error {
                        let error = error as NSError
                        let cloud = !allowNetwork && error.domain == PHPhotosErrorDomain
                            && error.code == PHPhotosError.Code.networkAccessRequired.rawValue
                        self.discardOriginal(operation)
                        self.finish(key, operation: operation, url: nil, width: asset.width, height: asset.height, state: cloud ? "cloudOnly" : "failed")
                        return
                    }
                    do {
                        try operation.file?.synchronize()
                        try operation.file?.close()
                        operation.file = nil
                        guard FileManager.default.fileExists(atPath: url.path) else { throw CocoaError(.fileNoSuchFile) }
                        self.issued[url] = id
                        let pixels = self.dimensions(url) ?? (asset.width, asset.height)
                        self.finish(key, operation: operation, url: url, width: pixels.0, height: pixels.1, state: "ready")
                    } catch { self.cancelKey(key) }
                }
            })
        }
    }
    private func finish(_ key: String, operation: Pending, url: URL?, width: Int, height: Int, state: String) {
        guard pending[key]?.token == operation.token else { return }
        pending.removeValue(forKey: key)
        if let handle = operation.thumbnail { backend.cancelThumbnail(handle) }
        operation.complete(Reply(id: operation.asset.id, url: url, width: width, height: height, state: state))
    }
    private func discardOriginal(_ operation: Pending) {
        try? operation.file?.close()
        operation.file = nil
        if let url = operation.url { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
    }
    private func cancelKey(_ key: String) {
        guard let operation = pending.removeValue(forKey: key) else { return }
        discardOriginal(operation)
        if let handle = operation.thumbnail { backend.cancelThumbnail(handle) }
        if let handle = operation.resource { backend.cancelDataRequest(handle) }
        operation.complete(Reply(id: operation.asset.id, url: nil, width: operation.asset.width, height: operation.asset.height, state: "failed"))
    }
    func cancel(ids: [String]) {
        dispatchPrecondition(condition: .onQueue(queue))
        for id in ids { cancelKey(id); cancelKey("thumbnail:\(id)") }
        release(urls: issued.compactMap { ids.contains($0.value) ? $0.key : nil })
    }
    func release(urls: [URL]) {
        dispatchPrecondition(condition: .onQueue(queue))
        for url in urls where issued.removeValue(forKey: url) != nil {
            try? FileManager.default.removeItem(at: url.deletingLastPathComponent())
        }
    }
    func clear() {
        dispatchPrecondition(condition: .onQueue(queue))
        for key in Array(pending.keys) { cancelKey(key) }
        try? FileManager.default.removeItem(at: thumbs)
        try? FileManager.default.removeItem(at: originals)
        issued.removeAll()
    }
    func evict() {
        dispatchPrecondition(condition: .onQueue(queue))
        let keys: [URLResourceKey] = [.fileSizeKey, .contentModificationDateKey, .isRegularFileKey]
        let files = (try? FileManager.default.contentsOfDirectory(at: thumbs, includingPropertiesForKeys: keys)) ?? []
        let entries = files.compactMap { url -> (URL, Int, Date)? in
            guard let value = try? url.resourceValues(forKeys: Set(keys)), value.isRegularFile == true else { return nil }
            return (url, value.fileSize ?? 0, value.contentModificationDate ?? .distantPast)
        }.sorted { $0.2 < $1.2 }
        var total = entries.reduce(0) { $0 + $1.1 }
        for (url, size, _) in entries where total > budget {
            if (try? FileManager.default.removeItem(at: url)) != nil { total -= size }
        }
    }
}
