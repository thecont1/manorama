import XCTest

@testable import ManoramaEventClustering

/*
 * The plan's four synthetic timelines, and the behaviour the whole
 * feature is judged by: an evening stays one event, a next morning is
 * another, a four-day trip is one event with four days inside it, and
 * screenshots never shred any of them.
 *
 * Everything here is built from in-memory metadata — no files, no
 * PhotoKit, no network — which is the point of keeping the engine pure.
 * These run in a third of a second on a build machine with no camera roll.
 */
final class EventClustererTests: XCTestCase {
    /// Pune, used as the home base throughout.
    private let home = (latitude: 18.5167, longitude: 73.8562)
    /// ~300 km away, comfortably past the 50 km travel threshold.
    private let away = (latitude: 20.2954, longitude: 73.9846)

    /// A fixed calendar so the day boundaries in the assertions are the
    /// test's, not the machine's.
    private var utc: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        return calendar
    }

    private func date(_ year: Int, _ month: Int, _ day: Int, _ hour: Int, _ minute: Int = 0, _ second: Int = 0) -> Date {
        var components = DateComponents()
        components.year = year; components.month = month; components.day = day
        components.hour = hour; components.minute = minute; components.second = second
        return utc.date(from: components)!
    }

    private func item(
        _ id: String, _ when: Date,
        lat: Double? = nil, lon: Double? = nil,
        screenshot: Bool = false, burst: String? = nil
    ) -> MediaMetadataItem {
        MediaMetadataItem(
            id: id, timestamp: when, latitude: lat, longitude: lon,
            isScreenshot: screenshot, burstIdentifier: burst
        )
    }

    private func clusterer(source: String = "test-source", probe: (any VisualBoundaryProbe)? = nil) -> EventClusterer {
        EventClusterer(sourceId: source, calendar: utc, probe: probe)
    }

    // MARK: - Scenario 1: an evening out stays one event

    func testDinnerAndDrinksTwoKilometresApartIsOneEvent() {
        let evening = [
            item("d1", date(2026, 3, 14, 19, 30), lat: home.latitude, lon: home.longitude),
            item("d2", date(2026, 3, 14, 19, 52), lat: home.latitude, lon: home.longitude),
            item("d3", date(2026, 3, 14, 20, 40), lat: home.latitude + 0.009, lon: home.longitude + 0.012),
            item("d4", date(2026, 3, 14, 21, 30), lat: home.latitude + 0.012, lon: home.longitude + 0.017),
            item("d5", date(2026, 3, 14, 22, 55), lat: home.latitude + 0.018, lon: home.longitude + 0.011),
            item("d6", date(2026, 3, 14, 23, 30), lat: home.latitude + 0.018, lon: home.longitude + 0.011),
        ]
        // 1.9 km between the first and last frames — two venues, one night.
        let km = GeoMath.haversineKm(home.latitude, home.longitude, home.latitude + 0.018, home.longitude + 0.011)
        XCTAssertLessThan(km, 3.0, "the fixture is meant to be a walk between venues")

        let result = clusterer().cluster(evening)
        XCTAssertEqual(result.events.count, 1)
        XCTAssertEqual(result.events.first?.itemIds.count, 6)
        XCTAssertEqual(result.events.first?.startDate, date(2026, 3, 14, 19, 30))
        XCTAssertEqual(result.events.first?.endDate, date(2026, 3, 14, 23, 30))
        XCTAssertFalse(result.events.first?.isMultiDay ?? true)
        XCTAssertNil(result.events.first?.subDays)
    }

    // MARK: - Scenario 2: the next outing is a new event

    func testMorningHikeAndEveningDinnerSixHoursApartAreTwoEvents() {
        let day = [
            item("h1", date(2026, 3, 14, 7, 0), lat: home.latitude, lon: home.longitude),
            item("h2", date(2026, 3, 14, 8, 30), lat: home.latitude + 0.01, lon: home.longitude),
            item("h3", date(2026, 3, 14, 10, 0), lat: home.latitude + 0.02, lon: home.longitude),
            // Six quiet hours: shower, nap, the rest of a Saturday.
            item("e1", date(2026, 3, 14, 16, 0), lat: home.latitude, lon: home.longitude + 0.01),
            item("e2", date(2026, 3, 14, 17, 30), lat: home.latitude, lon: home.longitude + 0.01),
            item("e3", date(2026, 3, 14, 19, 0), lat: home.latitude, lon: home.longitude + 0.02),
        ]
        let result = clusterer().cluster(day)
        XCTAssertEqual(result.events.count, 2)
        XCTAssertEqual(result.events[0].itemIds, ["h1", "h2", "h3"])
        XCTAssertEqual(result.events[1].itemIds, ["e1", "e2", "e3"])
        // Both are in home city, so neither is travel and neither merges.
        XCTAssertFalse(result.events[0].isMultiDay)
        XCTAssertFalse(result.events[1].isMultiDay)
    }

    // MARK: - Scenario 3: a multi-day trip is one event with days inside

    func testFourDayTripThreeHundredKilometresAwayMergesIntoOneEventWithFourSubDays() {
        var items: [MediaMetadataItem] = []
        // Home before the trip: one frame on each of eight days. Sparse,
        // because that is what a camera roll of ordinary weeks actually
        // looks like beside a holiday, and the inference has to survive
        // that comparison rather than a flattering one.
        for day in 1...8 {
            items.append(item("home\(day)", date(2026, 3, day, 9, 0), lat: home.latitude, lon: home.longitude))
        }

        for day in 1...4 {
            // A morning, a noon and an evening session each day: the
            // daytime gaps clear the session threshold, the 10-hour
            // overnight gap does not clear the trip threshold.
            items.append(item("t\(day)a", date(2026, 3, 10 + day, 8, 0), lat: away.latitude, lon: away.longitude))
            items.append(item("t\(day)b", date(2026, 3, 10 + day, 12, 0), lat: away.latitude + 0.02, lon: away.longitude))
            items.append(item("t\(day)c", date(2026, 3, 10 + day, 22, 0), lat: away.latitude, lon: away.longitude + 0.01))
        }
        // Back home: the arrival morning must not be dragged into the trip.
        items.append(item("home9", date(2026, 3, 16, 8, 0), lat: home.latitude, lon: home.longitude))

        let result = clusterer().cluster(items)
        let trips = result.events.filter(\.isMultiDay)
        XCTAssertEqual(trips.count, 1, "the four travel days merge into one event: \(result.events.map { [$0.startDate, $0.endDate] })")
        guard let event = trips.first else { return }

        XCTAssertEqual(event.subDays?.count, 4)
        XCTAssertEqual(event.subDays?.map(\.id), ["2026-03-11", "2026-03-12", "2026-03-13", "2026-03-14"])
        XCTAssertEqual(event.subDays?.map(\.itemIds.count), [3, 3, 3, 3])
        XCTAssertEqual(event.itemIds.count, 12)
        XCTAssertEqual(event.startDate, date(2026, 3, 11, 8, 0))
        XCTAssertEqual(event.endDate, date(2026, 3, 14, 22, 0))
        // The return home is its own event, not the trip's fifth day.
        XCTAssertTrue(result.events.contains { $0.itemIds == ["home9"] && !$0.isMultiDay })
        // Nothing is lost and nothing is counted twice.
        let covered = result.events.flatMap(\.itemIds)
        XCTAssertEqual(Set(covered).count, covered.count)
        XCTAssertEqual(Set(covered), Set(items.map(\.id)))
    }

    // MARK: - Scenario 4: screenshots and bursts mid-event

    func testScreenshotsAndBurstsMidDinnerDoNotFragmentTheDinner() {
        var items: [MediaMetadataItem] = [
            item("d1", date(2026, 3, 14, 19, 30), lat: home.latitude, lon: home.longitude),
            item("d2", date(2026, 3, 14, 20, 10), lat: home.latitude, lon: home.longitude + 0.005),
        ]
        // A burst of three, 1 second apart, mid-dinner.
        items.append(item("b1", date(2026, 3, 14, 20, 40, 0), lat: home.latitude, lon: home.longitude + 0.005))
        items.append(item("b2", date(2026, 3, 14, 20, 40, 1), lat: home.latitude, lon: home.longitude + 0.005))
        items.append(item("b3", date(2026, 3, 14, 20, 40, 2), lat: home.latitude, lon: home.longitude + 0.005))
        // Screenshots: a receipt, a meme. Same table, same night.
        items.append(item("s1", date(2026, 3, 14, 20, 45), lat: home.latitude, lon: home.longitude + 0.005, screenshot: true))
        items.append(item("s2", date(2026, 3, 14, 21, 2), lat: home.latitude, lon: home.longitude + 0.005, screenshot: true))
        items.append(item("d3", date(2026, 3, 14, 22, 0), lat: home.latitude, lon: home.longitude + 0.005))

        let result = clusterer().cluster(items)

        XCTAssertEqual(result.events.count, 1)
        XCTAssertEqual(result.screenshotItemIds, ["s1", "s2"])
        // Nothing is lost to the burst collapse — the frames are all still
        // members; only the representative and the cover moved.
        XCTAssertEqual(Set(result.events[0].itemIds), Set(["d1", "d2", "b1", "b2", "b3", "d3"]))
        XCTAssertEqual(result.events[0].itemIds, ["d1", "d2", "b1", "b2", "b3", "d3"], "chronological order is the contract")
        // The burst's middle frame is the cover, not its half-pressed first.
        let dinner = result.events[0]
        XCTAssertEqual(dinner.coverItemId, "b2")
        XCTAssertTrue(dinner.itemIds.contains(dinner.coverItemId))
    }

    // MARK: - Home-base inference

    func testHomeBaseIsTheCellTheCameraReturnsTo() throws {
        let items = [
            item("a1", date(2026, 5, 1, 9), lat: home.latitude, lon: home.longitude),
            item("a2", date(2026, 5, 2, 9), lat: home.latitude + 0.03, lon: home.longitude + 0.02),
            item("a3", date(2026, 5, 3, 9), lat: home.latitude - 0.02, lon: home.longitude + 0.04),
            item("b1", date(2026, 5, 4, 9), lat: away.latitude, lon: away.longitude),
        ]
        let base = try XCTUnwrap(clusterer().inferredHomeBase(from: items))
        XCTAssertEqual(base.latitude, 18.5, accuracy: 0.0001)
        XCTAssertEqual(base.longitude, 73.9, accuracy: 0.0001)
    }

    func testABusyHolidayDoesNotOutweighAnOrdinaryHometown() throws {
        var items: [MediaMetadataItem] = []
        // Two months of home, one frame a day.
        for day in 1...60 {
            items.append(item("h\(day)", date(2026, 1, 1, 9).addingTimeInterval(TimeInterval(day) * 86_400),
                              lat: home.latitude, lon: home.longitude))
        }
        // And a four-day trip that photographed everything: 200 frames.
        for index in 0..<200 {
            items.append(item("t\(index)", date(2026, 4, 1, 8).addingTimeInterval(TimeInterval(index) * 600),
                              lat: away.latitude, lon: away.longitude))
        }
        let base = try XCTUnwrap(clusterer().inferredHomeBase(from: items))
        XCTAssertEqual(base.latitude, 18.5, accuracy: 0.0001, "60 ordinary days beat 200 holiday frames")
    }

    func testSingleGeotaggedFrameDoesNotBecomeAHometown() {
        let items = [item("only", date(2026, 5, 1, 9), lat: home.latitude, lon: home.longitude)]
        XCTAssertNil(clusterer().inferredHomeBase(from: items))
    }

    // MARK: - Distance and transit

    func testDistanceBeyondFiveKilometresAfterTheTransitWindowSplits() {
        let items = [
            item("a", date(2026, 6, 1, 10, 0), lat: home.latitude, lon: home.longitude),
            item("b", date(2026, 6, 1, 12, 0), lat: home.latitude + 0.09, lon: home.longitude),
        ]
        // 10 km, two hours later: a new outing, not a continuing journey.
        XCTAssertEqual(clusterer().cluster(items).events.count, 2)
    }

    func testLongDistanceJumpInsideTheTransitWindowStaysOneSession() {
        let items = [
            item("a", date(2026, 6, 1, 10, 0), lat: home.latitude, lon: home.longitude),
            item("b", date(2026, 6, 1, 10, 20), lat: home.latitude + 0.5, lon: home.longitude),
        ]
        // 55 km in 20 minutes is a flight, and a flight is part of the day.
        let result = clusterer().cluster(items)
        XCTAssertEqual(result.events.count, 1)
        XCTAssertEqual(result.events[0].itemIds, ["a", "b"])
    }

    // MARK: - Determinism and identity

    func testClusteringIsDeterministicForTheSameInput() {
        var items: [MediaMetadataItem] = []
        for index in 0..<40 {
            items.append(item("p\(index)", date(2026, 7, 1, 8) .addingTimeInterval(Double(index) * 1700),
                              lat: home.latitude + Double(index % 5) / 100,
                              lon: home.longitude + Double(index % 3) / 100))
        }
        let shuffled = items.shuffled()
        XCTAssertEqual(clusterer().cluster(items).events, clusterer().cluster(shuffled).events)
    }

    func testEventIdIsStableAcrossScansAndScopedToItsSource() {
        let items = [item("a", date(2026, 8, 1, 9), lat: home.latitude, lon: home.longitude)]
        let first = clusterer(source: "mac-folder").cluster(items).events[0]
        let again = clusterer(source: "mac-folder").cluster(items).events[0]
        let otherDevice = clusterer(source: "iphone-library").cluster(items).events[0]
        XCTAssertEqual(first.id, again.id)
        XCTAssertNotEqual(first.id, otherDevice.id)
        XCTAssertTrue(first.id.hasPrefix("evt_"))
        XCTAssertEqual(first.id.count, 4 + 20)
    }

    // MARK: - Burst mechanics

    func testBurstIdentifierSeparatesRunsInTheSameSecond() {
        // PhotoKit hands two different bursts the same second sometimes;
        // the identifier outranks the clock.
        let items = [
            item("x1", date(2026, 9, 1, 12, 0, 0), burst: "burst-a"),
            item("y1", date(2026, 9, 1, 12, 0, 1), burst: "burst-b"),
        ]
        let bursts = clusterer().collapseBursts(items)
        XCTAssertEqual(bursts.count, 2)
    }

    func testBurstWithoutAnyPlaceStillsCollapses() {
        let items = (0..<5).map { item("n\($0)", date(2026, 9, 1, 12, 0, $0)) }
        let bursts = clusterer().collapseBursts(items)
        XCTAssertEqual(bursts.count, 1)
        XCTAssertEqual(bursts[0].members.count, 5)
        XCTAssertEqual(bursts[0].representative.id, "n2")
    }

    // MARK: - Optional pass 4

    private struct ConstantProbe: VisualBoundaryProbe {
        let distance: Double
        func visualDistance(between first: MediaMetadataItem, and second: MediaMetadataItem) -> Double? { distance }
    }

    /// A 2-hour quiet gap at a fixed coordinate: inside the ambiguous band,
    /// so only the probe can decide it.
    private var ambiguousAfternoon: [MediaMetadataItem] {
        [
            item("p1", date(2026, 10, 1, 15, 0), lat: home.latitude, lon: home.longitude),
            item("p2", date(2026, 10, 1, 15, 20), lat: home.latitude, lon: home.longitude),
            item("p3", date(2026, 10, 1, 17, 20), lat: home.latitude, lon: home.longitude),
            item("p4", date(2026, 10, 1, 18, 0), lat: home.latitude, lon: home.longitude),
        ]
    }

    func testVisualProbeSplitsAnAmbiguousBoundaryItJudgesDifferent() {
        let withoutProbe = clusterer().cluster(ambiguousAfternoon).events.count
        let withSplit = clusterer(probe: ConstantProbe(distance: 2.4)).cluster(ambiguousAfternoon).events.count
        let withMerge = clusterer(probe: ConstantProbe(distance: 0.3)).cluster(ambiguousAfternoon).events.count
        XCTAssertEqual(withoutProbe, 1, "the clock alone keeps one afternoon")
        XCTAssertEqual(withSplit, 2)
        XCTAssertEqual(withMerge, 1, "a similar-looking pair is the same party")
    }

    func testProbeIsNotConsultedOutsideTheAmbiguousBand() {
        let items = [
            item("q1", date(2026, 10, 2, 15, 0), lat: home.latitude, lon: home.longitude),
            item("q2", date(2026, 10, 2, 15, 20), lat: home.latitude, lon: home.longitude),
        ]
        // 20 minutes apart, and a probe that always says "different":
        // a visual opinion is only asked inside the band the clock cannot
        // settle, so an ordinary afternoon is never shredded by a model.
        let events = clusterer(probe: ConstantProbe(distance: 9)).cluster(items).events
        XCTAssertEqual(events.count, 1)
    }

    // MARK: - Empty and degenerate input

    func testScreenshotsOnlyDumpProducesNoEvents() {
        let items = [
            item("s1", date(2026, 1, 1, 9), screenshot: true),
            item("s2", date(2026, 1, 1, 10), screenshot: true),
        ]
        let result = clusterer().cluster(items)
        XCTAssertTrue(result.events.isEmpty)
        XCTAssertEqual(result.screenshotItemIds, ["s1", "s2"])
    }

    func testEmptyDumpIsNotAnError() {
        XCTAssertTrue(clusterer().cluster([]).events.isEmpty)
    }
}
