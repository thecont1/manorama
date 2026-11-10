// Lists on-screen windows (id, layer, owner, title, bounds) so a capture can
// target the app's own window by id instead of guessing a screen region.
// CoreGraphics window geometry is readable without Accessibility permission.
import CoreGraphics
import Foundation

let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
guard let windows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
  FileHandle.standardError.write("window list unavailable\n".data(using: .utf8)!)
  exit(1)
}

for window in windows {
  let owner = window[kCGWindowOwnerName as String] as? String ?? ""
  let title = window[kCGWindowName as String] as? String ?? ""
  let number = window[kCGWindowNumber as String] as? Int ?? 0
  let layer = window[kCGWindowLayer as String] as? Int ?? -1
  let bounds = window[kCGWindowBounds as String] as? [String: Any] ?? [:]
  let x = bounds["X"] as? Double ?? 0
  let y = bounds["Y"] as? Double ?? 0
  let width = bounds["Width"] as? Double ?? 0
  let height = bounds["Height"] as? Double ?? 0
  print("\(number)\tlayer=\(layer)\t\(owner)\t\(title)\t\(Int(x)),\(Int(y))\t\(Int(width))x\(Int(height))")
}