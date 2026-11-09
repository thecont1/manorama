import Foundation

/// A tiny append-only trace for the native shell.
///
/// The boundary test needs to see what the shell actually sent to the page
/// and what the page reported back — a screenshot shows the result but not
/// the cause. The file is only written when the app is launched with
/// `--trace`, so a normal run leaves nothing behind.
enum Trace {
    // NSTemporaryDirectory() resolves inside the app container when sandboxed
    // (a literal "/tmp/…" is denied under the App Store sandbox); outside it
    // it is the per-user tempdir — either way the file stays reachable.
    private static let path = NSTemporaryDirectory() + "manorama-mac-trace.log"
    private static let enabled = CommandLine.arguments.contains("--trace")

    static var isEnabled: Bool { enabled }

    static func log(_ message: String) {
        guard enabled else { return }
        let line = "\(Date().timeIntervalSince1970) \(message)\n"
        if let handle = FileHandle(forWritingAtPath: path) {
            handle.seekToEndOfFile()
            handle.write(Data(line.utf8))
            try? handle.close()
        } else {
            try? Data(line.utf8).write(to: URL(fileURLWithPath: path))
        }
    }
}
