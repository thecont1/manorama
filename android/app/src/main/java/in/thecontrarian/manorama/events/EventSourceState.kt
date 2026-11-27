package `in`.thecontrarian.manorama.events

import android.content.Context
import org.json.JSONObject
import java.io.File

internal data class EventHeader(val lastIndexedAt: Double, val eventCount: Int)

internal data class EventSourceState(
    val enabled: Boolean = false,
    val sourceId: String? = null,
    val sourceKind: String? = null,
    val bucketId: String? = null,
    val label: String? = null,
    val selectedPhotoCount: Int? = null,
    val downloadCloudOnOpen: Boolean = false,
    val permissionRequested: Boolean = false,
    val locationRead: Boolean? = null,
    val header: EventHeader? = null,
)

internal fun eventSourceReachable(
    state: EventSourceState,
    permissionGranted: Boolean,
    bucketCount: (String?) -> Int,
): Boolean = state.enabled && permissionGranted && (state.bucketId == null || bucketCount(state.bucketId) > 0)

internal class EventStateStore(context: Context) {
    private val directory = EventPrivateFiles.directory(File(context.filesDir, "EventClustering"))
    private val stateFile = File(directory, "source-state.json")
    val indexFile = File(directory, "events-index.json")
    private val lock = Any()
    private var cached: EventSourceState? = null

    fun read(): EventSourceState = synchronized(lock) {
        cached ?: decode().also { cached = it }
    }

    fun update(change: (EventSourceState) -> EventSourceState): EventSourceState = synchronized(lock) {
        val next = change(read())
        write(next)
        cached = next
        next
    }

    private fun decode(): EventSourceState {
        if (!stateFile.isFile) return EventSourceState()
        return try {
            val json = JSONObject(stateFile.readText())
            EventSourceState(
                enabled = json.optBoolean("enabled", false),
                sourceId = json.optStringOrNull("sourceId"),
                sourceKind = json.optStringOrNull("sourceKind"),
                bucketId = json.optStringOrNull("bucketId"),
                label = json.optStringOrNull("label"),
                selectedPhotoCount = json.opt("selectedPhotoCount")?.let { it as? Number }?.toInt(),
                downloadCloudOnOpen = json.optBoolean("downloadCloudOnOpen", false),
                permissionRequested = json.optBoolean("permissionRequested", false),
                locationRead = if (!json.has("locationRead") || json.isNull("locationRead")) null else json.optBoolean("locationRead"),
                header = if (json.has("header") && !json.isNull("header")) {
                    val header = json.getJSONObject("header")
                    EventHeader(header.getDouble("lastIndexedAt"), header.getInt("eventCount"))
                } else null,
            )
        } catch (_: Exception) {
            indexFile.delete()
            EventSourceState()
        }
    }

    private fun write(state: EventSourceState) {
        val header = state.header
        val json = JSONObject()
            .put("enabled", state.enabled)
            .put("sourceId", state.sourceId ?: JSONObject.NULL)
            .put("sourceKind", state.sourceKind ?: JSONObject.NULL)
            .put("bucketId", state.bucketId ?: JSONObject.NULL)
            .put("label", state.label ?: JSONObject.NULL)
            .put("selectedPhotoCount", state.selectedPhotoCount ?: JSONObject.NULL)
            .put("downloadCloudOnOpen", state.downloadCloudOnOpen)
            .put("permissionRequested", state.permissionRequested)
            .put("locationRead", state.locationRead ?: JSONObject.NULL)
            .put("header", header?.let {
                JSONObject().put("lastIndexedAt", it.lastIndexedAt).put("eventCount", it.eventCount)
            } ?: JSONObject.NULL)
        EventPrivateFiles.writeAtomic(stateFile, json.toString(2).toByteArray(Charsets.UTF_8))
    }
}

private fun JSONObject.optStringOrNull(name: String): String? =
    if (has(name) && !isNull(name)) optString(name).takeIf { it.isNotBlank() } else null
