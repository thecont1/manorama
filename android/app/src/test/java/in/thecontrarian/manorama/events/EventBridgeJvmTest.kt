package `in`.thecontrarian.manorama.events

import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.util.concurrent.Executor
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class EventBridgeJvmTest {
    @get:Rule
    val temporary = TemporaryFolder()

    @Test
    fun jniClustersMetadataAndRejectsOversizedIdentifiers() {
        val items = """[
          {"id":"101","timestamp":1700000000,"isScreenshot":false},
          {"id":"102","timestamp":1700003600,"isScreenshot":false},
          {"id":"103","timestamp":1700007200,"isScreenshot":true}
        ]"""
        val options = """{"sourceId":"mediastore-library","calendar":{"identifier":"gregorian","timeZoneIdentifier":"UTC"},"config":{}}"""
        val result = RustBridge.cluster(items, options)
        assertTrue(result.contains("\"events\""))
        assertTrue(result.contains("\"101\""))
        assertTrue(result.contains("\"102\""))
        assertTrue(result.contains("\"screenshotItemIds\":[\"103\"]"))
        try {
            RustBridge.cluster("""[{"id":"${"x".repeat(4097)}","timestamp":1700000000,"isScreenshot":false}]""", options)
            fail("Oversized identifiers must be rejected")
        } catch (error: IllegalArgumentException) {
            assertTrue(error.message.orEmpty().contains("INVALID_INPUT"))
        }
    }

    @Test
    fun jniIndexRoundTripPreservesSchemaAndRejectsUnknownVersions() {
        val config = """{"sessionGapHours":3.5,"sessionDistanceKm":5,"transitBypassMinutes":45,"tripDistanceFromHomeKm":50,"tripOvernightGapHours":18,"burstThresholdSeconds":3,"visualSplitMinGapHours":1.5,"visualSplitMaxDistanceKm":0.5,"visualSplitFeaturePrintDistance":1}"""
        val index = """{"schemaVersion":1,"source":{"deviceId":"device","sourceId":"source","sourceKind":"folder","label":"Camera Roll","lastIndexedAt":1700000000},"config":$config,"itemCache":{},"events":[],"screenshotItemIds":[]}"""
        val encoded = RustBridge.encodeIndex(index)
        assertEquals(encoded, RustBridge.decodeIndex(index))
        assertTrue(encoded.contains("\"sourceId\":\"source\""))
        try {
            RustBridge.decodeIndex(index.replace("\"schemaVersion\":1", "\"schemaVersion\":2"))
            fail("Unknown index schemas must request a rebuild")
        } catch (error: IllegalArgumentException) {
            assertTrue(error.message.orEmpty().contains("INVALID_INPUT"))
        }
    }

    @Test
    fun mediaStoreIdsStayOpaqueNumericValues() {
        for (id in listOf("1", "9223372036854775807")) assertTrue(MediaStoreSource.isMediaStoreId(id))
        for (id in listOf("", "0", "01", "-1", "+1", "1.0", "content://media/1", "../1", "١", "9223372036854775808", "9999999999999999999")) assertFalse(MediaStoreSource.isMediaStoreId(id))
    }

    @Test
    fun vanishedBucketsAreNotReportedAsReachable() {
        val folder = EventSourceState(enabled = true, bucketId = "bucket")
        assertFalse(eventSourceReachable(folder, true) { 0 })
        assertTrue(eventSourceReachable(folder, true) { 1 })
        assertFalse(eventSourceReachable(folder, false) { 1 })
        assertTrue(eventSourceReachable(EventSourceState(enabled = true), true) { 0 })
    }

    @Test
    fun workerFailuresAlwaysRejectExactlyOnce() {
        val failures = mutableListOf<String>()
        val direct = Executor { action -> action.run() }
        submitSettled(direct, { failures += it }, "disk write failed") { throw IOException("disk full") }
        submitSettled(direct, { failures += it }, "decode failed") { throw OutOfMemoryError("synthetic decode failure") }
        assertEquals(listOf("disk write failed", "decode failed"), failures)

        val completed = AtomicInteger()
        submitSettled(direct, { failures += it }, "unexpected") { completed.incrementAndGet() }
        assertEquals(1, completed.get())

        val stopped = Executors.newSingleThreadExecutor().apply { shutdown() }
        submitSettled(stopped, { failures += it }, "unexpected") { completed.incrementAndGet() }
        assertEquals("The Camera Roll service is no longer available", failures.last())
        assertEquals(3, failures.size)
        assertEquals(1, completed.get())
    }

    @Test
    fun privateWritesAreAtomicAndThumbnailKeysAreStable() {
        val target = File(temporary.root, "state.json")
        EventPrivateFiles.writeAtomic(target, "first".toByteArray())
        EventPrivateFiles.writeAtomic(target, "second".toByteArray())
        assertEquals("second", Files.readAllBytes(target.toPath()).decodeToString())
        assertEquals(0, target.parentFile!!.listFiles()!!.count { it.name.startsWith(".state.json.") })
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", EventPrivateFiles.sha256("abc"))
    }
}
