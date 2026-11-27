import CoreGraphics
import Foundation
import ImageIO

let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let prefix = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : "event-demo-"
try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
let dates = [
    "2026:03:14 19:30:00", "2026:03:14 20:10:00", "2026:03:14 22:00:00",
    "2026:03:15 08:00:00", "2026:03:15 09:10:00", "2026:03:15 19:00:00", "2026:03:15 19:25:00",
]
let colors: [(Double, Double, Double)] = [
    (0.30, 0.40, 0.55), (0.35, 0.40, 0.50), (0.40, 0.45, 0.55),
    (0.30, 0.55, 0.40), (0.35, 0.60, 0.45), (0.60, 0.40, 0.25), (0.65, 0.45, 0.30),
]
let formatter = DateFormatter()
formatter.locale = Locale(identifier: "en_US_POSIX")
formatter.dateFormat = "yyyy:MM:dd HH:mm:ss"
formatter.timeZone = TimeZone(secondsFromGMT: 0)

for (index, date) in dates.enumerated() {
    let width = 2048, height = 1365
    let color = colors[index]
    let space = CGColorSpace(name: CGColorSpace.sRGB)!
    let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
        bytesPerRow: 0, space: space, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    context.setFillColor(CGColor(red: color.0, green: color.1, blue: color.2, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    context.setFillColor(CGColor(red: color.0 * 0.5, green: color.1 * 0.5, blue: color.2 * 0.5, alpha: 1))
    context.fill(CGRect(x: 0, y: height / 3, width: width, height: height / 4))
    let image = context.makeImage()!
    let url = root.appendingPathComponent(String(format: "%@%02d.jpg", prefix, index + 1))
    let destination = CGImageDestinationCreateWithURL(url as CFURL, "public.jpeg" as CFString, 1, nil)!
    let properties: [String: Any] = [
        kCGImagePropertyExifDictionary as String: ["DateTimeOriginal": date, "OffsetTimeOriginal": "+00:00"],
        kCGImagePropertyTIFFDictionary as String: ["Make": "Event test fixture", "Model": "Synthetic RGB"],
        kCGImagePropertyOrientation as String: 1,
    ]
    CGImageDestinationAddImage(destination, image, properties as CFDictionary)
    guard CGImageDestinationFinalize(destination) else { fatalError("fixture write failed") }
    let timestamp = formatter.date(from: date)!
    try FileManager.default.setAttributes([.creationDate: timestamp, .modificationDate: timestamp], ofItemAtPath: url.path)
}
print("Prepared seven synthetic camera-roll originals across three time-separated sessions")
