package `in`.thecontrarian.manorama.events

import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.content.ContextWrapper
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.os.Looper
import android.provider.MediaStore
import androidx.exifinterface.media.ExifInterface
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class EventBridgeInstrumentationTest {
    @get:Rule
    val permissions = GrantPermissionRule.grant(
        android.Manifest.permission.READ_MEDIA_IMAGES,
        android.Manifest.permission.ACCESS_MEDIA_LOCATION,
    )

    private lateinit var context: Context
    private lateinit var source: MediaStoreSource
    private lateinit var assets: EventAssetService
    private val inserted = mutableListOf<Long>()
    private val fixtureFiles = mutableListOf<File>()

    @Before
    fun setUp() {
        context = InstrumentationRegistry.getInstrumentation().targetContext
        source = MediaStoreSource(context)
        assets = EventAssetService(context, source) { _, _ -> }
    }

    @After
    fun tearDown() {
        assets.close()
        if (inserted.isNotEmpty()) {
            context.contentResolver.delete(
                MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                "${MediaStore.Images.Media._ID} IN (${inserted.joinToString(",")})",
                null,
            )
        }
        fixtureFiles.forEach { it.delete() }
    }

    @Test
    fun mediaStoreMetadataIsBucketScopedAndPermissionGated() {
        assumeTrue(Build.VERSION.SDK_INT >= 29)
        val first = insertFixture("EventBridgeA", 12.5, 34.5)
        insertFixture("EventBridgeB", 56.5, 67.5)
        assertEquals(
            PackageManager.PERMISSION_GRANTED,
            context.checkSelfPermission(android.Manifest.permission.READ_MEDIA_IMAGES),
        )
        assertEquals(
            PackageManager.PERMISSION_GRANTED,
            context.checkSelfPermission(android.Manifest.permission.ACCESS_MEDIA_LOCATION),
        )
        val firstRecord = source.records(null).single { it.id == first.toString() }
        val bucket = source.buckets().single { it.label == "EventBridgeA" }
        assertEquals(1, source.count(bucket.id))
        assertEquals(source.records(bucket.id).size, source.count(bucket.id))
        assertEquals(0, source.count("not-the-bucket"))
        assertTrue(source.totalCount() >= 2)
        assertEquals(listOf(first.toString()), source.records(bucket.id).map { it.id })
        val providerTime = context.contentResolver.query(
            MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
            arrayOf(
                MediaStore.Images.Media.DATE_TAKEN,
                MediaStore.Images.Media.DATE_ADDED,
                MediaStore.Images.Media.DATE_MODIFIED,
            ),
            "${MediaStore.Images.Media._ID} = ?",
            arrayOf(first.toString()),
            null,
        )?.use { cursor ->
            if (!cursor.moveToFirst()) 0L else {
                val taken = cursor.takeIf { !it.isNull(0) }?.getLong(0) ?: 0L
                val added = cursor.takeIf { !it.isNull(1) }?.getLong(1) ?: 0L
                val modified = cursor.takeIf { !it.isNull(2) }?.getLong(2) ?: 0L
                if (taken > 0) taken else if (added > 0) added * 1000 else modified * 1000
            }
        } ?: 0L
        assertTrue(providerTime > 0)
        assertEquals(providerTime / 1000.0, firstRecord.timestamp, 0.001)
        val withLocation = source.metadata(bucket.id, true) { null }[0]
        assertTrue(withLocation.toString(), withLocation.has("latitude"))
        assertEquals(12.5, withLocation.getDouble("latitude"), 0.001)
        assertEquals(34.5, withLocation.getDouble("longitude"), 0.001)
        val withoutLocation = source.metadata(bucket.id, false) { 12.5 to 34.5 }[0]
        assertFalse(withoutLocation.has("latitude"))
        assertFalse(withoutLocation.has("longitude"))
        assertNotNull(source.record(first.toString(), bucket.id))
        assertEquals(null, source.record(first.toString(), "not-the-bucket"))
    }

    @Test
    fun thumbnailsNeverUpscaleAndViewerLeavesAreByteForByte() {
        val file = File(context.cacheDir, "event-fixture-${UUID.randomUUID()}.jpg")
        val bitmap = Bitmap.createBitmap(80, 40, Bitmap.Config.ARGB_8888)
        file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.JPEG, 95, it) }
        bitmap.recycle()
        val bytes = file.readBytes()
        val record = MediaRecord("101", 1_700_000_000.0, null, null, false, file.lastModified() / 1000.0, file.absolutePath, "image/jpeg", file.name, 80, 40, bytes.size.toLong())
        val thumbnail = assets.request(listOf("101"), listOf(record), "thumbnail", 1000, false) { error("No network") }.getJSONObject(0)
        assertEquals("ready", thumbnail.getString("state"))
        assertEquals(80, thumbnail.getInt("width"))
        assertEquals(40, thumbnail.getInt("height"))
        assertTrue(thumbnail.getString("url").contains("/cache/event-thumbs/"))

        val original = assets.request(listOf("101"), listOf(record), "viewer", 1000, false) { error("No network") }.getJSONObject(0)
        assertEquals("ready", original.getString("state"))
        val lease = File(Uri.parse(original.getString("url")).path!!)
        assertTrue(bytes.contentEquals(lease.readBytes()))
        assertTrue(lease.setReadable(false, false))
        assertFalse(lease.canWrite())
        assets.release(listOf(original.getString("url")))
        assertFalse(lease.exists())
        assets.release(listOf(original.getString("url")))
        file.delete()
    }

    @Test
    fun cloudOnlyAndMissingAssetsNeverOpenAProviderImplicitly() {
        val cloud = MediaRecord("102", 1_700_000_000.0, null, null, false, null, null, "image/jpeg", "cloud.jpg", 100, 50, 50)
        val replies = assets.request(listOf("102", "103"), listOf(cloud, null), "thumbnail", 100, false) { error("No network") }
        assertEquals("cloudOnly", replies.getJSONObject(0).getString("state"))
        assertEquals("missing", replies.getJSONObject(1).getString("state"))
        assertTrue(replies.getJSONObject(0).isNull("url"))
        assertTrue(replies.getJSONObject(1).isNull("url"))
    }

    @Test
    fun assetFailuresAlwaysSettleReplies() {
        val record = localRecord("105", 8, 4)
        assets.close()
        assets = EventAssetService(context, source, beforeThumbnailInstall = {
            throw OutOfMemoryError("synthetic decode failure")
        }) { _, _ -> }
        val failed = assets.request(listOf(record.id), listOf(record), "thumbnail", 64, false) { error("No network") }.getJSONObject(0)
        assertEquals("failed", failed.getString("state"))
        assertTrue(failed.isNull("url"))

        assets.close()
        val rejected = assets.request(listOf(record.id), listOf(record), "thumbnail", 64, false) { error("No network") }.getJSONObject(0)
        assertEquals("failed", rejected.getString("state"))
        assertTrue(rejected.isNull("url"))
    }

    @Test
    fun clearPreventsALateThumbnailFromBeingInstalled() {
        assertLateThumbnailCannotInstall { service, id -> service.clear() }
    }

    @Test
    fun cancelPreventsALateThumbnailFromBeingInstalled() {
        assertLateThumbnailCannotInstall { service, id -> service.cancel(listOf(id)) }
    }

    @Test
    fun clearRejectsARequestQueuedBeforeThePurge() {
        val record = localRecord("109", 8, 4)
        val staleGeneration = assets.generation()
        assets.clear()
        val reply = assets.request(
            listOf(record.id), listOf(record), "thumbnail", 64, false,
            requestGeneration = staleGeneration,
        ) { error("No network") }.getJSONObject(0)
        assertEquals("failed", reply.getString("state"))
        assertTrue(reply.isNull("url"))
        assertTrue(File(context.cacheDir, "event-thumbs").listFiles().isNullOrEmpty())
    }

    @Test
    fun aVanishedBucketBecomesUnavailable() {
        assumeTrue(Build.VERSION.SDK_INT >= 29)
        val id = insertFixture("EventBridgeVanishing", 12.5, 34.5)
        val bucket = source.buckets().single { it.label == "EventBridgeVanishing" }
        assertEquals(1, source.count(bucket.id))
        assertEquals(
            1,
            context.contentResolver.delete(
                MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                "${MediaStore.Images.Media._ID} = ?",
                arrayOf(id.toString()),
            ),
        )
        assertEquals(0, source.count(bucket.id))
        assertTrue(source.records(bucket.id).isEmpty())
    }

    @Test
    fun jniHonorsAndroidGmtOffsetIdentifiers() {
        val items = org.json.JSONArray()
            .put(org.json.JSONObject().put("id", "home1").put("timestamp", 1_767_225_600.0).put("latitude", 18.5167).put("longitude", 73.8562).put("isScreenshot", false))
            .put(org.json.JSONObject().put("id", "home2").put("timestamp", 1_767_312_000.0).put("latitude", 18.5167).put("longitude", 73.8562).put("isScreenshot", false))
            .put(org.json.JSONObject().put("id", "away1").put("timestamp", 1_767_292_140.0).put("latitude", 20.2954).put("longitude", 73.9846).put("isScreenshot", false))
            .put(org.json.JSONObject().put("id", "away2").put("timestamp", 1_767_306_600.0).put("latitude", 20.2954).put("longitude", 73.9846).put("isScreenshot", false))
        val options = """{"sourceId":"mediastore-library","calendar":{"identifier":"gregorian","timeZoneIdentifier":"GMT+05:30"},"config":{}}"""
        val events = org.json.JSONObject(RustBridge.cluster(items.toString(), options)).getJSONArray("events")
        val event = (0 until events.length()).map { events.getJSONObject(it) }.single { it.optBoolean("isMultiDay") }
        val days = event.getJSONArray("subDays")
        assertEquals(2, days.length())
        assertEquals("2026-01-01", days.getJSONObject(0).getString("id"))
        assertEquals("2026-01-02", days.getJSONObject(1).getString("id"))
    }

    @Test
    fun supersededRequestCannotDeleteNewGenerationLease() {
        assets.close()
        val firstEntered = CountDownLatch(1)
        val secondEntered = CountDownLatch(1)
        val releaseFirst = CountDownLatch(1)
        val releaseSecond = CountDownLatch(1)
        val calls = AtomicInteger()
        assets = EventAssetService(context, source, afterCopyOpen = {
            when (calls.getAndIncrement()) {
                0 -> {
                    firstEntered.countDown()
                    awaitUninterruptibly(releaseFirst)
                }
                1 -> {
                    secondEntered.countDown()
                    awaitUninterruptibly(releaseSecond)
                }
            }
        }) { _, _ -> }
        val file = File(context.cacheDir, "event-race-${UUID.randomUUID()}.jpg")
        val bytes = ByteArray(4096) { it.toByte() }
        file.writeBytes(bytes)
        val record = MediaRecord("104", 1_700_000_000.0, null, null, false, file.lastModified() / 1000.0, file.absolutePath, "image/jpeg", file.name, 80, 40, bytes.size.toLong())
        val firstExecutor = Executors.newSingleThreadExecutor()
        val secondExecutor = Executors.newSingleThreadExecutor()
        try {
            val first = firstExecutor.submit<JSONObject> {
                assets.request(listOf(record.id), listOf(record), "viewer", 100, false) { error("No network") }.getJSONObject(0)
            }
            assertTrue(firstEntered.await(10, TimeUnit.SECONDS))
            val second = secondExecutor.submit<JSONObject> {
                assets.request(listOf(record.id), listOf(record), "viewer", 100, false) { error("No network") }.getJSONObject(0)
            }
            assertTrue(secondEntered.await(10, TimeUnit.SECONDS))
            releaseFirst.countDown()
            assertEquals("failed", first.get(10, TimeUnit.SECONDS).getString("state"))
            releaseSecond.countDown()
            val reply = second.get(10, TimeUnit.SECONDS)
            assertEquals("ready", reply.getString("state"))
            val lease = File(Uri.parse(reply.getString("url")).path!!)
            assertTrue(lease.isFile)
            assertTrue(bytes.contentEquals(lease.readBytes()))
            assets.release(listOf(reply.getString("url")))
        } finally {
            releaseFirst.countDown()
            releaseSecond.countDown()
            firstExecutor.shutdownNow()
            secondExecutor.shutdownNow()
            file.delete()
        }
    }

    private fun assertLateThumbnailCannotInstall(invalidate: (EventAssetService, String) -> Unit) {
        assets.close()
        assets.clear()
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val finished = CountDownLatch(1)
        assets = EventAssetService(context, source,
            beforeThumbnailInstall = {
                entered.countDown()
                awaitUninterruptibly(release)
            },
            afterThumbnailInstall = { finished.countDown() },
        ) { _, _ -> }
        val record = localRecord("108", 8, 4)
        val caller = Executors.newSingleThreadExecutor()
        try {
            val request = caller.submit<JSONObject> {
                assets.request(listOf(record.id), listOf(record), "thumbnail", 64, false) { error("No network") }.getJSONObject(0)
            }
            assertTrue(entered.await(10, TimeUnit.SECONDS))
            invalidate(assets, record.id)
            release.countDown()
            assertEquals("failed", request.get(10, TimeUnit.SECONDS).getString("state"))
            assertTrue(finished.await(10, TimeUnit.SECONDS))
            assertTrue(File(context.cacheDir, "event-thumbs").listFiles().isNullOrEmpty())
        } finally {
            release.countDown()
            caller.shutdownNow()
        }
    }

    private fun localRecord(id: String, width: Int, height: Int): MediaRecord {
        val file = File(context.cacheDir, "event-local-${UUID.randomUUID()}.jpg")
        fixtureFiles += file
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.JPEG, 95, it) }
        bitmap.recycle()
        val bytes = file.readBytes()
        return MediaRecord(id, 1_700_000_000.0, null, null, false, file.lastModified() / 1000.0, file.absolutePath, "image/jpeg", file.name, width, height, bytes.size.toLong())
    }

    private fun awaitUninterruptibly(latch: CountDownLatch) {
        while (true) {
            try {
                check(latch.await(10, TimeUnit.SECONDS))
                return
            } catch (_: InterruptedException) {
            }
        }
    }

    @Test
    fun jniClustersFiftyThousandItemsOffMainThreadWithinBudget() {
        assertTrue(Looper.myLooper() != Looper.getMainLooper())
        val items = org.json.JSONArray()
        repeat(50_000) { index ->
            items.put(org.json.JSONObject()
                .put("id", (index + 1).toString())
                .put("timestamp", 1_700_000_000.0 + index * 60.0)
                .put("isScreenshot", false))
        }
        val options = """{"sourceId":"mediastore-library","calendar":{"identifier":"gregorian","timeZoneIdentifier":"UTC"},"config":{}}"""
        val started = System.nanoTime()
        val result = org.json.JSONObject(RustBridge.cluster(items.toString(), options))
        val elapsedMillis = (System.nanoTime() - started) / 1_000_000
        assertTrue("50,000 items clustered in ${elapsedMillis}ms", elapsedMillis < 20_000)
        val events = result.getJSONArray("events")
        var clusteredItems = 0
        for (index in 0 until events.length()) clusteredItems += events.getJSONObject(index).getJSONArray("itemIds").length()
        assertEquals(50_000, clusteredItems)
    }

    @Test
    fun missingLocationStateIsUnknownRatherThanDenied() {
        val root = File(context.cacheDir, "event-state-${UUID.randomUUID()}")
        val directory = File(root, "EventClustering").apply { mkdirs() }
        val stateFile = File(directory, "source-state.json")
        val isolated = object : ContextWrapper(context) {
            override fun getFilesDir(): File = root
        }
        try {
            stateFile.writeText("""{"enabled":true}""")
            assertNull(EventStateStore(isolated).read().locationRead)
            stateFile.writeText("""{"enabled":true,"locationRead":false}""")
            assertEquals(false, EventStateStore(isolated).read().locationRead)
            stateFile.writeText("""{"enabled":true,"locationRead":null}""")
            assertNull(EventStateStore(isolated).read().locationRead)
        } finally {
            root.deleteRecursively()
        }
    }

    private fun insertFixture(bucket: String, latitude: Double, longitude: Double): Long {
        val name = "event-${UUID.randomUUID()}.jpg"
        val temporary = File(context.cacheDir, name)
        val bitmap = Bitmap.createBitmap(2, 1, Bitmap.Config.ARGB_8888)
        ByteArrayOutputStream().use { output ->
            bitmap.compress(Bitmap.CompressFormat.JPEG, 95, output)
            temporary.writeBytes(output.toByteArray())
        }
        bitmap.recycle()
        ExifInterface(temporary.absolutePath).apply {
            setLatLong(latitude, longitude)
            saveAttributes()
        }
        val values = ContentValues().apply {
            put(MediaStore.Images.Media.DISPLAY_NAME, name)
            put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg")
            put(MediaStore.Images.Media.DATE_TAKEN, 1_700_000_000_123L)
            put(MediaStore.Images.Media.WIDTH, 2)
            put(MediaStore.Images.Media.HEIGHT, 1)
            put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/$bucket/")
            if (Build.VERSION.SDK_INT >= 29) put(MediaStore.Images.Media.IS_PENDING, 1)
        }
        val uri = context.contentResolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)!!
        context.contentResolver.openOutputStream(uri)?.use { it.write(temporary.readBytes()) } ?: error("Could not write fixture")
        temporary.delete()
        val published = ContentValues().apply {
            put(MediaStore.Images.Media.DATE_TAKEN, 1_700_000_000_123L)
            if (Build.VERSION.SDK_INT >= 29) put(MediaStore.Images.Media.IS_PENDING, 0)
        }
        context.contentResolver.update(uri, published, null, null)
        val id = ContentUris.parseId(uri)
        inserted += id
        return id
    }
}
