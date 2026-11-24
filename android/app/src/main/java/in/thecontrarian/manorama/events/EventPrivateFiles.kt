package `in`.thecontrarian.manorama.events

import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest

internal object EventPrivateFiles {
    fun directory(path: File): File {
        if (!path.exists() && !path.mkdirs()) error("Could not create private event storage")
        path.setReadable(false, false)
        path.setWritable(false, false)
        path.setReadable(true, true)
        path.setWritable(true, true)
        path.setExecutable(true, true)
        return path
    }

    fun writeAtomic(target: File, bytes: ByteArray) {
        directory(target.parentFile ?: error("Private event file has no parent"))
        val staging = File(target.parentFile, ".${target.name}.${System.nanoTime()}.tmp")
        try {
            FileOutputStream(staging).use { output ->
                output.write(bytes)
                output.flush()
                output.fd.sync()
            }
            staging.setReadable(false, false)
            staging.setWritable(false, false)
            staging.setReadable(true, true)
            staging.setWritable(true, true)
            if (!staging.renameTo(target)) error("Could not replace private event state")
        } finally {
            staging.delete()
        }
    }

    fun deleteTree(path: File) {
        path.walkBottomUp().forEach { it.delete() }
    }

    fun sha256(value: String): String =
        MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
}
