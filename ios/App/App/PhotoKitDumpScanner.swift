import CoreLocation
import Foundation
import Photos

/*
 * Layer 2 on iOS and iPadOS: the system library, as `MediaMetadataItem`s.
 *
 * PhotoKit already holds everything the clusterer reads — the capture date,
 * the fix the camera had, whether the frame is a screen capture, the burst
 * it belongs to — as in-memory answers about the asset record. So indexing
 * a camera roll is a fetch plus a handful of property reads per asset, and
 * that is the whole cost. This file never asks for a pixel: one
 * `PHImageManager` request per asset would decode the library, and a scan
 * of fifty thousand frames that should cost a second would cost an
 * afternoon and a battery. The metadata-only budget in
 * `docs/PLAN-Event-Clustering-Camera-Roll.md` §3 is the reason.
 *
 * Every PhotoKit object touched here is touched on one serial queue, the
 * one the plugin owns. `PHFetchResult` and `PHChange` are not thread-safe,
 * and a fetch result goes stale the moment a change is delivered against
 * it, so the handle this class diffs against lives and dies on that lane —
 * which is also what lets a scan and a library change order themselves
 * against each other instead of racing.
 */

/// What one library notification says about the dump.
struct PhotoKitDumpDelta {
    /// Frames the library gained.
    var added: [MediaMetadataItem] = []
    /// Frames whose asset record changed — a place added afterwards, a
    /// favourite cleared, a date corrected in the Photos app.
    var updated: [MediaMetadataItem] = []
    /// Frames the user deleted, including from Recently Deleted.
    var removedIds: Set<String> = []
    /// PhotoKit could not describe this change object by object — it says
    /// so with `hasIncrementalChanges == NO` when the scope is too large —
    /// so the cached metadata cannot be patched and must be re-read.
    var needsFullRescan = false

    var isEmpty: Bool {
        !needsFullRescan && added.isEmpty && updated.isEmpty && removedIds.isEmpty
    }
}

/// Reads the system Photos library the way the event engine needs it.
final class PhotoKitDumpScanner: NSObject, PHPhotoLibraryChangeObserver {
    typealias DeltaHandler = (PhotoKitDumpDelta) -> Void

    /// The lane every method here must be called from. Injected rather
    /// than created so the scanner and the index store share one order of
    /// events: a library change and a scan cannot interleave.
    private let queue: DispatchQueue

    private var handle: PHFetchResult<PHAsset>?
    private var handler: DeltaHandler?
    private var registered = false

    init(queue: DispatchQueue) {
        self.queue = queue
        super.init()
    }

    /// Unregistration belongs to the object that registered, and a
    /// `deinit` is the only place guaranteed to run once. No other thread
    /// can be inside this instance when it is reached — the scanner is
    /// referenced only from the lane and from PhotoKit's own list — so
    /// reading `registered` here is not the race it looks like.
    deinit {
        if registered {
            PHPhotoLibrary.shared().unregisterChangeObserver(self)
        }
    }

    // MARK: - Reading the library

    /// Every image frame, oldest first, as the core wants it. The returned
    /// items are in capture order; the clusterer sorts deterministically
    /// anyway, so the fetch sort is for the handle's sake, not correctness.
    func snapshot() -> [MediaMetadataItem] {
        dispatchPrecondition(condition: .onQueue(queue))
        let result = Self.imageFetch()
        handle = result
        var items: [MediaMetadataItem] = []
        items.reserveCapacity(result.count)
        result.enumerateObjects { asset, _, _ in
            if let item = Self.item(for: asset) { items.append(item) }
        }
        return items
    }

    /// How many frames the dump covers, without touching one of them. The
    /// count is a stored property of the fetch, so this is a database
    /// question rather than a walk.
    func itemCount() -> Int {
        dispatchPrecondition(condition: .onQueue(queue))
        return PHAsset.fetchAssets(with: .image, options: nil).count
    }

    // MARK: - Incremental watching

    /// Starts describing library changes to `handler`, which is called on
    /// the scanner's queue. Re-arming is a no-op, so the plugin can call
    /// this on every pick without unbalancing PhotoKit's observer list.
    func startObserving(onDelta handler: @escaping DeltaHandler) {
        dispatchPrecondition(condition: .onQueue(queue))
        self.handler = handler
        guard !registered else { return }
        PHPhotoLibrary.shared().register(self)
        registered = true
        // A handle armed before the observer was listening would diff
        // against a library this class knows nothing about, so arm a fresh
        // one here and let the first scan replace it if it wants the items.
        handle = Self.imageFetch()
    }

