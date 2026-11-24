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
    private val observer = object : ContentObserver(handler) {
        override fun onChange(selfChange: Boolean) = schedule()

        override fun onChange(selfChange: Boolean, uri: Uri?) = schedule()

        private fun schedule() {
            handler.removeCallbacks(notify)
            handler.postDelayed(notify, 500)
        }
    }
    private val notify = Runnable { changed() }

    fun start() {
        if (!registered) {
            resolver.registerContentObserver(uri, true, observer)
            registered = true
        }
    }

    fun stop() {
        if (registered) {
            resolver.unregisterContentObserver(observer)
            registered = false
        }
        handler.removeCallbacks(notify)
    }
}
