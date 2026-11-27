package com.velodeck.agent.transfer

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.provider.Settings
import android.util.Log
import androidx.core.content.FileProvider
import com.velodeck.agent.input.VeloDeckAccessibilityService
import com.velodeck.agent.service.PowerHelper
import org.json.JSONObject
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.net.URLConnection
import java.security.MessageDigest
import java.util.concurrent.Executors

/**
 * Pure JVM-testable validation, sanitization, and binary helpers for P2P file transfer and OTA APK install.
 */
object FileTransferUtils {
    const val PURPOSE_FILE = "file"
    const val PURPOSE_APK_INSTALL = "apk_install"

    const val MAX_FILE_BYTES: Long = 256L * 1024L * 1024L
    const val MAX_APK_BYTES: Long = 128L * 1024L * 1024L
    const val MAX_FILE_NAME_LENGTH = 120
    const val PROGRESS_INTERVAL_BYTES: Long = 262_144L
    const val PROGRESS_INTERVAL_MS: Long = 250L

    private const val DEFAULT_APK_FILE_NAME = "velodeck-update.apk"
    private const val DEFAULT_FILE_NAME = "received_file"
    private val HEX_CHARS = "0123456789abcdef".toCharArray()

    fun sanitizeFileName(raw: String?, purpose: String): String {
        val fallback = if (purpose == PURPOSE_APK_INSTALL) {
            DEFAULT_APK_FILE_NAME
        } else {
            DEFAULT_FILE_NAME
        }
        if (raw.isNullOrBlank()) return fallback

        // Strip NUL and ASCII control characters (0x00..0x1F, 0x7F)
        val noControl = buildString(raw.length) {
            for (ch in raw) {
                if (ch.code >= 0x20 && ch.code != 0x7F) {
                    append(ch)
                }
            }
        }

        // Keep only the final path segment across both Unix and Windows separators
        var cleaned = noControl
            .substringAfterLast('/')
            .substringAfterLast('\\')
            .replace("/", "")
            .replace("\\", "")

        // Collapse any ".." traversal sequences
        while (cleaned.contains("..")) {
            cleaned = cleaned.replace("..", ".")
        }

        // Strip leading/trailing whitespace and dots
        cleaned = cleaned.trim { it <= ' ' || it == '.' }
        while (cleaned.startsWith(".") || cleaned.startsWith(" ")) {
            cleaned = cleaned.trimStart('.', ' ')
        }
        while (cleaned.endsWith(".") || cleaned.endsWith(" ")) {
            cleaned = cleaned.trimEnd('.', ' ')
        }

        if (cleaned.isEmpty()) return fallback

        // Cap length at 120 chars while preserving extension
        if (cleaned.length > MAX_FILE_NAME_LENGTH) {
            val lastDot = cleaned.lastIndexOf('.')
            if (lastDot > 0 && lastDot < cleaned.length - 1) {
                val ext = cleaned.substring(lastDot)
                if (ext.length in 2..20) {
                    val stemBudget = (MAX_FILE_NAME_LENGTH - ext.length).coerceAtLeast(1)
                    val stem = cleaned.substring(0, stemBudget).trimEnd('.', ' ')
                    cleaned = if (stem.isNotEmpty()) {
                        stem + ext
                    } else {
                        "file$ext"
                    }
                } else {
                    cleaned = cleaned.take(MAX_FILE_NAME_LENGTH).trimEnd('.', ' ')
                }
            } else {
                cleaned = cleaned.take(MAX_FILE_NAME_LENGTH).trimEnd('.', ' ')
            }
        }

        if (cleaned.isEmpty() || cleaned == "." || cleaned == "..") return fallback
        return cleaned
    }

