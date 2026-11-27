package `in`.thecontrarian.manorama.events

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.MediaStore
import android.provider.Settings
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.TimeZone
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executor
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.TimeUnit

internal fun submitSettled(
    executor: Executor,
    reject: (String) -> Unit,
    failureMessage: String,
    action: () -> Unit,
) {
    try {
        executor.execute {
            try {
                action()
            } catch (_: Throwable) {
                reject(failureMessage)
            }
        }
    } catch (_: RejectedExecutionException) {
        reject("The Camera Roll service is no longer available")
    }
}

@CapacitorPlugin(name = "EventClustering")
class EventClusteringPlugin : Plugin() {
    private val worker = Executors.newSingleThreadExecutor()
    private val assetWorker = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private lateinit var stateStore: EventStateStore
    private lateinit var source: MediaStoreSource
    private lateinit var assets: EventAssetService
    private lateinit var observer: MediaObserver
    private lateinit var permissionLauncher: ActivityResultLauncher<Array<String>>
    private var pendingPermissionCall: PluginCall? = null
    private var permissionAction = PermissionAction.PICK
    private var lastAuthorization: String? = null
    private var lastLocationPermission = false
    private var deviceId: String? = null
    private var downloadDialog: AlertDialog? = null
    private var downloadDialogId: String? = null

    // Cancellation tokens are recorded when a request is queued, not when it
    // starts: a cancel that lands while the request still waits on assetWorker
    // must stop it from ever opening a prompt or issuing a lease.
    private val assetCallLock = Any()
    private val assetCallTokens = mutableMapOf<String, Long>()
    private var assetCallCounter = 0L

    private enum class PermissionAction { PICK, LIMITED }

