import Foundation

/*
 * Turning an image header into a `MediaMetadataItem` field set.
 *
 * Deliberately free of ImageIO: the macOS shell hands this parser the
 * property dictionaries it already read, and the parser's job is the
 * awkward part — EXIF's date format, its split timezone, GPS expressed
 * either as a decimal or as degrees/minutes/seconds, and the question of
 * whether a PNG is a photograph or a screen capture. That logic is what
 * deserves tests, and it is portable to the TypeScript and Rust ports
 * only while it stays away from Apple's headers.
 */

/*
 * The three header dictionaries the parser reads, as ImageIO names them.
 *
 * Not `Sendable`, and not by oversight: the payloads are CF object
 * bridges whose elements the compiler cannot prove immutable. A header is
 * read on the thread that will parse it and never handed across one, so
 * the conformance would be a claim, not a fact.
 */
public struct ImageHeaderProperties {
    public let exif: [String: Any]
    public let tiff: [String: Any]
    public let gps: [String: Any]

    public init(exif: [String: Any] = [:], tiff: [String: Any] = [:], gps: [String: Any] = [:]) {
        self.exif = exif
        self.tiff = tiff
        self.gps = gps
    }

    /// ImageIO nests these under brace-wrapped dictionary names, which are
    /// the raw values of `kCGImagePropertyExifDictionary`,
    /// `kCGImagePropertyTIFFDictionary` and `kCGImagePropertyGPSDictionary`.
    /// Spelled as literals rather than imported so this file stays
    /// Foundation-only; a typo here is caught by the parser's own tests.
    public init(from properties: [String: Any]) {
        self.exif = (properties["{Exif}"] as? [String: Any]) ?? [:]
        self.tiff = (properties["{TIFF}"] as? [String: Any]) ?? [:]
        self.gps = (properties["{GPS}"] as? [String: Any]) ?? [:]
    }
}

public enum DumpMetadataParser {
    // MARK: - Timestamp

    /// EXIF's `DateTimeOriginal`, honoured with the offset it was shot at.
    ///
    /// Two traps, both common in real camera rolls:
    ///
    ///  - `DateTimeOriginal` has no zone at all and looks like
    ///    `2026:11:23 14:31:02`. The zone lives in `OffsetTimeOriginal`
    ///    (Exif 2.3), which newer phones and mirrorless bodies write and
    ///    older ones do not.
    ///  - a photo taken in Tokyo and indexed in Pune is the same instant;
    ///    reading the local clock as local time would move it eleven hours
    ///    and split a real trip in two. When the offset exists it wins.
    ///
    /// With no offset, the timestamp is interpreted in `localCalendar`,
    /// which is what a backup folder of an unknown-origin camera roll can
    /// honestly do.
    public static func captureDate(
        exif: [String: Any],
        localCalendar: Calendar = .current
    ) -> Date? {
        guard let raw = exif["DateTimeOriginal"] as? String ?? exif["DateTimeDigitized"] as? String else {
            return nil
        }
        let text = raw.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else { return nil }

        // A header that will not parse answers nil. Reading "now" instead
        // would file the photograph under today's date and graft it onto
        // whatever event is happening this week — the scanner's fallback
        // chain (creation date, modification date) is the next chance,
        // and inventing a timestamp is not one of them.
        guard let components = dateComponents(from: text), components.year != nil else { return nil }

        var calendar = localCalendar
        if let offset = tzOffsetSeconds(exif["OffsetTimeOriginal"] as? String ?? exif["OffsetTime"] as? String) {
            calendar.timeZone = TimeZone(secondsFromGMT: offset) ?? localCalendar.timeZone
        }
        // A date parsed from a header is only as good as its fields; a
        // missing subsecond is 0, and that is fine for grouping.
        return calendar.date(from: components)
    }

    /// `2026:11:23 14:31:02`, and the ISO-ish variant some tools rewrite
    /// it to. Hand-rolled rather than a `DateFormatter` because a
    /// formatter's success depends on the machine's locale and the
    /// Gregorian calendar being what the header meant.
    static func dateComponents(from text: String) -> DateComponents? {
        let normalized = text.replacingOccurrences(of: "T", with: " ")
        let parts = normalized.split(separator: " ", maxSplits: 1, omittingEmptySubsequences: true)
        guard parts.count == 2 else { return nil }

        let dateParts = parts[0].split(separator: ":").flatMap { $0.split(separator: "-") }
        let timeParts = parts[1].split(separator: ":")
        guard dateParts.count == 3, timeParts.count >= 2 else { return nil }
        guard let year = Int(dateParts[0]), let month = Int(dateParts[1]), let day = Int(dateParts[2]) else { return nil }
        guard let hour = Int(timeParts[0]), let minute = Int(timeParts[1]) else { return nil }
        // Seconds can carry a fractional tail ("45.500000") from tools
        // that wrote SubsecTime into the field instead of beside it.
        let secondText = timeParts.count > 2 ? String(timeParts[2]) : "0"
        let second = Int(secondText.split(separator: ".").first.map(String.init) ?? "0") ?? 0

        var components = DateComponents()
        components.year = year
        components.month = month
        components.day = day
        components.hour = hour
        components.minute = minute
        components.second = second
        return components
    }

