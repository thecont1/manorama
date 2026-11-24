import Foundation

/// The boundary test binary's entry point.
///
/// Swift requires the top-level code in a file called `main.swift`, so the
/// work lives in `BoundaryTests.run()` and this file just starts it. The
/// performance flag gets its own process so its RSS high-water mark is not
/// shared with WebKit or the rest of the boundary checks.
if CommandLine.arguments.contains(EventIndexPerformanceGate.flag) {
    exit(EventIndexPerformanceGate.run())
}
BoundaryTests.run()