    /// Stops, and drops the handle: a fetch result kept across a period of
    /// unwatched changes is exactly the stale object that must not be
    /// handed to `changeDetails(for:)` later.
    func stopObserving() {
        dispatchPrecondition(condition: .onQueue(queue))
        handler = nil
        handle = nil
        guard registered else { return }
        PHPhotoLibrary.shared().unregisterChangeObserver(self)
        registered = false
    }

    // MARK: - PHPhotoLibraryChangeObserver

    /// PhotoKit delivers on a thread of its own choosing. The work hops to
    /// the lane instead of doing anything here, because the handle it has
    /// to diff against is only valid there.
    func photoLibraryDidChange(_ changeInstance: PHChange) {
        queue.async { [weak self] in
            guard let self, self.registered else { return }
            guard let handle = self.handle,
                  let details = changeInstance.changeDetails(for: handle) else {
                // No handle, or the handle was already consumed elsewhere:
                // nothing to patch, so the store has to read the world.
                self.handle = Self.imageFetch()
                self.handler?(PhotoKitDumpDelta(needsFullRescan: true))
                return
            }
            // The after-result becomes the handle for the next change, in
            // the same breath, before the objects reached through it are
            // used for anything else.
            self.handle = details.fetchResultAfterChanges
            guard details.hasIncrementalChanges else {
                self.handler?(PhotoKitDumpDelta(needsFullRescan: true))
                return
            }
            var delta = PhotoKitDumpDelta()
            delta.added = details.insertedObjects.compactMap(Self.item(for:))
            delta.updated = details.changedObjects.compactMap(Self.item(for:))
            delta.removedIds = Set(details.removedObjects.map(\.localIdentifier))
            guard !delta.isEmpty else { return }
            self.handler?(delta)
        }
    }

    /// The library went away — the user restricted access in Settings, or
    /// the store is being rebuilt. Whatever was cached about it stops being
    /// true at this moment.
    func photoLibraryDidBecomeUnavailable(_ photoLibrary: PHPhotoLibrary) {
        queue.async { [weak self] in
            guard let self else { return }
            self.handle = nil
            self.handler?(PhotoKitDumpDelta(needsFullRescan: true))
        }
    }

    // MARK: - Mapping

    private static func imageFetch() -> PHFetchResult<PHAsset> {
        let options = PHFetchOptions()
        // Capture order, oldest first. Without a descriptor PhotoKit's own
        // order is unspecified, and an index that reads the library in a
        // random order is a harder bug to see than one that asks for the
        // order it means.
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: true)]
        return PHAsset.fetchAssets(with: .image, options: options)
    }

    /// One asset, one record — the whole bridge between PhotoKit and the
    /// engine in four properties and no bytes.
    ///
    /// Returns nil only for an asset with neither a creation nor a
    /// modification date, which the core cannot place on a timeline. The
    /// honest answer is to say the frame is unusable rather than to
    /// substitute today's date, which would graft it onto whatever event is
    /// happening this week.
    static func item(for asset: PHAsset) -> MediaMetadataItem? {
        guard let timestamp = asset.creationDate ?? asset.modificationDate else { return nil }
        // A (0, 0) fix is passed through unchanged and rejected by the
        // core's own `MediaMetadataItem.coordinate`, so the rule lives in
        // one place and the macOS header parser answers it the same way.
        // What is filtered here is a coordinate that is not a coordinate
        // at all — the NaN pair a corrupt record can carry. Note the
        // `flatMap` is on the optional CLLocation, not on the coordinate:
        // optional chaining would ask a struct for a method it does not
        // have, which is a compile error rather than a silent nil.
        let position = asset.location.flatMap {
            CLLocationCoordinate2DIsValid($0.coordinate) ? $0.coordinate : nil
        }
        return MediaMetadataItem(
            id: asset.localIdentifier,
            timestamp: timestamp,
            latitude: position?.latitude,
            longitude: position?.longitude,
            isScreenshot: asset.mediaSubtypes.contains(.photoScreenshot),
            burstIdentifier: asset.burstIdentifier,
            // Nil on purpose. There is no file to stamp: PhotoKit answers
            // the record in memory, so cache invalidation on this platform
            // rides the library's own change details, and
            // `EventIndex.needsMetadataRead` — which exists to skip EXIF
            // header reads on a backup folder — has nothing to compare.
            fileModTime: nil
        )
    }
}