    fun validateOffer(
        transferId: String?,
        fileName: String?,
        size: Long,
        purpose: String?,
    ): String? {
        if (transferId.isNullOrBlank()) {
            return "缺少有效的传输 ID"
        }
        if (transferId.length > 128) {
            return "传输 ID 过长"
        }
        if (purpose != PURPOSE_FILE && purpose != PURPOSE_APK_INSTALL) {
            return "不支持的传输用途: ${purpose.orEmpty()}"
        }
        if (fileName.isNullOrBlank()) {
            return "缺少有效的文件名"
        }
        if (size <= 0L) {
            return "文件大小无效"
        }
        val maxBytes = if (purpose == PURPOSE_APK_INSTALL) MAX_APK_BYTES else MAX_FILE_BYTES
        if (size > maxBytes) {
            val maxMb = maxBytes / (1024L * 1024L)
            return "文件大小超过限制（最大 $maxMb MB）"
        }
        return null
    }

    fun normalizeSha256(raw: String?): String? {
        val trimmed = raw?.trim()?.lowercase() ?: return null
        if (trimmed.length != 64) return null
        for (ch in trimmed) {
            val isHex = (ch in '0'..'9') || (ch in 'a'..'f')
            if (!isHex) return null
        }
        return trimmed
    }

    fun isZipMagic(bytes: ByteArray): Boolean {
        if (bytes.size < 4) return false
        if (bytes[0] != 0x50.toByte() || bytes[1] != 0x4B.toByte()) return false
        val b2 = bytes[2]
        val b3 = bytes[3]
        return (b2 == 0x03.toByte() && b3 == 0x04.toByte()) ||
            (b2 == 0x05.toByte() && b3 == 0x06.toByte()) ||
            (b2 == 0x07.toByte() && b3 == 0x08.toByte())
    }

    fun bytesToHex(bytes: ByteArray): String {
        val out = CharArray(bytes.size * 2)
        for (i in bytes.indices) {
            val v = bytes[i].toInt() and 0xFF
            out[i * 2] = HEX_CHARS[v ushr 4]
            out[i * 2 + 1] = HEX_CHARS[v and 0x0F]
        }
        return String(out)
    }
}

/**
 * Handles P2P file transfer and one-click OTA APK upgrade over the dedicated WebRTC `"file"` DataChannel.
 *
 * All disk IO and streaming SHA-256 computation execute sequentially on a single dedicated background
 * thread ([ioExecutor]) so libwebrtc signaling and `rtcExecutor` are never blocked.
 */
class FileTransferManager(context: Context) {

    private class ActiveTransfer(
        val sessionId: String,
        val transferId: String,
        val sanitizedName: String,
        val expectedSize: Long,
        val mimeType: String,
        val purpose: String,
        val expectedSha256: String?,
        val tempFile: File,
        val outputStream: BufferedOutputStream,
        val digest: MessageDigest,
        var receivedBytes: Long = 0L,
        var lastProgressBytes: Long = 0L,
        var lastProgressElapsedMs: Long = 0L,
    )

    private val appContext = context.applicationContext
    private val ioExecutor = Executors.newSingleThreadExecutor { r ->
        Thread(r, "VeloDeckFileTransfer").apply { isDaemon = true }
    }

    // Accessed exclusively on ioExecutor
    private var activeTransfer: ActiveTransfer? = null

    fun handleTextMessage(sessionId: String, text: String, reply: (String) -> Boolean) {
        if (ioExecutor.isShutdown) return
        try {
            ioExecutor.execute {
                handleTextMessageOnIo(sessionId, text, reply)
            }
        } catch (t: Throwable) {
            Log.w(TAG, "Failed to enqueue file control message", t)
        }
    }

    fun handleBinaryChunk(sessionId: String, chunk: ByteArray, reply: (String) -> Boolean) {
        if (ioExecutor.isShutdown) return
        try {
            ioExecutor.execute {
                handleBinaryChunkOnIo(sessionId, chunk, reply)
            }
        } catch (t: Throwable) {
            Log.w(TAG, "Failed to enqueue file binary chunk", t)
        }
    }