    /// `+05:30` / `-0800` / `Z` as seconds east of Greenwich.
    static func tzOffsetSeconds(_ text: String?) -> Int? {
        guard let raw = text?.trimmingCharacters(in: .whitespaces), !raw.isEmpty else { return nil }
        if raw == "Z" || raw == "z" { return 0 }
        let sign: Int
        let body: Substring
        switch raw.first {
        case "+": sign = 1; body = raw.dropFirst()
        case "-": sign = -1; body = raw.dropFirst()
        default: sign = 1; body = Substring(raw)
        }
        let digits = body.replacingOccurrences(of: ":", with: "")
        guard digits.count >= 2, let hours = Int(digits.prefix(2)) else { return nil }
        let minutes = digits.count >= 4 ? (Int(digits.dropFirst(2).prefix(2)) ?? 0) : 0
        guard hours < 24, minutes < 60 else { return nil }
        return sign * (hours * 3600 + minutes * 60)
    }

    // MARK: - GPS

    /// Latitude/longitude in decimal degrees, or nil when the header has
    /// no usable fix.
    ///
    /// ImageIO answers `kCGImagePropertyGPSLatitude` as a Double already,
    /// but a header written by other tooling can carry the raw
    /// degrees/minutes/seconds triples instead, and the reference letters
    /// are separate fields — so both shapes are handled and both are
    /// signed by their `N/S`/`E/W`.
    ///
    /// A (0, 0) pair is rejected rather than trusted. That is what an
    /// unset GPS chip writes, and treating it as a coordinate in the Gulf
    /// of Guinea would turn a whole camera roll into "far from home".
    public static func coordinate(gps: [String: Any]) -> (latitude: Double, longitude: Double)? {
        guard let rawLat = decimal(gps["Latitude"]), let rawLon = decimal(gps["Longitude"]) else { return nil }
        let lat = rawLat * (gps["LatitudeRef"] as? String == "S" ? -1 : 1)
        let lon = rawLon * (gps["LongitudeRef"] as? String == "W" ? -1 : 1)
        guard abs(lat) <= 90, abs(lon) <= 180 else { return nil }
        guard abs(lat) > 0.0001 || abs(lon) > 0.0001 else { return nil }
        return (lat, lon)
    }

    /// A header value as a Double — scalar, or the DMS triple EXIF uses
    /// before ImageIO flattens it.
    static func decimal(_ value: Any?) -> Double? {
        if let number = value as? NSNumber { return number.doubleValue }
        if let text = value as? String { return Double(text) }
        if let parts = value as? [Any], parts.count == 3 {
            // Degrees, minutes, seconds; each may itself be a rational.
            guard let degrees = scalar(parts[0]), let minutes = scalar(parts[1]), let seconds = scalar(parts[2]) else { return nil }
            return degrees + minutes / 60 + seconds / 3600
        }
        return nil
    }

    private static func scalar(_ value: Any) -> Double? {
        if let number = value as? NSNumber { return number.doubleValue }
        if let text = value as? String { return Double(text) }
        return nil
    }

    // MARK: - Screenshots

    /// Whether a file in a backup folder is a screen capture.
    ///
    /// The honest signal — `mediaSubtypes.contains(.photoScreenshot)` —
    /// is PhotoKit-only and does not survive the trip into a Drive backup,
    /// so a Mac infers it. A photograph has camera make and model in its
    /// TIFF IFD; a screenshot has neither. Combine that with the container
    /// and the filename the OS wrote, and the rule is: no camera make and
    /// no camera model, and either a PNG or a name the screenshot tools
    /// use. Screenshots in a camera roll are overwhelmingly PNG, and a
    /// JPEG without make/model is far more likely a stripped web save
    /// than a photograph, so a false positive here costs little — the
    /// frame leaves the events, it does not leave the app.
    public static func isScreenshot(tiff: [String: Any], pathExtension: String, fileName: String) -> Bool {
        let hasCamera = (tiff["Make"] as? String)?.trimmingCharacters(in: .whitespaces).isEmpty == false
            || (tiff["Model"] as? String)?.trimmingCharacters(in: .whitespaces).isEmpty == false
        if hasCamera { return false }

        let name = fileName.lowercased()
        if name.hasPrefix("screenshot") || name.hasPrefix("screen shot") || name.contains("screenshot") {
            return true
        }
        let ext = pathExtension.lowercased()
        return ext == "png"
    }
}
