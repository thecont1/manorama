package `in`.thecontrarian.manorama.events

import android.content.ContentUris
import android.content.Context
import android.database.Cursor
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import androidx.exifinterface.media.ExifInterface
import org.json.JSONObject
import java.io.File
import java.io.InputStream

internal data class MediaRecord(
    val id: String,
    val timestamp: Double,
    val latitude: Double?,
    val longitude: Double?,
    val isScreenshot: Boolean,
    val fileModTime: Double?,
    val localPath: String?,
    val mimeType: String?,
    val displayName: String?,
    val width: Int,
    val height: Int,
    val size: Long,
) {
    fun metadata(includeCoordinates: Boolean = true): JSONObject = JSONObject()
        .put("id", id)
        .put("timestamp", timestamp)
        .put("isScreenshot", isScreenshot)
        .put("fileModTime", fileModTime ?: JSONObject.NULL)
        .apply {
            if (includeCoordinates) {
                latitude?.let { put("latitude", it) }
                longitude?.let { put("longitude", it) }
            }
        }

    fun hasLocalFile(): Boolean = localPath?.let { File(it).let { file -> file.isFile && file.canRead() } } == true
}

internal data class MediaBucket(val id: String, val label: String, val count: Int)

internal class MediaStoreSource(private val context: Context) {
    private val resolver get() = context.contentResolver

    fun buckets(): List<MediaBucket> {
        val projection = arrayOf(
            MediaStore.Images.Media._ID,
            MediaStore.Images.Media.BUCKET_ID,
            MediaStore.Images.Media.BUCKET_DISPLAY_NAME,
        )
        val counts = linkedMapOf<Pair<String, String>, Int>()
        resolver.query(
            MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
            projection,
            visibleSelection,
            null,
            "${MediaStore.Images.Media.BUCKET_DISPLAY_NAME} COLLATE NOCASE ASC, ${MediaStore.Images.Media.BUCKET_ID} ASC",
        )?.use { cursor ->
            val idColumn = cursor.getColumnIndexOrThrow(MediaStore.Images.Media.BUCKET_ID)
            val labelColumn = cursor.getColumnIndexOrThrow(MediaStore.Images.Media.BUCKET_DISPLAY_NAME)
            while (cursor.moveToNext()) {
                val id = cursor.getString(idColumn)?.takeIf { it.isNotBlank() } ?: continue
                val label = cursor.getString(labelColumn)?.takeIf { it.isNotBlank() } ?: "Camera Roll"
                val key = id to label
                counts[key] = (counts[key] ?: 0) + 1
            }
        }
        return counts.map { (key, count) -> MediaBucket(key.first, key.second, count) }
    }

    fun totalCount(): Int = queryCount(null)

    fun count(bucketId: String?): Int = queryCount(bucketId)

    private fun queryCount(bucketId: String?): Int {
        val selection = if (bucketId == null) visibleSelection else "$visibleSelection AND ${MediaStore.Images.Media.BUCKET_ID} = ?"
        val args = if (bucketId == null) null else arrayOf(bucketId)
        return resolver.query(
            MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
            arrayOf(MediaStore.Images.Media._ID),
            selection,
            args,
            null,
        )?.use { it.count } ?: 0
    }

    fun records(bucketId: String?): List<MediaRecord> {
        val selection = if (bucketId == null) visibleSelection else "$visibleSelection AND ${MediaStore.Images.Media.BUCKET_ID} = ?"
        val args = if (bucketId == null) null else arrayOf(bucketId)
        val result = mutableListOf<MediaRecord>()
        resolver.query(
            MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
            projection,
            selection,
            args,
            "${MediaStore.Images.Media.DATE_TAKEN} ASC, ${MediaStore.Images.Media.DATE_ADDED} ASC, ${MediaStore.Images.Media._ID} ASC",
        )?.use { cursor ->
            while (cursor.moveToNext()) result += cursor.record()
        }
        return result
    }