    fun abortSession(sessionId: String) {
        if (ioExecutor.isShutdown) return
        try {
            ioExecutor.execute {
                val transfer = activeTransfer
                if (transfer != null && transfer.sessionId == sessionId) {
                    Log.i(TAG, "Aborting active transfer ${transfer.transferId} for closed session=$sessionId")
                    cleanupActiveTransfer()
                }
            }
        } catch (_: Throwable) {
        }
    }

    fun shutdown() {
        if (ioExecutor.isShutdown) return
        try {
            ioExecutor.execute {
                cleanupActiveTransfer()
            }
        } catch (_: Throwable) {
        } finally {
            ioExecutor.shutdown()
        }
    }

    private fun handleTextMessageOnIo(sessionId: String, text: String, reply: (String) -> Boolean) {
        val json = try {
            JSONObject(text)
        } catch (t: Throwable) {
            Log.w(TAG, "Invalid JSON on file channel", t)
            sendError(reply, "", "无效的文件传输消息格式")
            return
        }

        when (val type = json.optString("type", "")) {
            "file.offer" -> handleOfferOnIo(sessionId, json, reply)
            "file.complete" -> handleCompleteOnIo(sessionId, json, reply)
            "file.cancel" -> handleCancelOnIo(sessionId, json)
            else -> Log.w(TAG, "Ignoring unknown file channel message type: $type")
        }
    }

    private fun handleOfferOnIo(sessionId: String, json: JSONObject, reply: (String) -> Boolean) {
        cleanupActiveTransfer()

        val transferId = json.optString("transferId", "").trim()
        val rawFileName = optNullableString(json, "fileName")
        val size = json.optLong("size", -1L)
        val purpose = json.optString("purpose", FileTransferUtils.PURPOSE_FILE).trim()
        val rawMimeType = optNullableString(json, "mimeType")?.trim().orEmpty()
        val rawSha256 = optNullableString(json, "sha256")

        val validationError = FileTransferUtils.validateOffer(transferId, rawFileName, size, purpose)
        if (validationError != null) {
            sendError(reply, transferId, validationError)
            return
        }

        val expectedSha256 = if (!rawSha256.isNullOrBlank()) {
            FileTransferUtils.normalizeSha256(rawSha256) ?: run {
                sendError(reply, transferId, "无效的 SHA-256 校验值")
                return
            }
        } else {
            null
        }

        val sanitizedName = FileTransferUtils.sanitizeFileName(rawFileName, purpose)
        val effectiveMimeType = resolveMimeType(rawMimeType, sanitizedName, purpose)
        val safeId = transferId.replace(Regex("[^A-Za-z0-9_-]"), "_").take(48).ifEmpty { "transfer" }

        try {
            val otaDir = File(appContext.cacheDir, OTA_DIR_NAME).apply { mkdirs() }
            sweepOrphanedTempFiles(otaDir)
            val tempFile = File(otaDir, "incoming_${safeId}.tmp")
            if (tempFile.exists()) {
                tempFile.delete()
            }
            val outputStream = BufferedOutputStream(FileOutputStream(tempFile), IO_BUFFER_BYTES)
            val digest = MessageDigest.getInstance("SHA-256")
            activeTransfer = ActiveTransfer(
                sessionId = sessionId,
                transferId = transferId,
                sanitizedName = sanitizedName,
                expectedSize = size,
                mimeType = effectiveMimeType,
                purpose = purpose,
                expectedSha256 = expectedSha256,
                tempFile = tempFile,
                outputStream = outputStream,
                digest = digest,
                lastProgressElapsedMs = monotonicMs(),
            )
            Log.i(
                TAG,
                "Accepted file.offer transferId=$transferId purpose=$purpose name=$sanitizedName size=$size",
            )
            sendAccept(reply, transferId)
        } catch (t: Throwable) {
            Log.e(TAG, "Failed to initialize temp file for transferId=$transferId", t)
            cleanupActiveTransfer()
            sendError(reply, transferId, "无法创建临时文件: ${t.message ?: t.javaClass.simpleName}")
        }
    }

