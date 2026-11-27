import Foundation
import XCTest

@testable import ManoramaEventClustering

final class GoldenEventFixtureTests: XCTestCase {
    private static let home = (latitude: 18.5167, longitude: 73.8562)
    private static let away = (latitude: 20.2954, longitude: 73.9846)
    private static let homeCell = FixtureHomeBase(latitude: 18.5, longitude: 73.9)

    private static func date(_ month: Int, _ day: Int, _ hour: Int, _ minute: Int = 0, _ second: Int = 0) -> Date {
        let calendar = try! FixtureCalendar.utc.makeCalendar()
        return calendar.date(from: DateComponents(year: 2026, month: month, day: day, hour: hour, minute: minute, second: second))!
    }

    private static func item(
        _ id: String, _ timestamp: Date, lat: Double? = nil, lon: Double? = nil,
        screenshot: Bool = false, burst: String? = nil, modTime: Double? = nil
    ) -> MediaMetadataItem {
        MediaMetadataItem(
            id: id, timestamp: timestamp, latitude: lat, longitude: lon,
            isScreenshot: screenshot, burstIdentifier: burst, fileModTime: modTime
        )
    }

    private static func atHome(_ id: String, _ timestamp: Date) -> MediaMetadataItem {
        item(id, timestamp, lat: home.latitude, lon: home.longitude)
    }

    private static var homeDays: [MediaMetadataItem] {
        (1...4).map { atHome("home\($0)", date(3, $0, 9)) }
    }

    private static func pair(
        _ name: String, gap: Double, latitude: Double? = nil, config: ClusteringConfig = ClusteringConfig(), count: Int
    ) -> GoldenEventScenario {
        let start = date(6, 1, 10)
        return GoldenEventScenario(
            name: name, config: config,
            items: [atHome("a", start), item("b", start.addingTimeInterval(gap), lat: latitude ?? home.latitude, lon: home.longitude)],
            eventCount: count
        )
    }

    private static func tripPair(_ name: String, first: Date, second: Date, latitude: Double = away.latitude, count: Int) -> GoldenEventScenario {
        GoldenEventScenario(
            name: name,
            items: homeDays + [
                item("away-a", first, lat: latitude, lon: 73.9),
                item("away-b", second, lat: latitude, lon: 73.9),
            ],
            eventCount: count, homeBase: homeCell, multiDayCount: count == 5 ? 1 : 0
        )
    }