    fun record(id: String, bucketId: String?): MediaRecord? {
        if (!isMediaStoreId(id)) return null
        val selection = buildString {
            append(visibleSelection)
            append(" AND ${MediaStore.Images.Media._ID} = ?")
            if (bucketId != null) append(" AND ${MediaStore.Images.Media.BUCKET_ID} = ?")
        }
        val args = if (bucketId == null) arrayOf(id) else arrayOf(id, bucketId)
        return resolver.query(
            ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id.toLong()),
            projection,
            selection,
            args,
            null,
        )?.use { if (it.moveToFirst()) it.record() else null }
    }

    fun metadata(
        bucketId: String?,
        locationAllowed: Boolean,
        reusable: (MediaRecord) -> Pair<Double, Double>?,
    ): List<JSONObject> = records(bucketId).map { record ->
        val cached = if (locationAllowed) reusable(record) else null
        val coordinates = if (locationAllowed && cached == null) localCoordinates(record) else cached
        val metadata = record.metadata(includeCoordinates = false)
        if (locationAllowed && coordinates != null) {
            metadata.put("latitude", coordinates.first).put("longitude", coordinates.second)
        }
        metadata
    }

    private fun localCoordinates(record: MediaRecord): Pair<Double, Double>? {
        record.latitude?.let { latitude ->
            record.longitude?.let { return latitude to it }
        }
        val path = record.localPath?.takeIf { record.hasLocalFile() } ?: return null
        return try {
            val exif = ExifInterface(path)
            val coordinates = exif.latLong?.takeIf { it.size == 2 && it[0].isFinite() && it[1].isFinite() }
            coordinates?.let { it[0] to it[1] }
        } catch (_: Exception) {
            null
        }
    }

    fun contentUri(id: String): Uri? =
        if (isMediaStoreId(id)) ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id.toLong()) else null

    fun openInputStream(uri: Uri): InputStream? = resolver.openInputStream(uri)

    private fun Cursor.record(): MediaRecord {
        val taken = long(MediaStore.Images.Media.DATE_TAKEN)
        val added = long(MediaStore.Images.Media.DATE_ADDED)
        val modified = long(MediaStore.Images.Media.DATE_MODIFIED)
        val timestamp = (if (taken > 0) taken else if (added > 0) added * 1000 else modified * 1000).coerceAtLeast(0)
        val name = stringOrNull(MediaStore.Images.Media.DISPLAY_NAME)
        val relative = if (Build.VERSION.SDK_INT >= 29) stringOrNull(MediaStore.Images.Media.RELATIVE_PATH) else null
        val screenshot = name.orEmpty().lowercase().let { it.contains("screenshot") || it.contains("screen_shot") || it.contains("screen-shot") } ||
            relative.orEmpty().lowercase().contains("screenshot")
        return MediaRecord(
            id = getString(getColumnIndexOrThrow(MediaStore.Images.Media._ID)),
            timestamp = timestamp / 1000.0,
            latitude = doubleOrNull(MediaStore.Images.Media.LATITUDE),
            longitude = doubleOrNull(MediaStore.Images.Media.LONGITUDE),
            isScreenshot = screenshot,
            fileModTime = if (modified > 0) modified.toDouble() else null,
            localPath = stringOrNull(MediaStore.Images.Media.DATA),
            mimeType = stringOrNull(MediaStore.Images.Media.MIME_TYPE),
            displayName = name,
            width = int(MediaStore.Images.Media.WIDTH).coerceAtLeast(0),
            height = int(MediaStore.Images.Media.HEIGHT).coerceAtLeast(0),
            size = long(MediaStore.Images.Media.SIZE).coerceAtLeast(0),
        )
    }

    private fun Cursor.long(name: String): Long =
        getColumnIndex(name).takeIf { it >= 0 }?.let { if (isNull(it)) 0L else getLong(it) } ?: 0L

    private fun Cursor.int(name: String): Int =
        getColumnIndex(name).takeIf { it >= 0 }?.let { if (isNull(it)) 0 else getInt(it) } ?: 0

    private fun Cursor.doubleOrNull(name: String): Double? =
        getColumnIndex(name).takeIf { it >= 0 }?.let { if (isNull(it)) null else getDouble(it) }?.takeIf { it.isFinite() }

    private fun Cursor.stringOrNull(name: String): String? =
        getColumnIndex(name).takeIf { it >= 0 }?.let { if (isNull(it)) null else getString(it) }

    private val projection: Array<String>
        get() = buildList {
            addAll(listOf(
                MediaStore.Images.Media._ID,
                MediaStore.Images.Media.DATE_TAKEN,
                MediaStore.Images.Media.DATE_ADDED,
                MediaStore.Images.Media.DATE_MODIFIED,
                MediaStore.Images.Media.WIDTH,
                MediaStore.Images.Media.HEIGHT,
                MediaStore.Images.Media.DISPLAY_NAME,
                MediaStore.Images.Media.MIME_TYPE,
                MediaStore.Images.Media.BUCKET_ID,
                MediaStore.Images.Media.BUCKET_DISPLAY_NAME,
                MediaStore.Images.Media.LATITUDE,
                MediaStore.Images.Media.LONGITUDE,
                MediaStore.Images.Media.SIZE,
                @Suppress("DEPRECATION") MediaStore.Images.Media.DATA,
            ))
            if (Build.VERSION.SDK_INT >= 29) {
                add(MediaStore.Images.Media.RELATIVE_PATH)
                add(MediaStore.Images.Media.IS_PENDING)
            }
            if (Build.VERSION.SDK_INT >= 30) add(MediaStore.Images.Media.IS_TRASHED)
        }.toTypedArray()

    private val visibleSelection: String
        get() = buildString {
            append("${MediaStore.Images.Media.MIME_TYPE} LIKE 'image/%'")
            if (Build.VERSION.SDK_INT >= 29) append(" AND ${MediaStore.Images.Media.IS_PENDING} = 0")
            if (Build.VERSION.SDK_INT >= 30) append(" AND ${MediaStore.Images.Media.IS_TRASHED} = 0")
        }

    companion object {
        fun isMediaStoreId(value: String): Boolean =
            value.length in 1..19 && value.first() in '1'..'9' && value.all { it in '0'..'9' } && value.toLongOrNull() != null
    }
}