    private fun handleBinaryChunkOnIo(sessionId: String, chunk: ByteArray, reply: (String) -> Boolean) {
        val transfer = activeTransfer ?: return
        if (transfer.sessionId != sessionId) return
        if (chunk.isEmpty()) return

        val nextTotal = transfer.receivedBytes + chunk.size.toLong()
        if (nextTotal > transfer.expectedSize) {
            val tid = transfer.transferId
            Log.w(TAG, "Transfer $tid exceeded expected size (${nextTotal} > ${transfer.expectedSize})")
            cleanupActiveTransfer()
            sendError(reply, tid, "接收字节数超出声明大小，传输已中止")
            return
        }

        try {
            transfer.outputStream.write(chunk)
            transfer.digest.update(chunk)
            transfer.receivedBytes = nextTotal

            val nowMs = monotonicMs()
            val bytesSinceLast = transfer.receivedBytes - transfer.lastProgressBytes
            val msSinceLast = nowMs - transfer.lastProgressElapsedMs
            if (bytesSinceLast >= FileTransferUtils.PROGRESS_INTERVAL_BYTES ||
                msSinceLast >= FileTransferUtils.PROGRESS_INTERVAL_MS ||
                transfer.receivedBytes == transfer.expectedSize
            ) {
                transfer.lastProgressBytes = transfer.receivedBytes
                transfer.lastProgressElapsedMs = nowMs
                sendProgress(reply, transfer.transferId, transfer.receivedBytes, transfer.expectedSize)
            }
        } catch (t: Throwable) {
            val tid = transfer.transferId
            Log.e(TAG, "Failed to write chunk for transferId=$tid", t)
            cleanupActiveTransfer()
            sendError(reply, tid, "写入临时文件失败: ${t.message ?: t.javaClass.simpleName}")
        }
    }

    private fun handleCompleteOnIo(sessionId: String, json: JSONObject, reply: (String) -> Boolean) {
        val transferId = json.optString("transferId", "").trim()
        val completeRawSha = optNullableString(json, "sha256")
        val transfer = activeTransfer

        if (transfer == null ||
            transfer.sessionId != sessionId ||
            (transferId.isNotEmpty() && transfer.transferId != transferId)
        ) {
            sendError(reply, transferId, "未找到对应的活跃传输任务")
            return
        }

        activeTransfer = null
        try {
            transfer.outputStream.flush()
            transfer.outputStream.close()
        } catch (t: Throwable) {
            Log.e(TAG, "Failed to flush/close temp file for transferId=${transfer.transferId}", t)
            deleteQuietly(transfer.tempFile)
            sendError(reply, transfer.transferId, "保存临时文件失败: ${t.message ?: t.javaClass.simpleName}")
            return
        }

        if (transfer.receivedBytes != transfer.expectedSize) {
            deleteQuietly(transfer.tempFile)
            sendError(
                reply,
                transfer.transferId,
                "文件接收不完整（已接收 ${transfer.receivedBytes} / ${transfer.expectedSize} 字节）",
            )
            return
        }

        val completeSha = if (!completeRawSha.isNullOrBlank()) {
            FileTransferUtils.normalizeSha256(completeRawSha) ?: run {
                deleteQuietly(transfer.tempFile)
                sendError(reply, transfer.transferId, "无效的 SHA-256 校验值")
                return
            }
        } else {
            null
        }

        if (transfer.expectedSha256 != null && completeSha != null && transfer.expectedSha256 != completeSha) {
            deleteQuietly(transfer.tempFile)
            sendError(reply, transfer.transferId, "SHA-256 校验失败，文件已丢弃")
            return
        }

        val expectedSha = completeSha ?: transfer.expectedSha256
        val actualSha256 = FileTransferUtils.bytesToHex(transfer.digest.digest())
        if (expectedSha != null && actualSha256 != expectedSha) {
            Log.w(TAG, "SHA-256 mismatch for ${transfer.transferId}: expected=$expectedSha actual=$actualSha256")
            deleteQuietly(transfer.tempFile)
            sendError(reply, transfer.transferId, "SHA-256 校验失败，文件已丢弃")
            return
        }

        if (transfer.purpose == FileTransferUtils.PURPOSE_APK_INSTALL) {
            finalizeApkInstall(transfer, actualSha256, reply)
        } else {
            finalizeGeneralFile(transfer, actualSha256, reply)
        }
    }

