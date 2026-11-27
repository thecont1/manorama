import Foundation
import ImageIO
import Vision

enum BridgeError: LocalizedError {
    case failed(String)

    var errorDescription: String? {
        switch self {
        case .failed(let message): return message
        }
    }
}

struct NativeFileIdentity: Codable, Hashable {
    let device: UInt64
    let inode: UInt64

    init(device: UInt64, inode: UInt64) {
        self.device = device
        self.inode = inode
    }

    init?(_ metadata: stat) {
        self.device = UInt64(bitPattern: Int64(metadata.st_dev))
        self.inode = metadata.st_ino
    }
}

enum LocalMediaResolver {
    static func mimeType(for pathExtension: String) -> String {
        switch pathExtension.lowercased() {
        case "jpg", "jpeg": return "image/jpeg"
        case "png": return "image/png"
        case "webp": return "image/webp"
        case "avif": return "image/avif"
        case "heic": return "image/heic"
        case "heif": return "image/heif"
        default: return "application/octet-stream"
        }
    }
}

enum NativeBridge {
    static func write0600(to url: URL, data: Data) throws {
        try data.write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
}

@main
struct CorpusScanner {
    static func main() throws {
        let arguments = CommandLine.arguments
        guard arguments.count >= 4 else {
            throw BridgeError.failed("usage: scan-event-corpus <originals> <scratch> <folder>...")
        }
        let originals = URL(fileURLWithPath: arguments[1], isDirectory: true)
        let scratch = URL(fileURLWithPath: arguments[2], isDirectory: true)
        let names = Array(arguments[3...]).sorted()
        var reports: [String: Any] = [:]

        for (index, name) in names.enumerated() {
            let folderLabel = String(format: "folder-%02d", index + 1)
            let config = scratch.appendingPathComponent(folderLabel, isDirectory: true)
            try FileManager.default.createDirectory(at: config, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: config) }
            let store = RawDumpEventStore(configDir: config)
            let started = Date()
            let outcome = try store.scan(
                root: originals.appendingPathComponent(name, isDirectory: true),
                deviceId: "aggregate-device",
                sourceId: "aggregate-\(folderLabel)",
                label: folderLabel,
                force: true
            )
            let clusters = outcome.report.clusters
            let report: [String: Any] = [
                "itemCount": clusters.reduce(0) { $0 + $1.itemIds.count },
                "eventCount": clusters.count,
                "largestEventSizes": Array(clusters.map { $0.itemIds.count }.sorted(by: >).prefix(8)),
                "multiDayCount": clusters.filter(\.isMultiDay).count,
                "subDayEventCount": clusters.filter { $0.subDays?.isEmpty == false }.count,
                "screenshotCount": outcome.report.screenshotCount,
                "metadataReadCount": outcome.report.metadataReadCount,
                "elapsedMilliseconds": Int(Date().timeIntervalSince(started) * 1000),
            ]
            reports[folderLabel] = report
        }
        let output = try JSONSerialization.data(withJSONObject: reports, options: [.prettyPrinted, .sortedKeys])
        print(String(decoding: output, as: UTF8.self))
    }
}