    private static let scenarios: [GoldenEventScenario] = {
        var cases: [GoldenEventScenario] = []
        cases.append(GoldenEventScenario(name: "01-dinner-and-drinks", items: [
            atHome("d1", date(3, 14, 19, 30)),
            atHome("d2", date(3, 14, 19, 52)),
            item("d3", date(3, 14, 20, 40), lat: home.latitude + 0.009, lon: home.longitude + 0.012),
            item("d4", date(3, 14, 21, 30), lat: home.latitude + 0.012, lon: home.longitude + 0.017),
            item("d5", date(3, 14, 22, 55), lat: home.latitude + 0.018, lon: home.longitude + 0.011),
            item("d6", date(3, 14, 23, 30), lat: home.latitude + 0.018, lon: home.longitude + 0.011),
        ], eventCount: 1, coverItemId: "d4"))
        cases.append(GoldenEventScenario(name: "02-hike-and-dinner", items: [
            atHome("h1", date(3, 14, 7)),
            item("h2", date(3, 14, 8, 30), lat: home.latitude + 0.01, lon: home.longitude),
            item("h3", date(3, 14, 10), lat: home.latitude + 0.02, lon: home.longitude),
            item("e1", date(3, 14, 16), lat: home.latitude, lon: home.longitude + 0.01),
            item("e2", date(3, 14, 17, 30), lat: home.latitude, lon: home.longitude + 0.01),
            item("e3", date(3, 14, 19), lat: home.latitude, lon: home.longitude + 0.02),
        ], eventCount: 2, coverItemId: "e2"))
        var fourDayTrip = (1...8).map { atHome("home\($0)", date(3, $0, 9)) }
        for day in 1...4 {
            fourDayTrip.append(item("t\(day)a", date(3, 10 + day, 8), lat: away.latitude, lon: away.longitude))
            fourDayTrip.append(item("t\(day)b", date(3, 10 + day, 12), lat: away.latitude + 0.02, lon: away.longitude))
            fourDayTrip.append(item("t\(day)c", date(3, 10 + day, 22), lat: away.latitude, lon: away.longitude + 0.01))
        }
        fourDayTrip.append(atHome("home9", date(3, 16, 8)))
        cases.append(GoldenEventScenario(name: "03-four-day-trip", items: fourDayTrip, eventCount: 10, homeBase: homeCell, multiDayCount: 1))
        cases.append(GoldenEventScenario(name: "04-screenshots-and-bursts-at-dinner", items: [
            atHome("d1", date(3, 14, 19, 30)),
            item("d2", date(3, 14, 20, 10), lat: home.latitude, lon: home.longitude + 0.005),
            item("b1", date(3, 14, 20, 40), lat: home.latitude, lon: home.longitude + 0.005),
            item("b2", date(3, 14, 20, 40, 1), lat: home.latitude, lon: home.longitude + 0.005),
            item("b3", date(3, 14, 20, 40, 2), lat: home.latitude, lon: home.longitude + 0.005),
            item("s1", date(3, 14, 20, 45), lat: home.latitude, lon: home.longitude + 0.005, screenshot: true),
            item("s2", date(3, 14, 21, 2), lat: home.latitude, lon: home.longitude + 0.005, screenshot: true),
            item("d3", date(3, 14, 22), lat: home.latitude, lon: home.longitude + 0.005),
        ], eventCount: 1, coverItemId: "b2"))
        cases.append(pair("05-session-gap-equal", gap: 3.5 * 3600, count: 1))
        cases.append(pair("06-session-gap-above", gap: 3.5 * 3600 + 1, count: 2))
        cases.append(pair("07-session-distance-below", gap: 7200, latitude: home.latitude + 0.044, count: 1))
        cases.append(pair("08-session-distance-above", gap: 7200, latitude: home.latitude + 0.046, count: 2))
        cases.append(pair("09-transit-window-equal", gap: 45 * 60, latitude: home.latitude + 0.5, count: 1))
        cases.append(pair("10-transit-window-above", gap: 45 * 60 + 1, latitude: home.latitude + 0.5, count: 2))
        cases.append(tripPair("11-trip-gap-below", first: date(3, 11, 14), second: date(3, 12, 7, 59, 59), count: 5))
        cases.append(tripPair("12-trip-gap-equal", first: date(3, 11, 14), second: date(3, 12, 8), count: 6))
        cases.append(tripPair("13-trip-distance-below", first: date(3, 11, 22), second: date(3, 12, 8), latitude: 18.94, count: 6))
        cases.append(tripPair("14-trip-distance-above", first: date(3, 11, 22), second: date(3, 12, 8), latitude: 18.96, count: 5))
        var busyHoliday = (1...60).map {
            atHome("h\($0)", date(1, 1, 9).addingTimeInterval(Double($0) * 86400))
        }
        busyHoliday += (0..<200).map {
            item("t\($0)", date(4, 1, 8).addingTimeInterval(Double($0) * 600), lat: away.latitude, lon: away.longitude)
        }
        cases.append(GoldenEventScenario(name: "15-home-days-beat-frame-count", items: busyHoliday, eventCount: 61, homeBase: homeCell))
        let ranking = [
            atHome("h1", date(5, 1, 9)), atHome("h2", date(5, 2, 9)),
            item("a1", date(5, 1, 10), lat: away.latitude, lon: away.longitude),
            item("a2", date(5, 2, 10), lat: away.latitude, lon: away.longitude),
        ]
        cases.append(GoldenEventScenario(
            name: "16-home-frame-count-tie-break", items: ranking + [item("a3", date(5, 2, 11), lat: away.latitude, lon: away.longitude)],
            homeBase: FixtureHomeBase(latitude: 20.3, longitude: 74)
        ))
        cases.append(GoldenEventScenario(name: "17-home-earliest-tie-break", items: ranking, homeBase: homeCell))
        cases.append(GoldenEventScenario(name: "18-home-latitude-tie-break", items: [
            atHome("h1", date(5, 1, 9)), atHome("h2", date(5, 2, 9)),
            item("a1", date(5, 1, 9), lat: away.latitude, lon: away.longitude),
            item("a2", date(5, 2, 9), lat: away.latitude, lon: away.longitude),
        ], homeBase: homeCell))
        cases.append(GoldenEventScenario(name: "19-home-longitude-tie-break", items: [
            item("west1", date(5, 1, 9), lat: 18.5, lon: 73.8), item("west2", date(5, 2, 9), lat: 18.5, lon: 73.8),
            item("east1", date(5, 1, 9), lat: 18.5, lon: 73.9), item("east2", date(5, 2, 9), lat: 18.5, lon: 73.9),
        ], homeBase: FixtureHomeBase(latitude: 18.5, longitude: 73.8)))
        cases.append(GoldenEventScenario(name: "20-home-one-day-is-not-home", items: [
            atHome("morning", date(5, 1, 9)), atHome("evening", date(5, 1, 18)),
        ], eventCount: 2))
        cases.append(GoldenEventScenario(name: "21-home-negative-half-rounding", items: [
            item("south1", date(5, 1, 9), lat: -18.55, lon: -73.85),
            item("south2", date(5, 2, 9), lat: -18.55, lon: -73.85),
        ], eventCount: 2, homeBase: FixtureHomeBase(latitude: -18.6, longitude: -73.9)))
        let burstStart = date(9, 1, 12)
        cases.append(GoldenEventScenario(name: "22-burst-threshold-equal-chain-even", items: (0..<4).map {
            item("b\($0)", burstStart.addingTimeInterval(Double($0) * 3))
        }, eventCount: 1, coverItemId: "b2"))
        var shortSession = ClusteringConfig()
        shortSession.sessionGapHours = 3.5 / 3600
        cases.append(GoldenEventScenario(name: "23-burst-threshold-above", config: shortSession, items: [
            item("b0", burstStart), item("b1", burstStart.addingTimeInterval(4)),
        ], eventCount: 2, coverItemId: "b1"))
        cases.append(GoldenEventScenario(name: "24-burst-distinct-identifiers", items: [
            item("x1", burstStart, burst: "burst-a"), item("y1", burstStart.addingTimeInterval(1), burst: "burst-b"),
        ], eventCount: 1, coverItemId: "x1"))
        cases.append(GoldenEventScenario(name: "25-burst-same-identifier-overrides-place", items: [
            item("a", burstStart, lat: home.latitude, lon: home.longitude, burst: "same"),
            item("b", burstStart.addingTimeInterval(1), lat: away.latitude, lon: away.longitude, burst: "same"),
            item("c", burstStart.addingTimeInterval(2), lat: home.latitude, lon: home.longitude, burst: "same"),
        ], eventCount: 1, coverItemId: "b"))
        cases.append(GoldenEventScenario(name: "26-burst-missing-and-zero-coordinates", items: [
            item("a", burstStart, lat: home.latitude),
            item("b", burstStart.addingTimeInterval(1), lat: 0, lon: home.longitude),
            item("c", burstStart.addingTimeInterval(2), lat: home.latitude, lon: 0.0001),
            item("d", burstStart.addingTimeInterval(3)),
            item("e", burstStart.addingTimeInterval(4), lat: home.latitude, lon: home.longitude),
        ], eventCount: 1, coverItemId: "c"))
        cases.append(GoldenEventScenario(name: "27-burst-place-threshold", items: [
            atHome("a", burstStart),
            item("b", burstStart.addingTimeInterval(1), lat: home.latitude + 0.0017, lon: home.longitude),
            item("c", burstStart.addingTimeInterval(2), lat: home.latitude + 0.0036, lon: home.longitude),
            item("d", burstStart.addingTimeInterval(3), lat: home.latitude + 0.0053, lon: home.longitude),
        ], eventCount: 1, coverItemId: "b"))
        cases.append(GoldenEventScenario(name: "28-time-only-no-trip-or-visual-split", items: [
            item("p1", date(10, 1, 15)), item("p2", date(10, 1, 15, 20)),
            item("p3", date(10, 1, 17, 20)), item("p4", date(10, 1, 18)),
            item("next-day", date(10, 2, 8)),
        ], eventCount: 2))
        cases.append(GoldenEventScenario(name: "29-input-order-and-equal-time-ids", items: [
            item("z", burstStart), item("s-z", burstStart, screenshot: true),
            item("later", burstStart.addingTimeInterval(120)), item("a", burstStart),
            item("s-a", burstStart, screenshot: true), item("m", burstStart),
        ], eventCount: 1, coverItemId: "m"))
        let unicodeSource = "fixture:कैमरा|été"
        let sameFrame = item("same-frame", date(3, 14, 9), modTime: 1773480000.5)
        cases.append(GoldenEventScenario(name: "30-source-identity-unicode", sourceId: unicodeSource, items: [sameFrame], eventCount: 1))
        cases.append(GoldenEventScenario(name: "31-earlier-frame-changes-id", sourceId: unicodeSource, items: [
            sameFrame, item("earlier-frame", date(3, 14, 8, 59, 59)),
        ], eventCount: 1, coverItemId: "same-frame"))
        let timezoneTrip = homeDays + [
            item("b0", date(3, 7, 23, 30), lat: away.latitude, lon: away.longitude),
            item("b1", date(3, 7, 23, 30, 1), lat: away.latitude, lon: away.longitude),
            item("b2", date(3, 7, 23, 30, 2), lat: away.latitude, lon: away.longitude),
            item("before-dst", date(3, 8, 6, 30), lat: away.latitude, lon: away.longitude),
            item("after-dst", date(3, 8, 12, 30), lat: away.latitude, lon: away.longitude),
        ]
        cases.append(GoldenEventScenario(name: "32-calendar-utc-trip-burst-subdays", items: timezoneTrip, eventCount: 5, homeBase: homeCell, multiDayCount: 1))
        cases.append(GoldenEventScenario(
            name: "33-calendar-iana-dst-trip", calendar: FixtureCalendar(identifier: "gregorian", timeZoneIdentifier: "America/New_York", secondsFromGMT: nil),
            items: timezoneTrip, eventCount: 5, homeBase: homeCell, multiDayCount: 1
        ))
        cases.append(GoldenEventScenario(
            name: "34-calendar-fixed-offset-same-day", calendar: FixtureCalendar(identifier: "gregorian", timeZoneIdentifier: nil, secondsFromGMT: 19800),
            items: timezoneTrip, eventCount: 5, homeBase: homeCell
        ))
        cases.append(GoldenEventScenario(name: "35-negative-fractional-epoch", sourceId: "epoch-source", items: [
            item("before", Date(timeIntervalSince1970: -0.5), modTime: -1.5),
            item("after", Date(timeIntervalSince1970: 0.5)),
        ], eventCount: 1, coverItemId: "after"))
        cases.append(GoldenEventScenario(name: "36-empty-and-index-schema-versions", items: [], eventCount: 0, indexCases: [
            FixtureIndexCase(schemaVersion: 1, expectedReusable: true),
            FixtureIndexCase(schemaVersion: 0, expectedReusable: false),
            FixtureIndexCase(schemaVersion: 2, expectedReusable: false),
        ]))
        cases.append(GoldenEventScenario(name: "37-screenshots-only-never-infer-home", items: [
            item("s2", date(1, 2, 9), lat: home.latitude, lon: home.longitude, screenshot: true),
            item("s1", date(1, 1, 9), lat: home.latitude, lon: home.longitude, screenshot: true),
        ], eventCount: 0))
        cases.append(GoldenEventScenario(name: "38-filename-shoot-signals", items: [
            item("shoots/MS202603-Trip0001-Enhanced-NR.jpg", date(3, 1, 8)),
            item("shoots/ms202603-trip0002.JPG", date(3, 1, 12)),
            item("shoots/MS202603-Trip0003.jpg", date(3, 3, 8)),
            item("other/MS202603-Trip0001.jpg", date(3, 3, 13)),
            item("sequence/DSCF0100.jpg", date(3, 5, 8)),
            item("sequence/DSCF0105.jpg", date(3, 5, 14)),
            item("sequence/DSCF0117.jpg", date(3, 6, 9)),
            item("sequence/DSCF0118.jpg", date(3, 6, 15)),
            item("sequence/IMG_20260307_090000.jpg", date(3, 7, 9)),
            item("sequence/IMG_20260307_130000.jpg", date(3, 7, 13)),
            item("long/MS202603-Trip0001.jpg", date(3, 20, 8)),
            item("long/MS202603-Trip0002.jpg", date(4, 10, 8)),
            item("overflow/MS202603-Trip99999999999999999999.jpg", date(4, 12, 8)),
            item("overflow/MS202603-Trip99999999999999999998.jpg", date(4, 12, 14)),
        ], eventCount: 10, multiDayCount: 1, coverItemId: "overflow/MS202603-Trip99999999999999999998.jpg", indexCases: [
            FixtureIndexCase(schemaVersion: 1, expectedReusable: true),
        ]))
        return cases
    }()