    override fun load() {
        stateStore = EventStateStore(bridge.context)
        source = MediaStoreSource(bridge.context)
        assets = EventAssetService(bridge.context, source) { id, fraction ->
            notifyListeners("eventAssetProgress", JSObject().put("id", id).put("fraction", fraction))
        }
        observer = MediaObserver(
            bridge.context.contentResolver,
            MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
        ) { libraryChanged() }
        permissionLauncher = bridge.registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
            onPermissions(result)
        }
        worker.execute {
            val state = stateStore.read()
            lastAuthorization = authorizationName(state)
            lastLocationPermission = hasLocationPermission()
            assets.sweepLaunch()
            stableDeviceId()
            if (state.enabled && hasPhotoPermission()) observer.start()
        }
    }

    @PluginMethod
    fun pickRawDumpRoot(call: PluginCall) {
        if (hasPhotoPermission()) {
            showSourcePicker(call)
        } else {
            requestPermissions(call, PermissionAction.PICK)
        }
    }

    @PluginMethod
    fun getRawDumpStatus(call: PluginCall) {
        submitSettled(worker, { message -> main.post { call.reject(message) } }, "The Camera Roll status could not be read") {
            val state = stateStore.read()
            val reachable = eventSourceReachable(state, hasPhotoPermission(), source::count)
            val payload = JSObject()
                .put("configured", state.enabled)
                .put("label", state.label ?: JSObject.NULL)
                .put("isAvailable", reachable)
                .put("lastIndexedAt", state.header?.lastIndexedAt?.times(1000)?.toLong()?.toDouble() ?: JSObject.NULL)
                .put("eventCount", state.header?.eventCount ?: 0)
                .put("authorization", authorizationName(state))
                .put("selectedPhotoCount", if (reachable) state.selectedPhotoCount ?: JSObject.NULL else JSObject.NULL)
                .put("downloadCloudOnOpen", state.downloadCloudOnOpen)
            main.post { call.resolve(payload) }
        }
    }

    @PluginMethod
    fun scanRawDumpEvents(call: PluginCall) {
        val force = call.getBoolean("force") ?: false
        submitSettled(worker, { message -> main.post { call.reject(message) } }, "The Camera Roll event index could not be built") {
            val state = stateStore.read()
            if (!state.enabled || state.sourceId == null) {
                main.post { call.reject("No Camera Roll source is declared on this device") }
                return@submitSettled
            }
            if (!hasPhotoPermission()) {
                main.post { call.reject("Camera Roll access is not granted for this app") }
                return@submitSettled
            }
            if (state.bucketId != null && source.count(state.bucketId) == 0) {
                main.post { call.reject("The selected Camera Roll folder is no longer available. Choose it again in Library Settings.") }
                return@submitSettled
            }
            val id = stableDeviceId()
            val location = hasLocationPermission()
            val previous = readIndex(id, state.sourceId, force || state.locationRead != location)
            val oldItems = previous?.optJSONObject("itemCache")
            val oldConfig = previous?.optJSONObject("config") ?: JSONObject()
            val items = source.metadata(state.bucketId, location) { record ->
                val cached = oldItems?.optJSONObject(record.id) ?: return@metadata null
                val cachedModified = cached.optDouble("fileModTime", Double.NaN)
                val currentModified = record.fileModTime ?: Double.NaN
                if (!cachedModified.isFinite() || !currentModified.isFinite() || currentModified - cachedModified >= 1.0 || cachedModified - currentModified >= 1.0) {
                    return@metadata null
                }
                if (cached.has("latitude") && cached.has("longitude")) {
                    cached.getDouble("latitude") to cached.getDouble("longitude")
                } else null
            }
            val indexedAt = System.currentTimeMillis() / 1000.0
            val options = JSONObject()
                .put("sourceId", state.sourceId)
                .put("calendar", JSONObject()
                    .put("identifier", "gregorian")
                    .put("timeZoneIdentifier", TimeZone.getDefault().id))
                .put("config", oldConfig)
            val result = JSONObject(RustBridge.cluster(JSONArray(items).toString(), options.toString()))
            val cache = JSONObject()
            items.forEach { cache.put(it.getString("id"), it) }
            val index = JSONObject()
                .put("schemaVersion", 1)
                .put("source", JSONObject()
                    .put("deviceId", id)
                    .put("sourceId", state.sourceId)
                    .put("sourceKind", state.sourceKind ?: "library")
                    .put("label", state.label ?: "Camera Roll")
                    .put("lastIndexedAt", indexedAt))
                .put("config", oldConfig)
                .put("itemCache", cache)
                .put("events", result.getJSONArray("events"))
                .put("screenshotItemIds", result.getJSONArray("screenshotItemIds"))
            val encoded = RustBridge.encodeIndex(index.toString())
            EventPrivateFiles.writeAtomic(stateStore.indexFile, encoded.toByteArray(Charsets.UTF_8))
            val events = result.getJSONArray("events")
            stateStore.update {
                it.copy(
                    selectedPhotoCount = items.size,
                    locationRead = location,
                    header = EventHeader(indexedAt, events.length()),
                )
            }
            val payload = JSObject()
                .put("clusters", wireClusters(events))
                .put("screenshotCount", result.getJSONArray("screenshotItemIds").length())
                .put("rootPath", JSObject.NULL)
            main.post { call.resolve(payload) }
        }
    }

    @PluginMethod
    fun clearRawDumpRoot(call: PluginCall) {
        submitSettled(worker, { message -> main.post { call.reject(message) } }, "The Camera Roll folder could not be cleared") {
            synchronized(assetCallLock) { assetCallTokens.clear() }
            assets.clear()
            observer.stop()
            dismissDownloadDialog()
            stateStore.indexFile.delete()
            stateStore.update {
                it.copy(
                    enabled = false,
                    sourceId = null,
                    sourceKind = null,
                    bucketId = null,
                    label = null,
                    selectedPhotoCount = null,
                    locationRead = null,
                    header = null,
                )
            }
            main.post { call.resolve() }
        }
    }

    @PluginMethod
    fun getEventAssetImage(call: PluginCall) {
        val request = runCatching { parseAssetRequest(call) }.getOrNull()
        if (request == null) {
            call.reject("Invalid event photograph request")
            return
        }
        val tokens = synchronized(assetCallLock) {
            request.ids.associateWith { id ->
                val token = ++assetCallCounter
                assetCallTokens[id] = token
                token
            }
        }
        fun tokensCurrent(): Boolean = synchronized(assetCallLock) {
            request.ids.all { assetCallTokens[it] == tokens[it] }
        }
        try {
            assetWorker.execute {
                try {
                    if (!tokensCurrent()) {
                        main.post { call.reject("Event photograph request cancelled") }
                        return@execute
                    }
                    // Generation and state must agree: the source transition
                    // clears assets on the worker thread while this task reads
                    // on assetWorker, so re-check the generation after reading
                    // state. A mismatch means the request straddled a switch
                    // and must not serve the retired source's photographs.
                    val assetGeneration = assets.generation()
                    val state = stateStore.read()
                    if (assets.generation() != assetGeneration || !tokensCurrent()) {
                        main.post { call.reject("Event photograph request cancelled") }
                        return@execute
                    }
                    if (!eventSourceReachable(state, hasPhotoPermission(), source::count)) {
                        main.post { call.reject("Camera Roll access is not available") }
                        return@execute
                    }
                    val records = request.ids.map { source.record(it, state.bucketId) }
                    if (assets.generation() != assetGeneration || !tokensCurrent()) {
                        main.post { call.reject("Event photograph request cancelled") }
                        return@execute
                    }
                    val allowNetwork = request.allowNetwork && state.downloadCloudOnOpen
                    val replies = assets.request(
                        request.ids,
                        records,
                        request.purpose,
                        request.maxPixelSize,
                        allowNetwork,
                        requestGeneration = assetGeneration,
                    ) {
                        allowNetwork && confirmDownload(request.ids.single())
                    }
                    main.post { call.resolve(JSObject().put("items", replies)) }
                } catch (_: Throwable) {
                    main.post { call.reject("The event photograph could not be opened") }
                }
            }
        } catch (_: RejectedExecutionException) {
            call.reject("The event photograph service is no longer available")
        }
    }

    @PluginMethod
    fun cancelEventAssetImage(call: PluginCall) {
        val ids = call.stringList("ids")?.takeIf { validIds(it) }
        if (ids == null) {
            call.reject("Invalid event photograph identifiers")
            return
        }
        try {
            synchronized(assetCallLock) {
                ids.forEach { assetCallTokens.remove(it) }
            }
            assets.cancel(ids)
            if (downloadDialogId in ids) dismissDownloadDialog()
            call.resolve()
        } catch (_: Throwable) {
            call.reject("The event photograph request could not be cancelled")
        }
    }

    @PluginMethod
    fun releaseEventAssetImages(call: PluginCall) {
        val urls = call.stringList("urls")?.takeIf { values ->
            values.size <= 512 && values.all { it.length <= 8192 && it.startsWith("file:///") }
        }
        if (urls == null) {
            call.reject("Invalid event photograph URLs")
            return
        }
        try {
            assets.release(urls)
            call.resolve()
        } catch (_: Throwable) {
            call.reject("The event photographs could not be released")
        }
    }

    @PluginMethod
    fun setEventCloudDownload(call: PluginCall) {
        val enabled = call.getBoolean("enabled")
        if (enabled == null) {
            call.reject("A cloud download preference is required")
            return
        }
        submitSettled(worker, { message -> main.post { call.reject(message) } }, "The cloud download preference could not be changed") {
            stateStore.update { it.copy(downloadCloudOnOpen = enabled) }
            main.post { call.resolve() }
        }
    }

    @PluginMethod
    fun presentLimitedLibraryPicker(call: PluginCall) {
        if (Build.VERSION.SDK_INT < 34) {
            call.reject("Selected photo access is not available on this Android version")
            return
        }
        worker.execute {
            try {
                if (hasPhotoPermission() && authorizationName(stateStore.read()) == "authorized") {
                    main.post { call.resolve() }
                    return@execute
                }
                requestPermissions(call, PermissionAction.LIMITED)
            } catch (_: Throwable) {
                main.post { call.reject("Selected photo access could not be requested") }
            }
        }
    }

    @PluginMethod
    fun openEventPhotosSettings(call: PluginCall) {
        val activity = bridge.activity
        if (activity == null) {
            call.reject("Android Settings is not available")
            return
        }
        main.post {
            activity.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${activity.packageName}")))
            call.resolve()
        }
    }

    @PluginMethod
    fun openEventAssetInPhotos(call: PluginCall) {
        val id = call.getString("id")
        if (id == null || !MediaStoreSource.isMediaStoreId(id)) {
            call.reject("Invalid event photograph identifier")
            return
        }
        try {
            worker.execute {
                try {
                    val state = stateStore.read()
                    val record = if (state.enabled && hasPhotoPermission()) source.record(id, state.bucketId) else null
                    val uri = record?.let { source.contentUri(it.id) }
                    val activity = bridge.activity
                    if (record == null || uri == null || activity == null) {
                        main.post { call.reject("The event photograph is not available") }
                        return@execute
                    }
                    main.post {
                        try {
                            val intent = Intent(Intent.ACTION_VIEW).setDataAndType(uri, record.mimeType ?: "image/*")
                                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                            activity.startActivity(Intent.createChooser(intent, null))
                            call.resolve()
                        } catch (_: Throwable) {
                            call.reject("The event photograph could not be opened")
                        }
                    }
                } catch (_: Throwable) {
                    main.post { call.reject("The event photograph could not be opened") }
                }
            }
        } catch (_: RejectedExecutionException) {
            call.reject("The event photograph service is no longer available")
        }
    }

    override fun handleOnResume() {
        worker.execute {
            val state = stateStore.read()
            val authorization = authorizationName(state)
            val location = hasLocationPermission()
            val locationChanged = location != lastLocationPermission
            if (authorization != lastAuthorization || locationChanged) {
                lastAuthorization = authorization
                lastLocationPermission = location
                assets.clear()
                stateStore.update {
                    it.copy(
                        locationRead = if (locationChanged) null else it.locationRead,
                        selectedPhotoCount = if (hasPhotoPermission() && it.enabled) source.count(it.bucketId) else null,
                    )
                }
                if (state.enabled && hasPhotoPermission()) observer.start() else observer.stop()
                notifyListeners("eventLibraryChanged", JSObject())
            }
        }
    }

    override fun handleOnDestroy() {
        assetWorker.shutdownNow()
        dismissDownloadDialog()
        try {
            worker.execute {
                observer.stop()
                assets.close()
                worker.shutdown()
            }
        } catch (_: RejectedExecutionException) {
            Unit
        }
    }

    private fun requestPermissions(call: PluginCall, action: PermissionAction) {
        if (pendingPermissionCall != null) {
            call.reject("Another photo access request is already open")
            return
        }
        stateStore.update { it.copy(permissionRequested = true) }
        pendingPermissionCall = call
        permissionAction = action
        bridge.saveCall(call)
        main.post { permissionLauncher.launch(permissions()) }
    }

    private fun onPermissions(result: Map<String, Boolean>) {
        val call = pendingPermissionCall ?: return
        val action = permissionAction
        pendingPermissionCall = null
        bridge.releaseCall(call)
        if (!hasPhotoPermission()) {
            call.reject("Camera Roll access is not granted for this app")
            return
        }
        if (action == PermissionAction.LIMITED) {
            call.resolve()
            return
        }
        showSourcePicker(call)
    }

    private fun showSourcePicker(call: PluginCall) {
        worker.execute {
            val buckets = try {
                source.buckets().sortedWith(compareBy<MediaBucket> {
                    !it.label.equals("Camera", ignoreCase = true) && !it.label.equals("Camera Roll", ignoreCase = true)
                }.thenBy { it.label.lowercase() })
            } catch (_: Exception) {
                main.post { call.reject("The Camera Roll folders could not be read") }
                return@execute
            }
            val labels = listOf("All photos") + buckets.map { if (it.label.equals("Camera", true)) "Camera Roll" else it.label }
            val activity = bridge.activity
            if (activity == null) {
                main.post { call.reject("The Camera Roll picker is not available") }
                return@execute
            }
            main.post {
                AlertDialog.Builder(activity)
                    .setTitle("Camera Roll")
                    .setItems(labels.toTypedArray()) { _, which ->
                        worker.execute {
                            try {
                                val bucket = buckets.getOrNull(which - 1)
                                val label = labels[which]
                                val sourceId = bucket?.let { "mediastore-bucket-${it.id}" } ?: "mediastore-library"
                                synchronized(assetCallLock) { assetCallTokens.clear() }
                                assets.clear()
                                stateStore.indexFile.delete()
                                stateStore.update {
                                    it.copy(
                                        enabled = true,
                                        sourceId = sourceId,
                                        sourceKind = if (bucket == null) "library" else "folder",
                                        bucketId = bucket?.id,
                                        label = label,
                                        selectedPhotoCount = bucket?.count ?: source.totalCount(),
                                        locationRead = null,
                                        header = null,
                                    )
                                }
                                observer.start()
                                main.post {
                                    call.resolve(JSObject()
                                        .put("label", label)
                                        .put("itemCount", bucket?.count ?: source.totalCount())
                                        .put("rootPath", JSObject.NULL))
                                }
                            } catch (_: Exception) {
                                main.post { call.reject("The private Camera Roll state could not be written") }
                            }
                        }
                    }
                    .setOnCancelListener { call.resolve() }
                    .show()
            }
        }
    }

    private fun permissions(): Array<String> = buildList {
        if (Build.VERSION.SDK_INT >= 34) {
            add(android.Manifest.permission.READ_MEDIA_IMAGES)
            add(android.Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED)
        } else if (Build.VERSION.SDK_INT >= 33) {
            add(android.Manifest.permission.READ_MEDIA_IMAGES)
        } else {
            add(android.Manifest.permission.READ_EXTERNAL_STORAGE)
        }
        if (Build.VERSION.SDK_INT >= 29) add(android.Manifest.permission.ACCESS_MEDIA_LOCATION)
    }.toTypedArray()

    private fun hasPhotoPermission(): Boolean = permissions()
        .filter { it != android.Manifest.permission.ACCESS_MEDIA_LOCATION }
        .any { ContextCompat.checkSelfPermission(bridge.context, it) == PackageManager.PERMISSION_GRANTED }

    private fun hasLocationPermission(): Boolean =
        Build.VERSION.SDK_INT < 29 || ContextCompat.checkSelfPermission(bridge.context, android.Manifest.permission.ACCESS_MEDIA_LOCATION) == PackageManager.PERMISSION_GRANTED

    private fun authorizationName(state: EventSourceState): String {
        if (!hasPhotoPermission()) return if (state.permissionRequested) "denied" else "notDetermined"
        return if (Build.VERSION.SDK_INT >= 34 &&
            ContextCompat.checkSelfPermission(bridge.context, android.Manifest.permission.READ_MEDIA_IMAGES) != PackageManager.PERMISSION_GRANTED &&
            ContextCompat.checkSelfPermission(bridge.context, android.Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED) == PackageManager.PERMISSION_GRANTED
        ) "limited" else "authorized"
    }

    private fun readIndex(deviceId: String, sourceId: String, force: Boolean): JSONObject? {
        if (force) {
            stateStore.indexFile.delete()
            return null
        }
        if (!stateStore.indexFile.isFile) return null
        return try {
            val decoded = JSONObject(RustBridge.decodeIndex(stateStore.indexFile.readText()))
            val fingerprint = decoded.getJSONObject("source")
            if (fingerprint.getString("deviceId") == deviceId && fingerprint.getString("sourceId") == sourceId) decoded else null
        } catch (_: Exception) {
            stateStore.indexFile.delete()
            null
        }
    }

    private fun wireClusters(events: JSONArray): JSONArray = JSONArray().also { output ->
        for (index in 0 until events.length()) {
            val event = events.getJSONObject(index)
            event.put("startDate", milliseconds(event.getDouble("startDate")))
            event.put("endDate", milliseconds(event.getDouble("endDate")))
            val days = event.optJSONArray("subDays")
            if (days != null) for (dayIndex in 0 until days.length()) days.getJSONObject(dayIndex).put("date", milliseconds(days.getJSONObject(dayIndex).getDouble("date")))
            output.put(event)
        }
    }

    private fun milliseconds(seconds: Double): Double = Math.round(seconds * 1000).toDouble()

    private fun stableDeviceId(): String {
        deviceId?.let { return it }
        val file = File(File(bridge.context.filesDir, "EventClustering"), "device-id")
        val id = if (file.isFile) file.readText().trim() else UUID.randomUUID().toString().also {
            EventPrivateFiles.writeAtomic(file, it.toByteArray(Charsets.UTF_8))
        }
        deviceId = id
        return id
    }

    private fun parseAssetRequest(call: PluginCall): AssetRequest {
        val ids = call.stringList("ids") ?: error("ids")
        if (!validIds(ids)) error("ids")
        val purpose = call.getString("purpose")
        if (purpose != "thumbnail" && purpose != "viewer") error("purpose")
        val size = call.getInt("maxPixelSize") ?: 512
        if (size !in 1..8192) error("maxPixelSize")
        val network = call.getBoolean("allowNetwork") ?: false
        if (network && (purpose != "viewer" || ids.size != 1)) error("allowNetwork")
        return AssetRequest(ids, purpose, size, network)
    }

    private fun validIds(ids: List<String>): Boolean =
        ids.isNotEmpty() && ids.size <= 64 && ids.toSet().size == ids.size && ids.all(MediaStoreSource::isMediaStoreId)

    private fun PluginCall.stringList(name: String): List<String>? {
        return try {
            val array = data.optJSONArray(name) ?: return null
            List(array.length()) { array.getString(it) }
        } catch (_: Exception) {
            null
        }
    }

    private fun libraryChanged() {
        // A stale observer delivery can arrive after teardown has shut the
        // worker down; a rejected execution must not throw on the main thread.
        try {
            worker.execute {
                if (stateStore.read().enabled) notifyListeners("eventLibraryChanged", JSObject())
            }
        } catch (_: RejectedExecutionException) {
            Unit
        }
    }

    private fun confirmDownload(id: String): Boolean {
        val activity = bridge.activity ?: return false
        if (isUnconstrained()) return true
        val latch = CountDownLatch(1)
        val accepted = booleanArrayOf(false)
        main.post {
            if (activity.isFinishing || activity.isDestroyed) {
                latch.countDown()
                return@post
            }
            downloadDialogId = id
            downloadDialog = AlertDialog.Builder(activity)
                .setMessage("Download this photograph?")
                .setNegativeButton("Cancel", null)
                .setPositiveButton("Download") { _, _ -> accepted[0] = true }
                .setOnCancelListener { accepted[0] = false }
                .setOnDismissListener {
                    downloadDialog = null
                    downloadDialogId = null
                    latch.countDown()
                }
                .show()
        }
        return try {
            latch.await(30, TimeUnit.SECONDS) && accepted[0]
        } catch (_: InterruptedException) {
            false
        }
    }

    private fun dismissDownloadDialog() {
        main.post { downloadDialog?.dismiss() }
    }

    @Suppress("DEPRECATION")
    private fun isUnconstrained(): Boolean {
        val manager = bridge.context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return false
        val capabilities = manager.getNetworkCapabilities(manager.activeNetwork) ?: return false
        val power = bridge.context.getSystemService(Context.POWER_SERVICE) as? PowerManager
        return capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) &&
            capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) &&
            power?.isPowerSaveMode != true
    }

    private data class AssetRequest(val ids: List<String>, val purpose: String, val maxPixelSize: Int, val allowNetwork: Boolean)
}
