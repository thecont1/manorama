import Foundation
import XCTest

@testable import ManoramaEventClustering

struct FixtureCalendar: Codable, Equatable {
    let identifier: String
    let timeZoneIdentifier: String?
    let secondsFromGMT: Int?

    static let utc = FixtureCalendar(identifier: "gregorian", timeZoneIdentifier: nil, secondsFromGMT: 0)

    func makeCalendar() throws -> Calendar {
        guard identifier == "gregorian" else { throw GoldenFixtureError.invalidCalendar }
        let zone: TimeZone?
        switch (timeZoneIdentifier, secondsFromGMT) {
        case (.some(let name), .none): zone = TimeZone(identifier: name)
        case (.none, .some(let seconds)): zone = TimeZone(secondsFromGMT: seconds)
        default: throw GoldenFixtureError.invalidCalendar
        }
        guard let zone else { throw GoldenFixtureError.invalidCalendar }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        return calendar
    }
}

struct FixtureHomeBase: Codable, Equatable {
    let latitude: Double
    let longitude: Double

    init(latitude: Double, longitude: Double) {
        self.latitude = latitude
        self.longitude = longitude
    }

    init(_ cell: GeoCell) {
        latitude = cell.latitude
        longitude = cell.longitude
    }
}

struct FixtureIndexCase: Codable, Equatable {
    let schemaVersion: Int
    let expectedReusable: Bool
}

struct GoldenEventFixture: Codable, Equatable {
    static let supportedSchemaVersion = 1

    let schemaVersion: Int
    let sourceId: String
    let calendar: FixtureCalendar
    let config: ClusteringConfig
    let items: [MediaMetadataItem]
    let expected: EventClusteringResult
    let homeBase: FixtureHomeBase?
    let indexCases: [FixtureIndexCase]?

    static func decode(_ data: Data) throws -> GoldenEventFixture {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .secondsSince1970
        let fixture = try decoder.decode(Self.self, from: data)
        guard fixture.schemaVersion == supportedSchemaVersion else {
            throw GoldenFixtureError.unsupportedSchema(fixture.schemaVersion)
        }
        _ = try fixture.calendar.makeCalendar()
        return fixture
    }

    func encode() throws -> Data {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .secondsSince1970
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(self)
    }

    func validateInputs(against scenario: GoldenEventScenario) throws {
        guard sourceId == scenario.sourceId, calendar == scenario.calendar,
              config == scenario.config, items == scenario.items,
              indexCases == scenario.indexCases else { throw GoldenFixtureError.staleInputs }
    }
}

enum GoldenFixtureError: Error, Equatable {
    case unsupportedSchema(Int)
    case invalidCalendar
    case staleInputs
}

struct GoldenEventScenario {
    let name: String
    var sourceId = "test-source"
    var calendar = FixtureCalendar.utc
    var config = ClusteringConfig()
    let items: [MediaMetadataItem]
    var eventCount: Int?
    var homeBase: FixtureHomeBase?
    var multiDayCount = 0
    var coverItemId: String?
    var indexCases: [FixtureIndexCase]?
}

enum GoldenFixtureStore {
    static let directory = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .appendingPathComponent("fixtures/event-clustering", isDirectory: true)

    static var exporting: Bool {
        ProcessInfo.processInfo.environment["MANORAMA_EXPORT_EVENT_FIXTURES"] == "1"
    }

    static func load(_ name: String) throws -> GoldenEventFixture {
        try GoldenEventFixture.decode(Data(contentsOf: directory.appendingPathComponent("\(name).json")))
    }