    private fun handleCancelOnIo(sessionId: String, json: JSONObject) {
        val transferId = json.optString("transferId", "").trim()
        val reason = json.optString("reason", "")
        val transfer = activeTransfer ?: return
        if (transfer.sessionId != sessionId) return
        if (transferId.isNotEmpty() && transfer.transferId != transferId) return
        Log.i(TAG, "Transfer ${transfer.transferId} cancelled by controller (reason=$reason)")
        cleanupActiveTransfer()
    }

    private fun finalizeApkInstall(
        transfer: ActiveTransfer,
        actualSha256: String,
        reply: (String) -> Boolean,
    ) {
        val header = ByteArray(4)
        val headerRead = try {
            FileInputStream(transfer.tempFile).use { it.read(header) }
        } catch (t: Throwable) {
            Log.e(TAG, "Failed to read APK header", t)
            -1
        }
        if (headerRead < 4 || !FileTransferUtils.isZipMagic(header)) {
            deleteQuietly(transfer.tempFile)
            sendError(reply, transfer.transferId, "无效的 APK 文件格式（ZIP 头校验失败），文件已丢弃")
            return
        }

        val apkFile = File(File(appContext.cacheDir, OTA_DIR_NAME).apply { mkdirs() }, OTA_APK_FILE_NAME)
        try {
            moveOrCopyOverwrite(transfer.tempFile, apkFile)
        } catch (t: Throwable) {
            Log.e(TAG, "Failed to stage OTA APK file", t)
            deleteQuietly(transfer.tempFile)
            sendError(reply, transfer.transferId, "准备安装包失败: ${t.message ?: t.javaClass.simpleName}")
            return
        }

        if (!PowerHelper.isScreenOn(appContext)) {
            PowerHelper.wakeScreen(appContext)
        }

        val canInstall = try {
            appContext.packageManager.canRequestPackageInstalls()
        } catch (t: Throwable) {
            Log.w(TAG, "canRequestPackageInstalls check failed", t)
            false
        }

        if (canInstall) {
            try {
                val apkUri = FileProvider.getUriForFile(
                    appContext,
                    "${appContext.packageName}.fileprovider",
                    apkFile,
                )
                val installIntent = Intent(Intent.ACTION_VIEW).apply {
                    setDataAndType(apkUri, MIME_APK)
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
                startActivitySafely(installIntent)
                Log.i(TAG, "Launched system APK installer for transferId=${transfer.transferId}")
                sendDone(
                    reply = reply,
                    transferId = transfer.transferId,
                    savedPath = OTA_APK_SAVED_PATH,
                    sha256 = actualSha256,
                    installLaunched = true,
                    needsInstallPermission = false,
                    message = "APK 校验通过，已在手机拉起系统安装界面",
                )
            } catch (t: Throwable) {
                Log.e(TAG, "Failed to launch system APK installer", t)
                sendError(
                    reply,
                    transfer.transferId,
                    "APK 校验通过，但无法拉起系统安装界面: ${t.message ?: t.javaClass.simpleName}",
                )
            }
        } else {
            val settingsIntent = Intent(
                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:${appContext.packageName}"),
            ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            val openedSettings = try {
                startActivitySafely(settingsIntent)
                true
            } catch (t: Throwable) {
                Log.w(TAG, "Failed to open unknown app sources settings", t)
                false
            }
            val msg = if (openedSettings) {
                "已打开「允许安装未知应用」权限页，开启后请再次点击安装"
            } else {
                "请在系统设置中开启「允许安装未知应用」权限后再次点击安装"
            }
            sendDone(
                reply = reply,
                transferId = transfer.transferId,
                savedPath = OTA_APK_SAVED_PATH,
                sha256 = actualSha256,
                installLaunched = false,
                needsInstallPermission = true,
                message = msg,
            )
        }
    }

    private fun finalizeGeneralFile(
        transfer: ActiveTransfer,
        actualSha256: String,
        reply: (String) -> Boolean,
    ) {
        try {
            val savedPath = saveToDownloads(transfer.tempFile, transfer.sanitizedName, transfer.mimeType)
            Log.i(TAG, "Saved received file transferId=${transfer.transferId} path=$savedPath")
            sendDone(
                reply = reply,
                transferId = transfer.transferId,
                savedPath = savedPath,
                sha256 = actualSha256,
                installLaunched = false,
                needsInstallPermission = false,
                message = "已保存到手机 $savedPath",
            )
        } catch (t: Throwable) {
            Log.e(TAG, "Failed to save received file transferId=${transfer.transferId}", t)
            deleteQuietly(transfer.tempFile)
            sendError(reply, transfer.transferId, "保存文件失败: ${t.message ?: t.javaClass.simpleName}")
        }
    }

    private fun saveToDownloads(tempFile: File, sanitizedName: String, mimeType: String): String {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            try {
                val resolver = appContext.contentResolver
                val values = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, sanitizedName)
                    put(MediaStore.Downloads.MIME_TYPE, mimeType)
                    put(MediaStore.Downloads.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/VeloDeck")
                    put(MediaStore.Downloads.IS_PENDING, 1)
                }
                val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                if (uri != null) {
                    try {
                        val out = resolver.openOutputStream(uri)
                            ?: throw IllegalStateException("openOutputStream returned null")
                        out.use { outputStream ->
                            FileInputStream(tempFile).use { inputStream ->
                                inputStream.copyTo(outputStream, bufferSize = IO_BUFFER_BYTES)
                            }
                        }
                        val publishValues = ContentValues().apply {
                            put(MediaStore.Downloads.IS_PENDING, 0)
                        }
                        resolver.update(uri, publishValues, null, null)
                        val actualDisplayName = queryDisplayName(uri) ?: sanitizedName
                        deleteQuietly(tempFile)
                        return "Download/VeloDeck/$actualDisplayName"
                    } catch (t: Throwable) {
                        try {
                            resolver.delete(uri, null, null)
                        } catch (_: Throwable) {
                        }
                        throw t
                    }
                }
            } catch (t: Throwable) {
                Log.w(TAG, "MediaStore Downloads write failed; falling back to app external Downloads", t)
            }
        }

        val fallbackRoot = appContext.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS)
            ?: File(appContext.filesDir, Environment.DIRECTORY_DOWNLOADS)
        val targetDir = File(fallbackRoot, "VeloDeck").apply { mkdirs() }
        val destFile = resolveUniqueFile(targetDir, sanitizedName)
        moveOrCopyOverwrite(tempFile, destFile)
        return "Download/VeloDeck/${destFile.name}"
    }

    private fun queryDisplayName(uri: Uri): String? {
        return try {
            appContext.contentResolver.query(
                uri,
                arrayOf(MediaStore.MediaColumns.DISPLAY_NAME),
                null,
                null,
                null,
            )?.use { cursor ->
                if (cursor.moveToFirst()) {
                    cursor.getString(0)?.takeIf { it.isNotBlank() }
                } else {
                    null
                }
            }
        } catch (_: Throwable) {
            null
        }
    }

    private fun resolveUniqueFile(dir: File, fileName: String): File {
        var candidate = File(dir, fileName)
        if (!candidate.exists()) return candidate

        val lastDot = fileName.lastIndexOf('.')
        val (stem, ext) = if (lastDot > 0 && lastDot < fileName.length - 1) {
            fileName.substring(0, lastDot) to fileName.substring(lastDot)
        } else {
            fileName to ""
        }
        for (i in 1..999) {
            candidate = File(dir, "$stem ($i)$ext")
            if (!candidate.exists()) return candidate
        }
        return File(dir, "${stem}_${System.currentTimeMillis()}$ext")
    }

    private fun moveOrCopyOverwrite(src: File, dst: File) {
        if (dst.exists()) {
            dst.delete()
        }
        if (src.renameTo(dst)) {
            return
        }
        FileInputStream(src).use { input ->
            FileOutputStream(dst).use { output ->
                input.copyTo(output, bufferSize = IO_BUFFER_BYTES)
            }
        }
        deleteQuietly(src)
    }

    private fun startActivitySafely(intent: Intent) {
        val a11yContext = VeloDeckAccessibilityService.instance
        val launchContext: Context = a11yContext ?: appContext
        try {
            launchContext.startActivity(intent)
        } catch (t: Throwable) {
            if (a11yContext != null && a11yContext !== appContext) {
                appContext.startActivity(intent)
            } else {
                throw t
            }
        }
    }

    private fun resolveMimeType(rawMimeType: String, sanitizedName: String, purpose: String): String {
        if (rawMimeType.isNotBlank()) return rawMimeType
        if (purpose == FileTransferUtils.PURPOSE_APK_INSTALL || sanitizedName.endsWith(".apk", ignoreCase = true)) {
            return MIME_APK
        }
        return URLConnection.guessContentTypeFromName(sanitizedName) ?: "application/octet-stream"
    }

    private fun sweepOrphanedTempFiles(otaDir: File) {
        try {
            otaDir.listFiles()?.forEach { file ->
                if (file.isFile && file.name.startsWith("incoming_") && file.name.endsWith(".tmp")) {
                    file.delete()
                }
            }
        } catch (_: Throwable) {
        }
    }

    private fun cleanupActiveTransfer() {
        val transfer = activeTransfer ?: return
        activeTransfer = null
        try {
            transfer.outputStream.close()
        } catch (_: Throwable) {
        }
        deleteQuietly(transfer.tempFile)
    }

    private fun deleteQuietly(file: File) {
        try {
            if (file.exists()) {
                file.delete()
            }
        } catch (_: Throwable) {
        }
    }

    private fun sendAccept(reply: (String) -> Boolean, transferId: String) {
        val payload = JSONObject().apply {
            put("type", "file.accept")
            put("transferId", transferId)
        }.toString()
        reply(payload)
    }

    private fun sendProgress(
        reply: (String) -> Boolean,
        transferId: String,
        receivedBytes: Long,
        totalBytes: Long,
    ) {
        val payload = JSONObject().apply {
            put("type", "file.progress")
            put("transferId", transferId)
            put("receivedBytes", receivedBytes)
            put("totalBytes", totalBytes)
        }.toString()
        reply(payload)
    }

    private fun sendDone(
        reply: (String) -> Boolean,
        transferId: String,
        savedPath: String,
        sha256: String,
        installLaunched: Boolean,
        needsInstallPermission: Boolean,
        message: String,
    ) {
        val payload = JSONObject().apply {
            put("type", "file.done")
            put("transferId", transferId)
            put("savedPath", savedPath)
            put("sha256", sha256)
            put("installLaunched", installLaunched)
            put("needsInstallPermission", needsInstallPermission)
            put("message", message)
        }.toString()
        reply(payload)
    }

    private fun sendError(reply: (String) -> Boolean, transferId: String, error: String) {
        val payload = JSONObject().apply {
            put("type", "file.error")
            put("transferId", transferId)
            put("error", error)
        }.toString()
        reply(payload)
    }

    private fun optNullableString(json: JSONObject, key: String): String? =
        if (json.has(key) && !json.isNull(key)) json.optString(key) else null

    private fun monotonicMs(): Long = System.nanoTime() / 1_000_000L

    companion object {
        private const val TAG = "FileTransferManager"
        private const val OTA_DIR_NAME = "ota"
        private const val OTA_APK_FILE_NAME = "velodeck-update.apk"
        private const val OTA_APK_SAVED_PATH = "cache/ota/velodeck-update.apk"
        private const val MIME_APK = "application/vnd.android.package-archive"
        private const val IO_BUFFER_BYTES = 64 * 1024
    }
}
