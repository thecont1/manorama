import XCTest

@testable import ManoramaEventClustering

/*
 * The header-reading rules, tested without a single image file.
 *
 * These are the cases real backups actually contain — a phone that wrote
 * its offset, a mirrorless body that did not, GPS in degrees-minutes-
 * seconds, a chip with no fix that wrote zeros, and a PNG with no camera
 * in it. Each one is a wrong-timestamp or wrong-place bug that would
 * silently reshape the user's timeline, which is exactly why the parsing
 * is a pure function of a dictionary rather than a side effect of ImageIO.
 */
final class DumpMetadataParserTests: XCTestCase {
    private var utc: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        return calendar
    }

    // MARK: - Timestamps

    func testDateTimeOriginalHonoursOffsetTimeOriginal() throws {
        // 08:45 in Tokyo is the previous evening in Greenwich.
        let date = try XCTUnwrap(DumpMetadataParser.captureDate(
            exif: ["DateTimeOriginal": "2026:03:14 08:45:12", "OffsetTimeOriginal": "+09:00"],
            localCalendar: utc
        ))
        let expected = utc.date(from: { var c = DateComponents(); c.year = 2026; c.month = 3; c.day = 13; c.hour = 23; c.minute = 45; c.second = 12; return c }())!
        XCTAssertEqual(date, expected)
    }

    func testNegativeOffsetAndZulu() {
        let east = DumpMetadataParser.captureDate(exif: ["DateTimeOriginal": "2026:01:01 00:30:00", "OffsetTimeOriginal": "+05:30"], localCalendar: utc)
        let west = DumpMetadataParser.captureDate(exif: ["DateTimeOriginal": "2026:01:01 00:30:00", "OffsetTimeOriginal": "-0800"], localCalendar: utc)
        let zulu = DumpMetadataParser.captureDate(exif: ["DateTimeOriginal": "2026:01:01 00:30:00", "OffsetTimeOriginal": "Z"], localCalendar: utc)
        XCTAssertEqual(east, utc.date(from: { var c = DateComponents(); c.year = 2025; c.month = 12; c.day = 31; c.hour = 19; c.minute = 0; return c }()))
        XCTAssertEqual(west, utc.date(from: { var c = DateComponents(); c.year = 2026; c.month = 1; c.day = 1; c.hour = 8; c.minute = 30; return c }()))
        XCTAssertEqual(zulu, utc.date(from: { var c = DateComponents(); c.year = 2026; c.month = 1; c.day = 1; c.hour = 0; c.minute = 30; return c }()))
    }

    func testHeaderWithoutOffsetIsReadInTheLocalCalendar() {
        // The fallback the plan specifies: EXIF with no zone is read as if
        // the camera and the indexer shared a clock. Wrong across timezones,
        // and the only honest guess available.
        let date = DumpMetadataParser.captureDate(exif: ["DateTimeOriginal": "2026:06:01 14:00:00"], localCalendar: utc)
        XCTAssertEqual(date?.timeIntervalSince1970, utc.date(from: { var c = DateComponents(); c.year = 2026; c.month = 6; c.day = 1; c.hour = 14; return c }())!.timeIntervalSince1970)
    }

    func testIsoVariantAndDigitizedFallback() throws {
        // Tools that rewrite headers (Google Takeout, some importers) emit
        // the ISO form; some bodies only write DateTimeDigitized.
        let iso = try XCTUnwrap(DumpMetadataParser.captureDate(exif: ["DateTimeOriginal": "2026-06-01T14:00:00", "OffsetTimeOriginal": "+02:00"], localCalendar: utc))
        let isoExpected = utc.date(from: { var c = DateComponents(); c.year = 2026; c.month = 6; c.day = 1; c.hour = 12; c.minute = 0; return c }())!
        XCTAssertEqual(iso, isoExpected, "14:00 in a +02:00 zone is 12:00 UTC")
        let digitized = DumpMetadataParser.captureDate(exif: ["DateTimeDigitized": "2026:06:01 12:00:00", "OffsetTimeOriginal": "Z"], localCalendar: utc)
        XCTAssertNotNil(digitized)
    }

    func testGarbageAndMissingHeadersAnswerNil() {
        XCTAssertNil(DumpMetadataParser.captureDate(exif: [:], localCalendar: utc))
        XCTAssertNil(DumpMetadataParser.captureDate(exif: ["DateTimeOriginal": ""], localCalendar: utc))
        XCTAssertNil(DumpMetadataParser.captureDate(exif: ["DateTimeOriginal": "not a date"], localCalendar: utc))
        XCTAssertNil(DumpMetadataParser.captureDate(exif: ["DateTimeOriginal": "2026:06"], localCalendar: utc))
    }

    func testFractionalSecondsDoNotBreakParsing() {
        let date = DumpMetadataParser.captureDate(exif: ["DateTimeOriginal": "2026:06:01 14:00:45.500000", "OffsetTimeOriginal": "Z"], localCalendar: utc)
        XCTAssertEqual(date, utc.date(from: { var c = DateComponents(); c.year = 2026; c.month = 6; c.day = 1; c.hour = 14; c.minute = 0; c.second = 45; return c }()))
    }

    // MARK: - GPS

    func testDecimalDegreesWithReferences() throws {
        let south = try XCTUnwrap(DumpMetadataParser.coordinate(gps: ["Latitude": 33.87, "LatitudeRef": "S", "Longitude": 151.2, "LongitudeRef": "W"]))
        XCTAssertEqual(south.latitude, -33.87, accuracy: 0.0001)
        XCTAssertEqual(south.longitude, -151.2, accuracy: 0.0001)
    }

    func testDegreesMinutesSecondsTriples() throws {
        let gps: [String: Any] = [
            "Latitude": [18.0, 31.0, 30.0],
            "LatitudeRef": "N",
            "Longitude": [73.0, 51.0, 22.0],
            "LongitudeRef": "E",
        ]
        let coordinate = try XCTUnwrap(DumpMetadataParser.coordinate(gps: gps))
        XCTAssertEqual(coordinate.latitude, 18 + 31 / 60.0 + 30 / 3600.0, accuracy: 0.0002)
        XCTAssertEqual(coordinate.longitude, 73 + 51 / 60.0 + 22 / 3600.0, accuracy: 0.0002)
    }

    func testNullIslandIsRejected() {
        // An unset chip writes 0/0, which would otherwise read as 300 km
        // from any hometown and turn every photo into "travel".
        XCTAssertNil(DumpMetadataParser.coordinate(gps: ["Latitude": 0.0, "Longitude": 0.0]))
        XCTAssertNil(DumpMetadataParser.coordinate(gps: ["Latitude": 0.0, "Longitude": 0.0, "LatitudeRef": "N", "LongitudeRef": "E"]))
        // And the core agrees, so the two layers cannot disagree about it.
        let item = MediaMetadataItem(id: "x", timestamp: Date(timeIntervalSince1970: 0), latitude: 0, longitude: 0)
        XCTAssertNil(item.coordinate)
    }

    func testOutOfRangeCoordinatesAreRejected() {
        XCTAssertNil(DumpMetadataParser.coordinate(gps: ["Latitude": 95.0, "Longitude": 10.0]))
        XCTAssertNil(DumpMetadataParser.coordinate(gps: ["Latitude": 10.0, "Longitude": 190.0]))
    }

    // MARK: - Screenshots

    func testScreenshotRules() {
        // A screen capture: no camera in the header, PNG container.
        XCTAssertTrue(DumpMetadataParser.isScreenshot(tiff: [:], pathExtension: "png", fileName: "Screenshot 2026-03-14 at 21.04.11.png"))
        XCTAssertTrue(DumpMetadataParser.isScreenshot(tiff: [:], pathExtension: "png", fileName: "Shot-0001.png"))
        XCTAssertTrue(DumpMetadataParser.isScreenshot(tiff: [:], pathExtension: "jpg", fileName: "Screen Shot at noon.jpg"))
        // A photograph keeps its even if the folder renamed it.
        XCTAssertFalse(DumpMetadataParser.isScreenshot(tiff: ["Make": "Canon", "Model": "EOS R5"], pathExtension: "png", fileName: "Screenshot.png"))
        // A stripped JPEG from the web is not a screenshot and says so.
        XCTAssertFalse(DumpMetadataParser.isScreenshot(tiff: [:], pathExtension: "jpg", fileName: "IMG_2048.jpg"))
    }

    // MARK: - Properties bridging

    func testHeaderDictionaryShapeMatchesImageIO() throws {
        let properties: [String: Any] = [
            "{Exif}": ["DateTimeOriginal": "2026:03:14 20:40:00", "OffsetTimeOriginal": "+05:30"],
            "{TIFF}": ["Make": "Apple", "Model": "iPhone 17 Pro"],
            "{GPS}": ["Latitude": 18.51, "LatitudeRef": "N", "Longitude": 73.85, "LongitudeRef": "E"],
        ]
        let header = ImageHeaderProperties(from: properties)
        let date = DumpMetadataParser.captureDate(exif: header.exif, localCalendar: utc)
        XCTAssertEqual(date, utc.date(from: { var c = DateComponents(); c.year = 2026; c.month = 3; c.day = 14; c.hour = 15; c.minute = 10; return c }()))
        let coordinate = try XCTUnwrap(DumpMetadataParser.coordinate(gps: header.gps))
        XCTAssertEqual(coordinate.latitude, 18.51, accuracy: 0.0001)
        XCTAssertEqual(coordinate.longitude, 73.85, accuracy: 0.0001)
        XCTAssertFalse(DumpMetadataParser.isScreenshot(tiff: header.tiff, pathExtension: "heic", fileName: "IMG_0042.heic"))
    }
}