    override class func setUp() {
        super.setUp()
        guard GoldenFixtureStore.exporting else { return }
        do {
            for scenario in scenarios { try GoldenFixtureStore.export(scenario) }
        } catch {
            XCTFail("Fixture export failed: \(error)")
        }
    }

    private func verify(_ name: String, file: StaticString = #filePath, line: UInt = #line) throws {
        let scenario = try XCTUnwrap(Self.scenarios.first { $0.name == name }, file: file, line: line)
        try GoldenFixtureStore.assertParity(scenario, file: file, line: line)
    }

    func testDinnerAndDrinks() throws { try verify("01-dinner-and-drinks") }
    func testHikeAndDinner() throws { try verify("02-hike-and-dinner") }
    func testFourDayTrip() throws { try verify("03-four-day-trip") }
    func testScreenshotsAndBurstsAtDinner() throws { try verify("04-screenshots-and-bursts-at-dinner") }
    func testSessionGapEqual() throws { try verify("05-session-gap-equal") }
    func testSessionGapAbove() throws { try verify("06-session-gap-above") }
    func testSessionDistanceBelow() throws { try verify("07-session-distance-below") }
    func testSessionDistanceAbove() throws { try verify("08-session-distance-above") }
    func testTransitWindowEqual() throws { try verify("09-transit-window-equal") }
    func testTransitWindowAbove() throws { try verify("10-transit-window-above") }
    func testTripGapBelow() throws { try verify("11-trip-gap-below") }
    func testTripGapEqual() throws { try verify("12-trip-gap-equal") }
    func testTripDistanceBelow() throws { try verify("13-trip-distance-below") }
    func testTripDistanceAbove() throws { try verify("14-trip-distance-above") }
    func testHomeDaysBeatFrameCount() throws { try verify("15-home-days-beat-frame-count") }
    func testHomeFrameCountTieBreak() throws { try verify("16-home-frame-count-tie-break") }
    func testHomeEarliestTieBreak() throws { try verify("17-home-earliest-tie-break") }
    func testHomeLatitudeTieBreak() throws { try verify("18-home-latitude-tie-break") }
    func testHomeLongitudeTieBreak() throws { try verify("19-home-longitude-tie-break") }
    func testHomeOneDayIsNotHome() throws { try verify("20-home-one-day-is-not-home") }
    func testHomeNegativeHalfRounding() throws { try verify("21-home-negative-half-rounding") }
    func testBurstThresholdEqualChainEven() throws { try verify("22-burst-threshold-equal-chain-even") }
    func testBurstThresholdAbove() throws { try verify("23-burst-threshold-above") }
    func testBurstDistinctIdentifiers() throws { try verify("24-burst-distinct-identifiers") }
    func testBurstSameIdentifierOverridesPlace() throws { try verify("25-burst-same-identifier-overrides-place") }
    func testBurstMissingAndZeroCoordinates() throws { try verify("26-burst-missing-and-zero-coordinates") }
    func testBurstPlaceThreshold() throws { try verify("27-burst-place-threshold") }
    func testTimeOnlyNoTripOrVisualSplit() throws { try verify("28-time-only-no-trip-or-visual-split") }
    func testInputOrderAndEqualTimeIds() throws { try verify("29-input-order-and-equal-time-ids") }
    func testSourceIdentityUnicode() throws { try verify("30-source-identity-unicode") }
    func testEarlierFrameChangesId() throws { try verify("31-earlier-frame-changes-id") }
    func testCalendarUTCTripBurstSubdays() throws { try verify("32-calendar-utc-trip-burst-subdays") }
    func testCalendarIANADSTTrip() throws { try verify("33-calendar-iana-dst-trip") }
    func testCalendarFixedOffsetSameDay() throws { try verify("34-calendar-fixed-offset-same-day") }
    func testNegativeFractionalEpoch() throws { try verify("35-negative-fractional-epoch") }
    func testEmptyAndIndexSchemaVersions() throws { try verify("36-empty-and-index-schema-versions") }
    func testScreenshotsOnlyNeverInferHome() throws { try verify("37-screenshots-only-never-infer-home") }
    func testFilenameShootSignals() throws { try verify("38-filename-shoot-signals") }

