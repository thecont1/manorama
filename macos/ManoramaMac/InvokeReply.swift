import Foundation

/// The invoke reply contract the bridge hands back to the page.
///
/// `value` is present on every successful reply — `null` when the command
/// returned nothing — because the page's own contract is "absent means
/// `null`": the vault's verified purge reads a key back with
/// `keys.get(name) !== null`, and a reply that *omitted* `value` would
/// deliver `undefined`, which that check reads as a surviving key. Tauri's
/// `Ok(None)` serialises as `null`, so this keeps the shells interchangeable.
enum InvokeReplyEncoding {
    static func payload(id: Int, ok: Bool, value: Any? = nil, error: String? = nil) -> [String: Any] {
        var payload: [String: Any] = ["id": id, "ok": ok]
        if ok { payload["value"] = value ?? NSNull() }
        if let error { payload["error"] = error }
        return payload
    }
}