// MARK: - GeoMath

final class GeoMathTests: XCTestCase {
    func testHaversineKnownLegs() {
        // Pune to Mumbai, roughly 115 km as the crow flies.
        let km = GeoMath.haversineKm(18.5167, 73.8562, 19.076, 72.8777)
        XCTAssertEqual(km, 118, accuracy: 8)
        // One degree of latitude is ~111 km anywhere.
        XCTAssertEqual(GeoMath.haversineKm(0, 0, 1, 0), 111.2, accuracy: 0.5)
        XCTAssertEqual(GeoMath.haversineKm(18.5, 73.8, 18.5, 73.8), 0, accuracy: 0.0001)
        // Antipodes do not blow the square root.
        XCTAssertLessThan(GeoMath.haversineKm(0, 0, 0, 180), 20_100)
    }

    func testGridCellGroupsNeighboursAndSeparatesCities() {
        XCTAssertEqual(GeoCell(latitude: 18.5167, longitude: 73.8562), GeoCell(latitude: 18.53, longitude: 73.91))
        XCTAssertNotEqual(GeoCell(latitude: 18.5167, longitude: 73.8562), GeoCell(latitude: 19.076, longitude: 72.8777))
    }
}

// MARK: - Index persistence

final class EventIndexTests: XCTestCase {
    private func fingerprint() -> EventIndex.SourceFingerprint {
        EventIndex.SourceFingerprint(
            deviceId: "device-1", sourceId: "folder-1", sourceKind: EventIndex.folderSourceKind,
            label: "Camera Backup", lastIndexedAt: Date(timeIntervalSince1970: 1_760_000_000)
        )
    }

