package `in`.thecontrarian.manorama.events

object RustBridge {
    init {
        System.loadLibrary("manorama_events")
    }

    @JvmStatic
    external fun cluster(itemsJson: String, configJson: String): String

    @JvmStatic
    external fun decodeIndex(indexJson: String): String

    @JvmStatic
    external fun encodeIndex(indexJson: String): String
}
