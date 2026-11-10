import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

/// Focus and readout probes for the native shell.
///
/// The boundary test needs to answer three questions that a screenshot
/// cannot:
///
///   * WHERE is keyboard focus — in the native sidebar, or inside the
///     WKWebView? The chain is walked up to the first AXWebArea, so the
///     answer is "web" or "native" rather than a role name.
///   * WHAT does the shell think the position is? The native status bar
///     and the web viewer both print "N of M", so each match is reported
///     with the same web/native classification — otherwise the test would
///     read the web surface's readout and call it the shell's.
///   * CAN the shell be driven from the keyboard? Keys are posted to the
///     frontmost app, exactly as a person's keystroke would be.
///
/// Usage:
///   focusprobe <bundleId> focus
///   focusprobe <bundleId> readout
///   focusprobe <bundleId> tree
///   focusprobe <bundleId> key <virtualKeyCode> [repeat] [alt] [cmd]
///   focusprobe <bundleId> click <x> <y>
///   focusprobe <bundleId> press <Menu> <Item>

let bundleId = CommandLine.arguments.count >= 2
    ? CommandLine.arguments[1]
    : "in.thecontrarian.manorama.desktop"
let command = CommandLine.arguments.count >= 3 ? CommandLine.arguments[2] : "focus"

guard AXIsProcessTrusted() else {
    FileHandle.standardError.write("AX not trusted\n".data(using: .utf8)!)
    exit(2)
}

func value<T>(_ element: AXUIElement, _ attribute: String, as: T.Type) -> T? {
    var v: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &v) == .success else { return nil }
    return v as? T
}

func children(_ element: AXUIElement) -> [AXUIElement] {
    value(element, kAXChildrenAttribute, as: [AXUIElement].self) ?? []
}

func role(_ element: AXUIElement) -> String {
    value(element, kAXRoleAttribute, as: String.self) ?? "?"
}

func title(_ element: AXUIElement) -> String {
    value(element, kAXTitleAttribute, as: String.self)
        ?? value(element, kAXDescriptionAttribute, as: String.self)
        ?? value(element, kAXValueAttribute, as: String.self)
        ?? ""
}

func parent(_ element: AXUIElement) -> AXUIElement? {
    value(element, kAXParentAttribute, as: AXUIElement.self)
}

/// Read an AXValue attribute (AXPosition, AXSize) as a CGPoint/CGSize.
///
/// These attributes do NOT come back as a dictionary — they come back as
/// an AXValue wrapping a CGPoint or CGSize. Casting them to
/// `[String: Any]` fails silently and every geometric lookup returns
/// nil, which looks exactly like "the element has no position".
func axValue<T>(_ element: AXUIElement, _ attribute: String, as type: AXValueType) -> T? {
    var v: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &v) == .success,
          let raw = v,
          CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
    let ax = raw as! AXValue
    if type == .cgPoint {
        var point = CGPoint.zero
        guard AXValueGetValue(ax, .cgPoint, &point) else { return nil }
        return point as? T
    }
    var size = CGSize.zero
    guard AXValueGetValue(ax, .cgSize, &size) else { return nil }
    return size as? T
}

func axPoint(_ element: AXUIElement, _ attribute: String) -> CGPoint? {
    axValue(element, attribute, as: .cgPoint)
}

func axSize(_ element: AXUIElement, _ attribute: String) -> CGSize? {
    axValue(element, attribute, as: .cgSize)
}

/// Is this element inside the WKWebView's web area, or in the native chrome?
///
/// The chain is walked to the window. The first AXWebArea found means the
/// element belongs to the web surface; anything else is native.
func domain(_ element: AXUIElement) -> String {
    var node: AXUIElement? = element
    var depth = 0
    while let current = node, depth < 20 {
        if role(current) == "AXWebArea" { return "web" }
        if role(current) == "AXWindow" { return "native" }
        node = parent(current)
        depth += 1
    }
    return "unknown"
}

func describe(_ element: AXUIElement) -> String {
    let r = role(element)
    let t = title(element)
    let label = t.isEmpty ? "-" : t.replacingOccurrences(of: "\n", with: " ")
    return "\(r) \"\(label)\""
}

