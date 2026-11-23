import CryptoKit
import Foundation

/*
 * One hash function, named, so event identities and source fingerprints
 * are computed the same way on every platform — and so a future Rust or
 * TypeScript port has an obvious counterpart instead of an invented one.
 *
 * `CryptoKit` is a system framework: no bytes join the app bundle, which
 * is the constraint that rules out an ML package and not a hash.
 */

enum SHA256Digest {
    /// Lowercase hex of the SHA-256 of a UTF-8 string.
    static func hex(_ text: String) -> String {
        digest(Data(text.utf8))
    }

    static func digest(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}
