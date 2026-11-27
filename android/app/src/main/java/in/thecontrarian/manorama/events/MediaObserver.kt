package `in`.thecontrarian.manorama.events

import android.content.ContentResolver
import android.database.ContentObserver
import android.net.Uri
import android.os.Handler
import android.os.Looper

internal class MediaObserver(
    private val resolver: ContentResolver,
    private val uri: Uri,
    private val changed: () -> Unit,
) {
    private val handler = Handler(Looper.getMainLooper())
    private var registered = false
    // Deliveries already posted to the main looper survive unregistering, so
    // a teardown flag — not just callback removal — decides whether a stale
    // delivery may still schedule work.
    @Volatile
    private var active = false
    private val observer = object : ContentObserver(handler) {
        override fun onChange(selfChange: Boolean) = schedule()

        override fun onChange(selfChange: Boolean, uri: Uri?) = schedule()

        private fun schedule() {
            if (!active) return
            handler.removeCallbacks(notify)
            handler.postDelayed(notify, 500)
        }
    }
    private val notify = Runnable {
        if (active) changed()
    }

    fun start() {
        active = true
        if (!registered) {
            resolver.registerContentObserver(uri, true, observer)
            registered = true
        }
    }

    fun stop() {
        active = false
        if (registered) {
            resolver.unregisterContentObserver(observer)
            registered = false
        }
        handler.removeCallbacks(notify)
    }
}
