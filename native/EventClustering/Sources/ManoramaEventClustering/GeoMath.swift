import Foundation

/*
 * The geography the clustering rests on: a great-circle distance and a
 * coarse grid. Two functions, both written out rather than borrowed,
 * because a third-party geodesy package is the kind of weight the ~65 MB
 * footprint cannot pay for and neither of these is hard to hold in view.
 */

public enum GeoMath {
    /// Mean Earth radius in kilometres (IUGG). One constant, so every
    /// platform answers the same distance for the same pair.
    static let earthRadiusKm = 6371.0088

    /// Great-circle distance in kilometres.
    ///
    /// Haversine, which is numerically well-behaved at the small distances
    /// that matter here. Vincenty's extra precision buys nothing when the
    /// question is "2 km or 20 km?".
    public static func haversineKm(
        _ aLat: Double, _ aLon: Double,
        _ bLat: Double, _ bLon: Double
    ) -> Double {
        let dLat = (bLat - aLat) * .pi / 180
        let dLon = (bLon - aLon) * .pi / 180
        let phi1 = aLat * .pi / 180
        let phi2 = bLat * .pi / 180
        let h = sin(dLat / 2) * sin(dLat / 2) + cos(phi1) * cos(phi2) * sin(dLon / 2) * sin(dLon / 2)
        return 2 * earthRadiusKm * atan2(min(h, 1).squareRoot(), max(0, 1 - min(h, 1)).squareRoot())
    }

    /// Whether two coordinates are the same place, within the noise a
    /// phone GPS carries (5–20 m outdoors, worse in a building).
    public static func isSamePlaceKm(_ km: Double, tolerance: Double) -> Bool {
        km <= tolerance
    }
}

/// A ~11 km grid cell, keyed by its rounded centre.
///
/// 0.1° is the resolution the plan asks for: coarse enough that the same
/// suburb reported from two different photographs lands in one cell, fine
/// enough that a city and a town 40 km away do not.
public struct GeoCell: Hashable, Sendable, CustomStringConvertible {
    public let latitude: Double
    public let longitude: Double

    public init(latitude: Double, longitude: Double) {
        self.latitude = (latitude * 10).rounded() / 10
        self.longitude = (longitude * 10).rounded() / 10
    }

    /// The cell of a coordinate, or nil when it has none — an item
    /// without GPS takes no part in home-base inference.
    public init?(item: MediaMetadataItem) {
        guard let coordinate = item.coordinate else { return nil }
        self.init(latitude: coordinate.latitude, longitude: coordinate.longitude)
    }

    public var description: String { String(format: "%.1f,%.1f", latitude, longitude) }
}