    static func export(_ scenario: GoldenEventScenario) throws {
        guard exporting else { return }
        let clusterer = EventClusterer(
            sourceId: scenario.sourceId, config: scenario.config, calendar: try scenario.calendar.makeCalendar()
        )
        let fixture = GoldenEventFixture(
            schemaVersion: GoldenEventFixture.supportedSchemaVersion,
            sourceId: scenario.sourceId, calendar: scenario.calendar, config: scenario.config,
            items: scenario.items, expected: clusterer.cluster(scenario.items),
            homeBase: clusterer.inferredHomeBase(from: scenario.items.filter { !$0.isScreenshot }).map(FixtureHomeBase.init),
            indexCases: scenario.indexCases
        )
        try fixture.encode().write(to: directory.appendingPathComponent("\(scenario.name).json"), options: .atomic)
    }

    static func assertParity(_ scenario: GoldenEventScenario, file: StaticString = #filePath, line: UInt = #line) throws {
        let clusterer = EventClusterer(
            sourceId: scenario.sourceId, config: scenario.config, calendar: try scenario.calendar.makeCalendar()
        )
        let result = clusterer.cluster(scenario.items)
        let home = clusterer.inferredHomeBase(from: scenario.items.filter { !$0.isScreenshot }).map(FixtureHomeBase.init)
        if let count = scenario.eventCount {
            XCTAssertEqual(result.events.count, count, scenario.name, file: file, line: line)
        }
        XCTAssertEqual(home, scenario.homeBase, scenario.name, file: file, line: line)
        XCTAssertEqual(result.events.filter(\.isMultiDay).count, scenario.multiDayCount, scenario.name, file: file, line: line)
        if let cover = scenario.coverItemId {
            XCTAssertEqual(result.events.last?.coverItemId, cover, scenario.name, file: file, line: line)
        }
        let generated = GoldenEventFixture(
            schemaVersion: GoldenEventFixture.supportedSchemaVersion,
            sourceId: scenario.sourceId, calendar: scenario.calendar, config: scenario.config,
            items: scenario.items, expected: result, homeBase: home, indexCases: scenario.indexCases
        )
        let fixture = try load(scenario.name)
        try fixture.validateInputs(against: scenario)
        XCTAssertEqual(fixture, generated, "Stale golden fixture: \(scenario.name)", file: file, line: line)
        let reader = EventClusterer(
            sourceId: fixture.sourceId, config: fixture.config, calendar: try fixture.calendar.makeCalendar()
        )
        XCTAssertEqual(reader.cluster(fixture.items), fixture.expected, scenario.name, file: file, line: line)
        XCTAssertEqual(reader.cluster(Array(fixture.items.reversed())), fixture.expected, "Input order: \(scenario.name)", file: file, line: line)
        XCTAssertEqual(
            reader.inferredHomeBase(from: fixture.items.filter { !$0.isScreenshot }).map(FixtureHomeBase.init),
            fixture.homeBase, scenario.name, file: file, line: line
        )
        for indexCase in fixture.indexCases ?? [] {
            let source = EventIndex.SourceFingerprint(
                deviceId: "synthetic-device", sourceId: fixture.sourceId,
                sourceKind: EventIndex.folderSourceKind, label: "Synthetic metadata", lastIndexedAt: Date(timeIntervalSince1970: 0)
            )
            let index = EventIndex(
                schemaVersion: indexCase.schemaVersion, source: source, config: fixture.config,
                itemCache: Dictionary(uniqueKeysWithValues: fixture.items.map { ($0.id, $0) }),
                events: fixture.expected.events, screenshotItemIds: fixture.expected.screenshotItemIds
            )
            let decoded = try EventIndex.decode(EventIndex.encode(index))
            XCTAssertEqual(decoded, index, file: file, line: line)
            XCTAssertEqual(decoded.matches(deviceId: source.deviceId, sourceId: source.sourceId), indexCase.expectedReusable, file: file, line: line)
            XCTAssertFalse(decoded.matches(deviceId: "other-device", sourceId: source.sourceId), file: file, line: line)
            XCTAssertFalse(decoded.matches(deviceId: source.deviceId, sourceId: "other-source"), file: file, line: line)
        }
    }
}