    func testRoundTripThroughJSON() throws {
        let event = EventCluster(
            id: EventClusterer.eventId(sourceId: "folder-1", start: Date(timeIntervalSince1970: 1_760_000_100)),
            startDate: Date(timeIntervalSince1970: 1_760_000_100),
            endDate: Date(timeIntervalSince1970: 1_760_007_100),
            isMultiDay: true,
            coverItemId: "2026/10/b.jpg",
            itemIds: ["2026/10/a.jpg", "2026/10/b.jpg"],
            subDays: [EventDayGroup(id: "2026-10-08", date: Date(timeIntervalSince1970: 1_760_000_100), itemIds: ["2026/10/a.jpg"])]
        )
        let index = EventIndex(
            source: fingerprint(),
            config: ClusteringConfig(),
            itemCache: ["2026/10/a.jpg": MediaMetadataItem(id: "2026/10/a.jpg", timestamp: Date(timeIntervalSince1970: 1_760_000_100), latitude: 18.5, longitude: 73.8, fileModTime: 1_760_000_000)],
            events: [event],
            screenshotItemIds: ["s.png"]
        )
        let decoded = try EventIndex.decode(EventIndex.encode(index))
        XCTAssertEqual(decoded, index)
        XCTAssertEqual(decoded.schemaVersion, EventIndex.schemaVersion)
        XCTAssertEqual(decoded.events.first?.subDays?.first?.id, "2026-10-08")
    }

