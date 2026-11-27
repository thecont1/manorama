import Foundation

// Independent oracle: compile with the unmodified Swift core sources, not a
// transcription of Rust's normalization, Date arithmetic or expected covers.
struct ProbeCase: Codable {
    let items: [MediaMetadataItem]
    let config: ClusteringConfig
    let sourceId: String
}
struct ProbeInput: Codable {
    let cases: [ProbeCase]
    let timestamps: [Double]
}
struct ProbeOutput: Codable {
    let results: [EventClusteringResult]
    let timestamps: [Double]
}
@main
struct SwiftParityProbe {
    static func main() throws {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .secondsSince1970
        let input = try decoder.decode(ProbeInput.self, from: FileHandle.standardInput.readDataToEndOfFile())
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let results = input.cases.map {
            EventClusterer(sourceId: $0.sourceId, config: $0.config, calendar: calendar).cluster($0.items)
        }
        let output = ProbeOutput(results: results, timestamps: input.timestamps.map { Date(timeIntervalSince1970: $0).timeIntervalSince1970 })
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .secondsSince1970
        FileHandle.standardOutput.write(try encoder.encode(output))
    }
}