    func testFixtureInventoryAndSharedSchemaVersion() throws {
        XCTAssertEqual(Self.scenarios.count, 38)
        XCTAssertEqual(Set(Self.scenarios.map(\.name)).count, 38)
        XCTAssertEqual(GoldenEventFixture.supportedSchemaVersion, EventIndex.schemaVersion)
        if GoldenFixtureStore.exporting { return }
        let files = try FileManager.default.contentsOfDirectory(at: GoldenFixtureStore.directory, includingPropertiesForKeys: nil)
        XCTAssertEqual(Set(files.filter { $0.pathExtension == "json" }.map { $0.deletingPathExtension().lastPathComponent }), Set(Self.scenarios.map(\.name)))
    }

    func testFixtureDecoderRejectsUnknownSchemaAndInvalidCalendar() throws {
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: GoldenFixtureStore.load("36-empty-and-index-schema-versions").encode()) as? [String: Any])
        object["schemaVersion"] = 99
        XCTAssertThrowsError(try GoldenEventFixture.decode(JSONSerialization.data(withJSONObject: object))) {
            XCTAssertEqual($0 as? GoldenFixtureError, .unsupportedSchema(99))
        }
        object["schemaVersion"] = 1
        object["calendar"] = ["identifier": "gregorian", "timeZoneIdentifier": "Not/A_Timezone"]
        XCTAssertThrowsError(try GoldenEventFixture.decode(JSONSerialization.data(withJSONObject: object))) {
            XCTAssertEqual($0 as? GoldenFixtureError, .invalidCalendar)
        }
    }

    func testFixtureInputDriftIsRejected() throws {
        let scenario = try XCTUnwrap(Self.scenarios.first)
        let fixture = try GoldenFixtureStore.load(scenario.name)
        var changed = scenario
        changed.config.sessionGapHours += 1
        XCTAssertThrowsError(try fixture.validateInputs(against: changed)) {
            XCTAssertEqual($0 as? GoldenFixtureError, .staleInputs)
        }
        XCTAssertThrowsError(try GoldenFixtureStore.load("missing-fixture-must-not-be-generated"))
    }

    func testIdentityAndRepresentativeSubdayContracts() throws {
        let original = try GoldenFixtureStore.load("30-source-identity-unicode")
        let earlier = try GoldenFixtureStore.load("31-earlier-frame-changes-id")
        XCTAssertNotEqual(original.expected.events.first?.id, earlier.expected.events.first?.id)
        XCTAssertEqual(original.expected.events.first?.coverItemId, earlier.expected.events.first?.coverItemId)
        let scoped = EventClusterer(sourceId: "other-source", calendar: try original.calendar.makeCalendar()).cluster(original.items)
        XCTAssertNotEqual(original.expected.events.first?.id, scoped.events.first?.id)
        let trip = try XCTUnwrap(GoldenFixtureStore.load("32-calendar-utc-trip-burst-subdays").expected.events.last)
        XCTAssertEqual(trip.itemIds, ["b0", "b1", "b2", "before-dst", "after-dst"])
        XCTAssertEqual(trip.subDays?.map(\.itemIds), [["b1"], ["before-dst", "after-dst"]])
    }
}