/// Post a real left click at a screen point.
func click(at point: CGPoint) {
    let source = CGEventSource(stateID: .hidSystemState)
    CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
    usleep(150_000)
    CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
    usleep(70_000)
    CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
}

guard let running = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first else {
    print("app not running")
    exit(1)
}
let app = AXUIElementCreateApplication(running.processIdentifier)
let windows = value(app, kAXWindowsAttribute, as: [AXUIElement].self) ?? []
guard let window = windows.first else {
    print("no window")
    exit(1)
}

func pressKey(_ code: UInt16, repeatCount: Int = 1, alt: Bool = false, cmd: Bool = false) {
    let source = CGEventSource(stateID: .hidSystemState)
    var flags: CGEventFlags = []
    if alt { flags.insert(.maskAlternate) }
    if cmd { flags.insert(.maskCommand) }
    for _ in 0..<repeatCount {
        let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true)
        down?.flags = flags
        down?.post(tap: .cghidEventTap)
        usleep(45_000)
        let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false)
        up?.flags = flags
        up?.post(tap: .cghidEventTap)
        usleep(45_000)
    }
}

switch command {
case "focus":
    guard let focused = value(app, kAXFocusedUIElementAttribute, as: AXUIElement.self) else {
        print("focus: none")
        exit(0)
    }
    print("focus: \(domain(focused)) \(describe(focused))")
    var node = focused
    for depth in 0..<6 {
        guard let next = parent(node) else { break }
        node = next
        print("  +\(depth + 1) \(describe(node))")
    }

case "readout":
    // Every "N of M" in the window, each labelled with its domain. The
    // native status bar and the web viewer both print one.
    var found: [(String, String, String)] = []
    func walk(_ element: AXUIElement, depth: Int) {
        guard depth < 14 else { return }
        let r = role(element)
        let t = title(element)
        if r == "AXStaticText" || r == "AXTextField" {
            if t.range(of: #"^\s*\d+\s+of\s+\d+\s*$"#, options: .regularExpression) != nil {
                found.append((t.trimmingCharacters(in: .whitespaces), domain(element), r))
            }
        }
        for child in children(element) { walk(child, depth: depth + 1) }
    }
    walk(window, depth: 0)
    if found.isEmpty {
        print("readout: none")
    } else {
        for (text, dom, r) in found { print("readout: [\(dom)] \(r) \"\(text)\"") }
    }

case "tree":
    func walk(_ element: AXUIElement, depth: Int) {
        guard depth < 7 else { return }
        let indent = String(repeating: "  ", count: depth)
        print("\(indent)\(role(element))\t\(title(element))")
        for child in children(element) { walk(child, depth: depth + 1) }
    }
    walk(window, depth: 0)

case "web":
    // The web surface's own subtree, deep enough to see the curtain,
    // the chrome, and the viewer's position readout.
    func findWeb(_ element: AXUIElement) -> AXUIElement? {
        if role(element) == "AXWebArea" { return element }
        for child in children(element) {
            if let found = findWeb(child) { return found }
        }
        return nil
    }
    guard let web = findWeb(window) else {
        print("no web area")
        exit(1)
    }
    func walk(_ element: AXUIElement, depth: Int) {
        guard depth < 14 else { return }
        let indent = String(repeating: "  ", count: depth)
        print("\(indent)\(role(element))\t\(title(element))")
        for child in children(element) { walk(child, depth: depth + 1) }
    }
    walk(web, depth: 0)

case "key":
    // key <virtualKeyCode> [repeat] [alt] [cmd]
    guard CommandLine.arguments.count >= 4, let code = UInt16(CommandLine.arguments[3]) else {
        print("usage: key <virtualKeyCode> [repeat] [alt] [cmd]")
        exit(1)
    }
    let times = CommandLine.arguments.count >= 5 ? (Int(CommandLine.arguments[4]) ?? 1) : 1
    let alt = CommandLine.arguments.count >= 6 && CommandLine.arguments[5] == "alt"
    let cmd = CommandLine.arguments.count >= 7 && CommandLine.arguments[6] == "cmd"
    pressKey(code, repeatCount: times, alt: alt, cmd: cmd)
    print("key \(code) x\(times)\(alt ? " alt" : "")\(cmd ? " cmd" : "")")

case "click":
    guard CommandLine.arguments.count >= 5,
          let x = Double(CommandLine.arguments[3]),
          let y = Double(CommandLine.arguments[4]) else {
        print("usage: click <x> <y>")
        exit(1)
    }
    click(at: CGPoint(x: x, y: y))
    print("clicked \(Int(x)),\(Int(y))")

case "clickrow":
    // Click the gallery name in the native sidebar — the way a person
    // picks a gallery from the list.
    //
    // Two things make this awkward. SwiftUI's List rows do not implement
    // AXPress (-25206, actionUnsupported), and they carry no AX frame
    // either, so a click cannot be aimed at the row. The static text
    // inside the row does have a frame, so the click is aimed there.
    // Aiming at the outline instead lands on the toolbar's "Hide
    // Sidebar" button, which collapses the list instead of opening a
    // gallery.
    var label: AXUIElement?
    func findText(_ element: AXUIElement, depth: Int) {
        guard depth < 14, label == nil else { return }
        if role(element) == "AXStaticText", title(element).contains("photograph"),
           axPoint(element, kAXPositionAttribute) != nil {
            label = element
            return
        }
        for child in children(element) { findText(child, depth: depth + 1) }
    }
    findText(window, depth: 0)
    guard let found = label else {
        var labels: [String] = []
        func listLabels(_ element: AXUIElement, depth: Int) {
            guard depth < 14 else { return }
            if role(element) == "AXStaticText" { labels.append(title(element)) }
            for child in children(element) { listLabels(child, depth: depth + 1) }
        }
        listLabels(window, depth: 0)
        print("no gallery label found; labels seen: \(labels)")
        exit(3)
    }
    if let pos = axPoint(found, kAXPositionAttribute), let size = axSize(found, kAXSizeAttribute) {
        click(at: CGPoint(x: pos.x + size.width / 2, y: pos.y + size.height / 2))
        print("clicked gallery label \"\(title(found))\"")
        exit(0)
    }
    let result = AXUIElementPerformAction(found, kAXPressAction as CFString)
    print("press label \"\(title(found))\" → \(result.rawValue) (no frame)")
    exit(result == .success ? 0 : 4)

case "clickweb":
    // Click the middle of the web area, the way a person focuses the
    // photograph they are looking at.
    var webFrame: (x: Double, y: Double, w: Double, h: Double)?
    func findWeb(_ element: AXUIElement) -> Bool {
        if role(element) == "AXWebArea" {
            if let pos = axPoint(element, kAXPositionAttribute),
               let size = axSize(element, kAXSizeAttribute) {
                webFrame = (pos.x, pos.y, size.width, size.height)
            }
            return true
        }
        for child in children(element) where findWeb(child) { return true }
        return false
    }
    findWeb(window)
    if webFrame == nil || webFrame!.w <= 0 || webFrame!.h <= 0 {
        // The web area sometimes reports no frame of its own. Its scroll
        // area is the same rectangle and usually does have one.
        var scrollFrame: (x: Double, y: Double, w: Double, h: Double)?
        func findScroll(_ element: AXUIElement, depth: Int) -> Bool {
            guard depth < 14 else { return false }
            if role(element) == "AXScrollArea",
               let pos = axPoint(element, kAXPositionAttribute),
               let size = axSize(element, kAXSizeAttribute),
               size.width > 200, size.height > 200 {
                scrollFrame = (pos.x, pos.y, size.width, size.height)
                return true
            }
            for child in children(element) where findScroll(child, depth: depth + 1) { return true }
            return false
        }
        findScroll(window, depth: 0)
        webFrame = scrollFrame
    }
    guard let frame = webFrame, frame.w > 0, frame.h > 0 else {
        print("no web area frame")
        exit(3)
    }
    let x = frame.x + frame.w / 2
    let y = frame.y + frame.h / 2
    click(at: CGPoint(x: x, y: y))
    print("clicked web at \(Int(x)),\(Int(y))")

case "pressweb":
    // Press a button inside the web surface by its label.
    let label = CommandLine.arguments.count >= 4 ? CommandLine.arguments[3] : ""
    var target: AXUIElement?
    func find(_ element: AXUIElement, depth: Int) {
        guard depth < 16, target == nil else { return }
        if role(element) == "AXButton", title(element).contains(label) {
            target = element
            return
        }
        for child in children(element) { find(child, depth: depth + 1) }
    }
    find(window, depth: 0)
    guard let button = target else {
        print("web button not found: \(label)")
        exit(3)
    }
    let result = AXUIElementPerformAction(button, kAXPressAction as CFString)
    print("press web \"\(title(button))\" → \(result.rawValue)")
    exit(result == .success ? 0 : 4)

case "picker":
    // Does the viewer's own grid picker open? The `g` key is one of the
    // viewer's shortcuts; in a native shell the web view only receives a
    // key if it holds the keyboard.
    var buttons: [String] = []
    func findButtons(_ element: AXUIElement, depth: Int) {
        guard depth < 16 else { return }
        if role(element) == "AXButton" { buttons.append(title(element)) }
        for child in children(element) { findButtons(child, depth: depth + 1) }
    }
    findButtons(window, depth: 0)
    print("buttons: \(buttons)")

case "texts":
    // Every text in the window, labelled with whether it belongs to the
    // native chrome or the web surface. Used to read the shell's status
    // bar without guessing at its markup.
    func walk(_ element: AXUIElement, depth: Int) {
        guard depth < 14 else { return }
        let r = role(element)
        if r == "AXStaticText" || r == "AXButton" {
            let t = title(element).trimmingCharacters(in: .whitespacesAndNewlines)
            if !t.isEmpty { print("[\(domain(element))] \(r): \(t)") }
        }
        for child in children(element) { walk(child, depth: depth + 1) }
    }
    walk(window, depth: 0)

case "fullscreen":
    // Is the window in its own Space? The Tauri build declares
    // `"fullscreen": true`, so this is the difference between the two
    // shells at a glance.
    let fullscreen = value(window, "AXFullScreen", as: Bool.self) ?? false
    let minimized = value(window, kAXMinimizedAttribute, as: Bool.self) ?? false
    print("fullscreen=\(fullscreen) minimized=\(minimized) title=\(title(window))")

case "menus":
    // Dump the app's menu bar with the key equivalents, so a menu can be
    // compared like for like against another build.
    guard let bar = value(app, kAXMenuBarAttribute, as: AXUIElement.self) else {
        print("no menu bar")
        exit(1)
    }
    for menuItem in children(bar) {
        let menuTitle = title(menuItem)
        var entries: [(String, String)] = []
        for child in children(menuItem) {
            let items = role(child) == "AXMenu" ? children(child) : [child]
            for item in items {
                let key = value(item, kAXMenuItemCmdCharAttribute, as: String.self) ?? ""
                let mods = value(item, kAXMenuItemCmdModifiersAttribute, as: Int.self) ?? 0
                var flags = ""
                if mods & 1 != 0 { flags += "⌘" }
                if mods & 2 != 0 { flags += "⇧" }
                if mods & 4 != 0 { flags += "⌥" }
                if mods & 8 != 0 { flags += "⌃" }
                let shortcut = key.isEmpty ? "" : "\(flags)\(key)"
                entries.append((title(item), shortcut))
            }
        }
        print("\(menuTitle)")
        for (name, shortcut) in entries {
            print("    \(name)\(shortcut.isEmpty ? "" : "    \(shortcut)")")
        }
    }

case "press":
    // Press a menu item by name: `press <Menu> <Item>`.
    let menuName = CommandLine.arguments.count >= 4 ? CommandLine.arguments[3] : ""
    let itemName = CommandLine.arguments.count >= 5 ? CommandLine.arguments[4] : ""
    guard let bar = value(app, kAXMenuBarAttribute, as: AXUIElement.self) else {
        print("no menu bar")
        exit(1)
    }
    for menuItem in children(bar) where title(menuItem) == menuName {
        for child in children(menuItem) {
            let items = role(child) == "AXMenu" ? children(child) : [child]
            for item in items where title(item).contains(itemName) {
                let result = AXUIElementPerformAction(item, kAXPressAction as CFString)
                print("press \(menuName) > \(title(item)) → \(result.rawValue)")
                exit(result == .success ? 0 : 4)
            }
        }
    }
    print("menu item not found: \(menuName) > \(itemName)")
    exit(3)

default:
    print("unknown command")
    exit(1)
}
