package `in`.thecontrarian.manorama.events

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.net.Uri
import androidx.core.net.toUri
import androidx.exifinterface.media.ExifInterface
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream
import java.util.UUID
import java.util.concurrent.Callable
import java.util.concurrent.CancellationException
import java.util.concurrent.ExecutionException
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.RejectedExecutionException

internal class EventAssetService(
    context: Context,
    private val source: MediaStoreSource,
    private val afterCopyOpen: (String) -> Unit = {},
    private val beforeThumbnailInstall: (String) -> Unit = {},
    private val afterThumbnailInstall: (String) -> Unit = {},
    private val progress: (String, Double) -> Unit,
) {
    private val thumbs = EventPrivateFiles.directory(File(context.cacheDir, "event-thumbs"))
    private val originals = EventPrivateFiles.directory(File(context.cacheDir, "event-originals"))
    private val executor: ExecutorService = Executors.newFixedThreadPool(2)
    private val lock = Any()
    @Volatile private var purgeGeneration = 0L
    private val generations = mutableMapOf<String, Int>()
    private val pending = mutableMapOf<String, Future<*>>()
    private val partial = mutableMapOf<Pair<String, Int>, MutableSet<File>>()
    private val issuedOriginals = mutableMapOf<String, File>()

    fun request(
        ids: List<String>,
        records: List<MediaRecord?>,
        purpose: String,
        maxPixelSize: Int,
        allowNetwork: Boolean,
        requestGeneration: Long = generation(),
        confirmNetwork: () -> Boolean,
    ): JSONArray = JSONArray().also { replies ->
        ids.forEachIndexed { index, id ->
            val record = records.getOrNull(index)
            replies.put(submit(id, requestGeneration) { generation ->
                if (purgeGeneration != requestGeneration) EventAssetReply.failed(id).json()
                else record?.let { reply(it, purpose, maxPixelSize, allowNetwork, confirmNetwork, generation) }
                    ?: EventAssetReply.missing(id).json()
            })
        }
    }

    fun generation(): Long = synchronized(lock) { purgeGeneration }

    private fun submit(id: String, requestGeneration: Long, operation: (Int) -> JSONObject): JSONObject {
        val generation = synchronized(lock) {
            val next = (generations[id] ?: 0) + 1
            generations[id] = next
            pending.remove(id)?.cancel(true)
            next
        }
        val future = try {
            executor.submit(Callable {
                try {
                    val result = try {
                        operation(generation)
                    } catch (_: InterruptedException) {
                        EventAssetReply.failed(id).json()
                    } catch (_: Exception) {
                        EventAssetReply.failed(id).json()
                    }
                    synchronized(lock) { deletePartial(id, generation) }
                    if (synchronized(lock) { generations[id] == generation && purgeGeneration == requestGeneration }) result else {
                        result.optString("url").takeIf { it.isNotBlank() && it != "null" }?.let { release(listOf(it)) }
                        EventAssetReply(id, "failed", 0, 0).json()
                    }
                } finally {
                    synchronized(lock) { deletePartial(id, generation) }
                }
            })
        } catch (_: RejectedExecutionException) {
            synchronized(lock) { deletePartial(id, generation) }
            return EventAssetReply.failed(id).json()
        }
        synchronized(lock) {
            if (generations[id] == generation && purgeGeneration == requestGeneration) pending[id] = future else future.cancel(true)
        }
        return try {
            val result = future.get()
            if (synchronized(lock) { generations[id] == generation && purgeGeneration == requestGeneration }) result else {
                result.optString("url").takeIf { it.isNotBlank() && it != "null" }?.let { release(listOf(it)) }
                EventAssetReply(id, "failed", 0, 0).json()
            }
        } catch (_: CancellationException) {
            EventAssetReply.failed(id).json()
        } catch (_: ExecutionException) {
            EventAssetReply.failed(id).json()
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
            EventAssetReply.failed(id).json()
        } finally {
            synchronized(lock) {
                if (generations[id] == generation && purgeGeneration == requestGeneration) pending.remove(id)
                deletePartial(id, generation)
            }
        }
    }

    private fun reply(
        record: MediaRecord,
        purpose: String,
        maxPixelSize: Int,
        allowNetwork: Boolean,
        confirmNetwork: () -> Boolean,
        generation: Int,
    ): JSONObject {
        if (purpose == "thumbnail") return thumbnail(record, maxPixelSize, generation)
        val local = record.localPath?.takeIf { record.hasLocalFile() }?.let(::File)
        if (local != null) return original(id = record.id, record = record, input = FileInputStream(local), generation = generation)
        if (!allowNetwork) return EventAssetReply(record.id, "cloudOnly", record.width, record.height).json()
        if (!confirmNetwork()) return EventAssetReply(record.id, "cloudOnly", record.width, record.height).json()
        progress(record.id, 0.0)
        val uri = source.contentUri(record.id) ?: return EventAssetReply.missing(record.id).json()
        return try {
            val input = source.openInputStream(uri) ?: return EventAssetReply(record.id, "failed", record.width, record.height).json()
            original(id = record.id, record = record, input = input, total = record.size, generation = generation)
        } catch (_: Exception) {
            EventAssetReply(record.id, "failed", record.width, record.height).json()
        }
    }

    private fun original(id: String, record: MediaRecord, input: InputStream, generation: Int, total: Long = -1): JSONObject {
        val lease = UUID.randomUUID().toString()
        val directory = EventPrivateFiles.directory(File(originals, lease))
        val extension = extension(record)
        val target = File(directory, "${UUID.randomUUID()}.$extension")
        synchronized(lock) { partial.getOrPut(id to generation) { mutableSetOf() }.add(target) }
        return try {
            input.use { stream ->
                FileOutputStream(target).use { output ->
                    afterCopyOpen(id)
                    val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                    var copied = 0L
                    while (true) {
                        if (Thread.currentThread().isInterrupted) throw InterruptedException()
                        val count = stream.read(buffer)
                        if (count < 0) break
                        output.write(buffer, 0, count)
                        copied += count
                        if (total > 0) progress(id, (copied.toDouble() / total).coerceIn(0.0, 0.95))
                    }
                    output.flush()
                    output.fd.sync()
                }
            }
            target.setReadable(false, false)
            target.setWritable(false, false)
            target.setReadable(true, true)
            target.setWritable(false, true)
            synchronized(lock) {
                partial[id to generation]?.remove(target)
                issuedOriginals[target.absolutePath] = target
            }
            progress(id, 1.0)
            EventAssetReply(id, "ready", record.width, record.height, target.toUri().toString()).json()
        } catch (_: Exception) {
            target.delete()
            directory.delete()
            EventAssetReply(id, "failed", record.width, record.height).json()
        }
    }

    private fun thumbnail(record: MediaRecord, maxPixelSize: Int, generation: Int): JSONObject {
        val path = record.localPath?.takeIf { record.hasLocalFile() } ?: return EventAssetReply(record.id, "cloudOnly", record.width, record.height).json()
        val key = EventPrivateFiles.sha256("${record.id}|${record.fileModTime}|${record.size}|${record.width}|${record.height}|$maxPixelSize")
        val cached = File(thumbs, "$key.jpg")
        synchronized(lock) {
            if (cached.isFile && cached.length() > 0) {
                cached.setLastModified(System.currentTimeMillis())
                val dimensions = bitmapBounds(cached)
                if (dimensions.first > 0 && dimensions.second > 0) {
                    return EventAssetReply(record.id, "ready", dimensions.first, dimensions.second, cached.toUri().toString()).json()
                }
                cached.delete()
            }
        }
        val target = File(thumbs, ".$key.${System.nanoTime()}.tmp")
        synchronized(lock) { partial.getOrPut(record.id to generation) { mutableSetOf() }.add(target) }
        return try {
            val orientation = try { ExifInterface(path).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL) } catch (_: Exception) { ExifInterface.ORIENTATION_NORMAL }
            val bounds = bitmapBounds(File(path))
            val targetLongEdge = minOf(maxPixelSize, maxOf(bounds.first, bounds.second)).coerceAtLeast(1)
            val options = BitmapFactory.Options().apply {
                inJustDecodeBounds = false
                inSampleSize = sampleSize(bounds.first, bounds.second, targetLongEdge)
            }
            val decoded = BitmapFactory.decodeFile(path, options) ?: return EventAssetReply(record.id, "failed", record.width, record.height).json()
            val oriented = orient(decoded, orientation)
            if (oriented !== decoded) decoded.recycle()
            val scale = minOf(
                1.0,
                targetLongEdge.toDouble() / maxOf(oriented.width, oriented.height),
                record.width.takeIf { it > 0 }?.toDouble()?.div(oriented.width) ?: 1.0,
                record.height.takeIf { it > 0 }?.toDouble()?.div(oriented.height) ?: 1.0,
            )
            val bitmap = if (scale < 0.999) Bitmap.createScaledBitmap(
                oriented,
                (oriented.width * scale).toInt().coerceAtLeast(1),
                (oriented.height * scale).toInt().coerceAtLeast(1),
                true,
            ) else oriented
            if (bitmap !== oriented) oriented.recycle()
            FileOutputStream(target).use { bitmap.compress(Bitmap.CompressFormat.JPEG, 90, it) }
            val dimensions = bitmap.width to bitmap.height
            bitmap.recycle()
            beforeThumbnailInstall(record.id)
            val installed = synchronized(lock) {
                if (generations[record.id] != generation) {
                    target.delete()
                    false
                } else {
                    partial[record.id to generation]?.remove(target)
                    trimCache(target.length())
                    if (!target.renameTo(cached)) error("Could not install event thumbnail")
                    target.setLastModified(System.currentTimeMillis())
                    true
                }
            }
            afterThumbnailInstall(record.id)
            if (!installed) return EventAssetReply.failed(record.id).json()
            EventAssetReply(record.id, "ready", dimensions.first, dimensions.second, cached.toUri().toString()).json()
        } catch (_: Exception) {
            target.delete()
            EventAssetReply(record.id, "failed", record.width, record.height).json()
        }
    }

    fun cancel(ids: List<String>) {
        ids.forEach { id ->
            synchronized(lock) {
                val current = generations[id] ?: 0
                generations[id] = current + 1
                pending.remove(id)?.cancel(true)
                deletePartial(id, current)
            }
        }
    }

    fun release(urls: List<String>) = synchronized(lock) {
        urls.forEach { value ->
            val path = runCatching { Uri.parse(value).path }.getOrNull() ?: return@forEach
            if (!ORIGINAL_URL.matches(value)) return@forEach
            val file = issuedOriginals.remove(path) ?: return@forEach
            val canonical = runCatching { file.canonicalFile }.getOrNull() ?: return@forEach
            if (canonical.parentFile?.parentFile?.canonicalFile == originals.canonicalFile) {
                file.delete()
                canonical.parentFile?.delete()
            }
        }
    }

    fun clear() {
        synchronized(lock) {
            purgeGeneration++
            generations.keys.toList().forEach { id ->
                val current = generations[id] ?: 0
                generations[id] = current + 1
                pending.remove(id)?.cancel(true)
                deletePartial(id, current)
            }
            partial.keys.toList().forEach { (id, generation) -> deletePartial(id, generation) }
            issuedOriginals.clear()
        }
        EventPrivateFiles.deleteTree(originals)
        EventPrivateFiles.deleteTree(thumbs)
        EventPrivateFiles.directory(originals)
        EventPrivateFiles.directory(thumbs)
    }

    fun sweepLaunch() {
        EventPrivateFiles.deleteTree(originals)
        EventPrivateFiles.directory(originals)
        synchronized(lock) {
            issuedOriginals.clear()
            trimCache(0)
        }
    }

    fun close() {
        clear()
        executor.shutdownNow()
    }

    private fun deletePartial(id: String, generation: Int) {
        partial.remove(id to generation)?.forEach { it.delete() }
    }

    private fun trimCache(incoming: Long) {
        val files = thumbs.listFiles()?.filter { it.isFile && THUMB_FILE.matches(it.name) }?.sortedBy { it.lastModified() } ?: return
        var size = files.sumOf { it.length() } + incoming
        for (file in files) {
            if (size <= CACHE_BUDGET) break
            size -= file.length()
            file.delete()
        }
    }

    private fun bitmapBounds(file: File): Pair<Int, Int> = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        .let { BitmapFactory.decodeFile(file.absolutePath, it); it.outWidth to it.outHeight }
        .let { (width, height) -> width.coerceAtLeast(0) to height.coerceAtLeast(0) }

    private fun sampleSize(width: Int, height: Int, target: Int): Int {
        if (width <= 0 || height <= 0) return 1
        // The long edge decides: a panorama whose short edge is already small
        // must still be downsampled, or the decoder allocates hundreds of MiB
        // before any scaling runs.
        var sample = 1
        while (maxOf(width, height) / (sample * 2) >= target) sample *= 2
        return sample
    }

    private fun orient(bitmap: Bitmap, orientation: Int): Bitmap {
        val matrix = Matrix()
        when (orientation) {
            ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> matrix.setScale(-1f, 1f)
            ExifInterface.ORIENTATION_ROTATE_180 -> matrix.setRotate(180f)
            ExifInterface.ORIENTATION_FLIP_VERTICAL -> matrix.setScale(1f, -1f)
            ExifInterface.ORIENTATION_TRANSPOSE -> { matrix.setRotate(90f); matrix.postScale(-1f, 1f) }
            ExifInterface.ORIENTATION_ROTATE_90 -> matrix.setRotate(90f)
            ExifInterface.ORIENTATION_TRANSVERSE -> { matrix.setRotate(270f); matrix.postScale(-1f, 1f) }
            ExifInterface.ORIENTATION_ROTATE_270 -> matrix.setRotate(270f)
            else -> return bitmap
        }
        return Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
    }

    private fun extension(record: MediaRecord): String = when {
        record.mimeType == "image/jpeg" -> "jpg"
        record.mimeType == "image/png" -> "png"
        record.mimeType == "image/webp" -> "webp"
        record.mimeType == "image/heic" -> "heic"
        record.mimeType == "image/heif" -> "heif"
        record.mimeType == "image/gif" -> "gif"
        else -> record.displayName?.substringAfterLast('.', "")?.lowercase()?.takeIf { it.matches(Regex("[a-z0-9]{1,10}")) } ?: "jpg"
    }

    private data class EventAssetReply(val id: String, val state: String, val width: Int, val height: Int, val url: String? = null) {
        fun json(): JSONObject = JSONObject()
            .put("id", id)
            .put("url", url ?: JSONObject.NULL)
            .put("width", width)
            .put("height", height)
            .put("state", state)

        companion object {
            fun missing(id: String) = EventAssetReply(id, "missing", 0, 0)
            fun failed(id: String) = EventAssetReply(id, "failed", 0, 0)
        }
    }

    companion object {
        const val CACHE_BUDGET = 200L * 1024 * 1024
        val THUMB_FILE = Regex("[0-9a-f]{64}\\.jpg")
        val ORIGINAL_URL = Regex("file:///.*/event-originals/[0-9a-f-]{36}/[0-9a-f-]{36}\\.[a-zA-Z0-9]{1,10}")
    }
}