    func testDatesEncodeAsEpochSeconds() throws {
        // The webview is handed epoch milliseconds; an index that stored
        // ISO-8601 would put two time formats in one chain.
        let index = EventIndex(source: fingerprint(), config: ClusteringConfig())
        let json = String(data: try EventIndex.encode(index), encoding: .utf8)!
        XCTAssertTrue(json.contains("\"lastIndexedAt\":1760000000"), json)
    }

    func testFingerprintMismatchForcesRebuild() {
        let index = EventIndex(source: fingerprint(), config: ClusteringConfig())
        XCTAssertTrue(index.matches(deviceId: "device-1", sourceId: "folder-1"))
        XCTAssertFalse(index.matches(deviceId: "device-2", sourceId: "folder-1"), "another device's index is not this one's memory")
        XCTAssertFalse(index.matches(deviceId: "device-1", sourceId: "folder-2"), "a replaced folder is not the same source")
    }

    func testModTimeComparisonDrivesIncrementalReads() {
        var index = EventIndex(source: fingerprint(), config: ClusteringConfig())
        index.itemCache = [
            "a.jpg": MediaMetadataItem(id: "a.jpg", timestamp: Date(timeIntervalSince1970: 1), fileModTime: 1_000),
            "b.jpg": MediaMetadataItem(id: "b.jpg", timestamp: Date(timeIntervalSince1970: 1), fileModTime: 1_000),
        ]
        XCTAssertFalse(index.needsMetadataRead(id: "a.jpg", fileModTime: 1_000.4), "untouched file, cached header")
        XCTAssertTrue(index.needsMetadataRead(id: "a.jpg", fileModTime: 1_500), "rewritten file")
        XCTAssertTrue(index.needsMetadataRead(id: "c.jpg", fileModTime: 1_000), "new file")
        XCTAssertTrue(index.needsMetadataRead(id: "b.jpg", fileModTime: nil), "unreadable mod time is looked at, not trusted")
    }

    func testPruningRemovesGoneFilesFromCacheButNotFromEvents() {
        // Events are rebuilt by the next pass rather than patched here:
        // hand-editing membership is how an index ends up claiming nine
        // photographs and showing seven.
        let event = EventCluster(id: "evt_x", startDate: Date(timeIntervalSince1970: 1), endDate: Date(timeIntervalSince1970: 2), isMultiDay: false, coverItemId: "a.jpg", itemIds: ["a.jpg", "gone.jpg"])
        var index = EventIndex(source: fingerprint(), config: ClusteringConfig(), events: [event], screenshotItemIds: ["s1.png", "gone.png"])
        index.itemCache = ["a.jpg": MediaMetadataItem(id: "a.jpg", timestamp: Date(timeIntervalSince1970: 1)), "gone.jpg": MediaMetadataItem(id: "gone.jpg", timestamp: Date(timeIntervalSince1970: 2))]
        let pruned = index.pruning(absentIds: ["gone.jpg", "gone.png"])
        XCTAssertEqual(pruned.itemCache.keys.sorted(), ["a.jpg"])
        XCTAssertEqual(pruned.screenshotItemIds, ["s1.png"])
        XCTAssertEqual(pruned.events, [event])
    }

    func testConfigDefaultsAreThePlanAndRoundTrip() throws {
        let config = ClusteringConfig()
        XCTAssertEqual(config.sessionGapHours, 3.5)
        XCTAssertEqual(config.sessionDistanceKm, 5.0)
        XCTAssertEqual(config.transitBypassMinutes, 45.0)
        XCTAssertEqual(config.tripDistanceFromHomeKm, 50.0)
        XCTAssertEqual(config.tripOvernightGapHours, 18.0)
        XCTAssertEqual(config.burstThresholdSeconds, 3.0)
        var tuned = config
        tuned.sessionGapHours = 5
        let data = try JSONEncoder().encode(tuned)
        XCTAssertEqual(try JSONDecoder().decode(CloningAlias.self, from: data), tuned)
    }

    /// A named alias, so the round-trip also proves the type is
    /// `Codable` under its own name rather than by inference.
    typealias CloningAlias = ClusteringConfig
}
