package com.velodeck.agent.service

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import com.velodeck.agent.BuildConfig
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.util.Locale
import java.util.concurrent.TimeUnit

data class RemoteUpdateInfo(
    val version: String,
    val hasAndroidApk: Boolean,
    val apkSha256: String?,
)

data class UpdateCheckResult(
    val currentVersion: String,
    val remoteVersion: String?,
    val hasAndroidApk: Boolean,
    val apkSha256: String?,
    val updateAvailable: Boolean,
)

data class DownloadProgress(
    val downloadedBytes: Long,
    val totalBytes: Long,
    val percent: Int,
)

sealed interface InstallLaunchResult {
    data object LAUNCHED : InstallLaunchResult
    data object NEEDS_UNKNOWN_SOURCES_PERMISSION : InstallLaunchResult
    data class FAILED(val message: String) : InstallLaunchResult
}

/**
 * Native in-app self-updater that checks `/api/info`, streams `/api/download/velodeck-agent.apk`
 * with SHA-256 verification into `cache/ota/`, and launches the Android package installer via
 * [FileProvider].
 */
class AppUpdater(
    private val checkHttpClient: OkHttpClient = defaultCheckHttpClient(),
    private val downloadHttpClient: OkHttpClient = defaultDownloadHttpClient(),
) {

    suspend fun checkForUpdate(
        apiBaseUrl: String,
        currentVersion: String = BuildConfig.VERSION_NAME,
    ): Result<UpdateCheckResult> = withContext(Dispatchers.IO) {
        val base = normalizeBaseUrl(apiBaseUrl)
        if (!base.startsWith("http://") && !base.startsWith("https://")) {
            return@withContext Result.failure(IllegalArgumentException("服务器地址格式无效：$base"))
        }

        val request = Request.Builder()
            .url("$base/api/info")
            .get()
            .header("Accept", "application/json")
            .header("Cache-Control", "no-cache, no-store")
            .header("Pragma", "no-cache")
            .build()

        val call = checkHttpClient.newCall(request)
        val cancelHandle = coroutineContext[Job]?.invokeOnCompletion { cause ->
            if (cause != null) {
                call.cancel()
            }
        }
        try {
            call.execute().use { response ->
                val rawBody = response.body?.string().orEmpty()
                parseRemoteUpdateInfo(response.code, rawBody).map { info ->
                    val remoteVersion = info.version.takeIf { it.isNotBlank() }
                    UpdateCheckResult(
                        currentVersion = currentVersion,
                        remoteVersion = remoteVersion,
                        hasAndroidApk = info.hasAndroidApk,
                        apkSha256 = info.apkSha256,
                        updateAvailable = isUpdateAvailable(
                            remoteVersion = remoteVersion,
                            currentVersion = currentVersion,
                            hasAndroidApk = info.hasAndroidApk,
                        ),
                    )
                }
            }
        } catch (ce: CancellationException) {
            throw ce
        } catch (_: SocketTimeoutException) {
            coroutineContext.ensureActive()
            Result.failure(IOException("检查更新超时，请检查网络连接"))
        } catch (_: UnknownHostException) {
            coroutineContext.ensureActive()
            Result.failure(IOException("无法解析服务器地址，请检查网络或中继设置"))
        } catch (_: ConnectException) {
            coroutineContext.ensureActive()
            Result.failure(IOException("无法连接到服务器 ($base)"))
        } catch (e: IOException) {
            coroutineContext.ensureActive()
            Result.failure(IOException("检查更新失败：${e.message ?: "网络异常"}"))
        } catch (t: Throwable) {
            coroutineContext.ensureActive()
            Result.failure(IllegalStateException("检查更新异常：${t.message ?: "未知错误"}"))
        } finally {
            cancelHandle?.dispose()
        }
    }

    suspend fun downloadApk(
        context: Context,
        apiBaseUrl: String,
        authToken: String?,
        expectedSha256: String?,
        onProgress: (DownloadProgress) -> Unit,
    ): Result<File> = withContext(Dispatchers.IO) {
        val base = normalizeBaseUrl(apiBaseUrl)
        if (!base.startsWith("http://") && !base.startsWith("https://")) {
            return@withContext Result.failure(IllegalArgumentException("服务器地址格式无效：$base"))
        }

        val requestBuilder = Request.Builder()
            .url(buildDownloadUrl(base, expectedSha256))
            .get()
            .header("Accept", MIME_APK)
            .header("Cache-Control", "no-cache, no-store")
            .header("Pragma", "no-cache")

        authToken?.trim()?.takeIf { it.isNotEmpty() }?.let { token ->
            requestBuilder.header("Authorization", "Bearer $token")
        }

        val otaDir = File(context.cacheDir, OTA_DIR_NAME).apply { mkdirs() }
        val partFile = File(otaDir, "$SELF_UPDATE_FILE_PREFIX-${System.currentTimeMillis()}.apk.part")
        deleteQuietly(partFile)

        val call = downloadHttpClient.newCall(requestBuilder.build())
        val cancelHandle = coroutineContext[Job]?.invokeOnCompletion { cause ->
            if (cause != null) {
                call.cancel()
            }
        }
        try {
            call.execute().use { response ->
                when (response.code) {
                    in 200..299 -> Unit
                    401, 403 -> return@withContext Result.failure(
                        IOException("服务器要求先登录绑定账号再下载更新 (HTTP ${response.code})"),
                    )
                    404 -> return@withContext Result.failure(
                        IOException("云端尚未上传 Android 安装包 (HTTP 404)"),
                    )
                    else -> return@withContext Result.failure(
                        IOException("下载安装包失败 (HTTP ${response.code})"),
                    )
                }

                val body = response.body
                    ?: return@withContext Result.failure(IOException("服务器未返回安装包数据"))

                val totalBytes = body.contentLength()
                val headerSha256 = response.header("X-APK-SHA256")?.trim()?.takeIf { it.isNotEmpty() }
                val targetSha256 = expectedSha256?.trim()?.takeIf { it.isNotEmpty() } ?: headerSha256

                val digest = MessageDigest.getInstance("SHA-256")
                val buffer = ByteArray(IO_BUFFER_BYTES)
                val headerMagic = ByteArray(APK_ZIP_MAGIC.size)
                var headerRead = 0
                var downloadedBytes = 0L
                var lastEmitMs = 0L
                var lastEmitPercent = -1

                onProgress(DownloadProgress(0L, totalBytes, 0))

                body.byteStream().use { input ->
                    FileOutputStream(partFile).use { output ->
                        while (true) {
                            coroutineContext.ensureActive()
                            val read = input.read(buffer)
                            if (read == -1) break
                            if (read == 0) continue

                            if (headerRead < headerMagic.size) {
                                val toCopy = minOf(read, headerMagic.size - headerRead)
                                System.arraycopy(buffer, 0, headerMagic, headerRead, toCopy)
                                headerRead += toCopy
                            }

                            output.write(buffer, 0, read)
                            digest.update(buffer, 0, read)
                            downloadedBytes += read

                            val percent = if (totalBytes > 0L) {
                                ((downloadedBytes * 100L) / totalBytes).toInt().coerceIn(0, 100)
                            } else {
                                0
                            }
                            val nowMs = System.nanoTime() / 1_000_000L
                            val elapsedDue = nowMs - lastEmitMs >= PROGRESS_THROTTLE_MS
                            val percentChanged = totalBytes > 0L && percent >= lastEmitPercent + 1
                            if (elapsedDue || percentChanged) {
                                lastEmitMs = nowMs
                                lastEmitPercent = percent
                                onProgress(DownloadProgress(downloadedBytes, totalBytes, percent))
                            }
                        }
                        output.flush()
                    }
                }

                if (downloadedBytes <= 0L) {
                    deleteQuietly(partFile)
                    return@withContext Result.failure(IOException("下载的安装包为空"))
                }

                if (!isCompleteDownload(downloadedBytes, totalBytes)) {
                    deleteQuietly(partFile)
                    return@withContext Result.failure(
                        IOException("安装包下载不完整 ($downloadedBytes / $totalBytes 字节)"),
                    )
                }

                if (!hasValidApkZipMagic(headerMagic, headerRead)) {
                    deleteQuietly(partFile)
                    return@withContext Result.failure(IOException("下载的文件不是有效的 Android 安装包 (APK)"))
                }

                val actualSha256 = digest.digest().joinToString("") { "%02x".format(it) }
                if (targetSha256 != null && !actualSha256.equals(targetSha256, ignoreCase = true)) {
                    deleteQuietly(partFile)
                    return@withContext Result.failure(IOException("安装包 SHA-256 校验失败"))
                }

                val finalFile = File(otaDir, selfUpdateApkFileName(actualSha256))
                moveFileAtomically(partFile, finalFile)
                pruneStaleSelfUpdateFiles(otaDir, keepFileName = finalFile.name)
                val finalTotal = if (totalBytes > 0L) totalBytes else downloadedBytes
                onProgress(DownloadProgress(downloadedBytes, finalTotal, 100))
                Result.success(finalFile)
            }
        } catch (ce: CancellationException) {
            deleteQuietly(partFile)
            throw ce
        } catch (_: SocketTimeoutException) {
            deleteQuietly(partFile)
            coroutineContext.ensureActive()
            Result.failure(IOException("下载超时，请稍后重试"))
        } catch (_: UnknownHostException) {
            deleteQuietly(partFile)
            coroutineContext.ensureActive()
            Result.failure(IOException("无法解析服务器地址，请检查网络"))
        } catch (_: ConnectException) {
            deleteQuietly(partFile)
            coroutineContext.ensureActive()
            Result.failure(IOException("无法连接到服务器 ($base)"))
        } catch (e: IOException) {
            deleteQuietly(partFile)
            coroutineContext.ensureActive()
            Result.failure(IOException(e.message ?: "下载安装包失败"))
        } catch (t: Throwable) {
            deleteQuietly(partFile)
            coroutineContext.ensureActive()
            Result.failure(IllegalStateException("下载异常：${t.message ?: "未知错误"}"))
        } finally {
            cancelHandle?.dispose()
        }
    }

    fun launchApkInstaller(context: Context, apkFile: File): InstallLaunchResult {
        if (!apkFile.isFile || apkFile.length() <= 0L) {
            return InstallLaunchResult.FAILED("安装包文件不存在或已损坏")
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
            !context.packageManager.canRequestPackageInstalls()
        ) {
            return try {
                val permIntent = Intent(
                    Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:${context.packageName}"),
                ).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                context.startActivity(permIntent)
                InstallLaunchResult.NEEDS_UNKNOWN_SOURCES_PERMISSION
            } catch (t: Throwable) {
                InstallLaunchResult.FAILED(t.message ?: "无法打开未知来源安装权限设置")
            }
        }

        return try {
            val uri = FileProvider.getUriForFile(
                context,
                "${context.packageName}.fileprovider",
                apkFile,
            )
            val installIntent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, MIME_APK)
                addFlags(
                    Intent.FLAG_GRANT_READ_URI_PERMISSION or
                        Intent.FLAG_ACTIVITY_NEW_TASK or
                        Intent.FLAG_ACTIVITY_CLEAR_TOP,
                )
            }
            context.startActivity(installIntent)
            InstallLaunchResult.LAUNCHED
        } catch (t: Throwable) {
            InstallLaunchResult.FAILED(t.message ?: "无法启动系统安装器")
        }
    }

    private fun moveFileAtomically(src: File, dst: File) {
        try {
            Files.move(
                src.toPath(),
                dst.toPath(),
                StandardCopyOption.REPLACE_EXISTING,
                StandardCopyOption.ATOMIC_MOVE,
            )
            return
        } catch (_: Throwable) {
        }
        try {
            Files.move(
                src.toPath(),
                dst.toPath(),
                StandardCopyOption.REPLACE_EXISTING,
            )
            return
        } catch (_: Throwable) {
        }
        if (dst.exists()) {
            dst.delete()
        }
        if (!src.renameTo(dst)) {
            throw IOException("保存安装包文件失败")
        }
    }

    private fun deleteQuietly(file: File) {
        try {
            if (file.exists()) {
                file.delete()
            }
        } catch (_: Throwable) {
        }
    }

    companion object {
        private const val OTA_DIR_NAME = "ota"
        private const val SELF_UPDATE_FILE_PREFIX = "velodeck-self-update"
        private const val MIME_APK = "application/vnd.android.package-archive"
        private const val IO_BUFFER_BYTES = 32 * 1024
        private const val PROGRESS_THROTTLE_MS = 120L
        private val APK_ZIP_MAGIC = byteArrayOf(0x50, 0x4B, 0x03, 0x04)

        // Share a single companion OkHttpClient (dispatcher + connection pool) across Activity instances
        private val baseHttpClient: OkHttpClient by lazy {
            OkHttpClient.Builder()
                .connectTimeout(10, TimeUnit.SECONDS)
                .readTimeout(15, TimeUnit.SECONDS)
                .writeTimeout(15, TimeUnit.SECONDS)
                .build()
        }

        private fun defaultCheckHttpClient(): OkHttpClient = baseHttpClient.newBuilder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(15, TimeUnit.SECONDS)
            .writeTimeout(15, TimeUnit.SECONDS)
            .build()

        private fun defaultDownloadHttpClient(): OkHttpClient = baseHttpClient.newBuilder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .writeTimeout(15, TimeUnit.SECONDS)
            .followRedirects(true)
            .build()

        internal fun hasValidApkZipMagic(bytes: ByteArray, length: Int = bytes.size): Boolean {
            if (length < APK_ZIP_MAGIC.size || bytes.size < APK_ZIP_MAGIC.size) return false
            for (i in APK_ZIP_MAGIC.indices) {
                if (bytes[i] != APK_ZIP_MAGIC[i]) return false
            }
            return true
        }

        internal fun isCompleteDownload(downloadedBytes: Long, totalBytes: Long): Boolean {
            if (downloadedBytes <= 0L) return false
            return totalBytes <= 0L || downloadedBytes == totalBytes
        }

        private fun normalizeValidHex(raw: String?): String? {
            val trimmed = raw?.trim()?.lowercase(Locale.US).orEmpty()
            if (trimmed.length < 12) return null
            for (ch in trimmed) {
                val isHex = (ch in '0'..'9') || (ch in 'a'..'f')
                if (!isHex) return null
            }
            return trimmed
        }

        fun selfUpdateApkFileName(
            sha256: String?,
            fallbackSuffix: String = System.currentTimeMillis().toString(),
        ): String {
            val hex = normalizeValidHex(sha256)
            if (hex != null) {
                return "$SELF_UPDATE_FILE_PREFIX-${hex.take(12)}.apk"
            }
            val safe = fallbackSuffix
                .filter { ch ->
                    ch in 'a'..'z' || ch in 'A'..'Z' || ch in '0'..'9' || ch == '_' || ch == '-'
                }
                .take(48)
                .ifEmpty { "latest" }
            return "$SELF_UPDATE_FILE_PREFIX-$safe.apk"
        }

        internal fun buildDownloadUrl(
            apiBaseUrl: String,
            expectedSha256: String?,
            nowMs: Long = System.currentTimeMillis(),
        ): String {
            val base = normalizeBaseUrl(apiBaseUrl)
            val cleanExpected = normalizeValidHex(expectedSha256)
            val query = if (cleanExpected != null) {
                "sha=${cleanExpected.take(12)}"
            } else {
                "t=$nowMs"
            }
            return "$base/api/download/velodeck-agent.apk?$query"
        }

        internal fun pruneStaleSelfUpdateFiles(otaDir: File, keepFileName: String) {
            try {
                otaDir.listFiles()?.forEach { file ->
                    if (!file.isFile || file.name == keepFileName) return@forEach
                    val isStaleApk = file.name.startsWith(SELF_UPDATE_FILE_PREFIX) && file.name.endsWith(".apk")
                    val isStalePart = file.name.endsWith(".part")
                    if (isStaleApk || isStalePart) {
                        file.delete()
                    }
                }
            } catch (_: Throwable) {
            }
        }

        /**
         * Checks whether `cache/ota/velodeck-self-update-<sha12>.apk` already exists on disk, has valid
         * ZIP/APK magic bytes, and matches [expectedSha256]. Allows returning from Android 11+
         * unknown-sources permission process restarts to install immediately without re-downloading.
         */
        fun findVerifiedCachedApk(context: Context, expectedSha256: String?): File? =
            findVerifiedCachedApkInDir(File(context.cacheDir, OTA_DIR_NAME), expectedSha256)

        internal fun findVerifiedCachedApkInDir(otaDir: File, expectedSha256: String?): File? {
            val validHex = normalizeValidHex(expectedSha256) ?: return null
            val cachedFile = File(otaDir, selfUpdateApkFileName(validHex))
            return findVerifiedCachedApkFile(cachedFile, validHex)
        }

        internal fun findVerifiedCachedApkFile(apkFile: File, expectedSha256: String?): File? {
            val targetSha256 = expectedSha256?.trim()?.takeIf { it.isNotEmpty() } ?: return null
            if (!apkFile.isFile || apkFile.length() < APK_ZIP_MAGIC.size.toLong()) return null
            return try {
                val digest = MessageDigest.getInstance("SHA-256")
                val buffer = ByteArray(IO_BUFFER_BYTES)
                val headerMagic = ByteArray(APK_ZIP_MAGIC.size)
                var headerRead = 0
                FileInputStream(apkFile).use { input ->
                    while (true) {
                        val read = input.read(buffer)
                        if (read == -1) break
                        if (read == 0) continue
                        if (headerRead < headerMagic.size) {
                            val toCopy = minOf(read, headerMagic.size - headerRead)
                            System.arraycopy(buffer, 0, headerMagic, headerRead, toCopy)
                            headerRead += toCopy
                        }
                        digest.update(buffer, 0, read)
                    }
                }
                if (!hasValidApkZipMagic(headerMagic, headerRead)) return null
                val actualSha256 = digest.digest().joinToString("") { "%02x".format(it) }
                if (actualSha256.equals(targetSha256, ignoreCase = true)) apkFile else null
            } catch (_: Throwable) {
                null
            }
        }

        fun normalizeBaseUrl(apiBaseUrl: String): String =
            apiBaseUrl.trim().trimEnd('/')

        fun compareSemver(a: String, b: String): Int {
            val parsedA = parseSemver(a)
            val parsedB = parseSemver(b)

            val maxLen = maxOf(parsedA.core.size, parsedB.core.size)
            for (i in 0 until maxLen) {
                val partA = parsedA.core.getOrElse(i) { 0L }
                val partB = parsedB.core.getOrElse(i) { 0L }
                if (partA != partB) {
                    return if (partA > partB) 1 else -1
                }
            }

            val preA = parsedA.prerelease
            val preB = parsedB.prerelease
            return when {
                preA == null && preB == null -> 0
                preA == null -> 1 // release > prerelease (e.g. 1.0.4 > 1.0.4-beta)
                preB == null -> -1
                else -> comparePrerelease(preA, preB)
            }
        }

        fun isUpdateAvailable(
            remoteVersion: String?,
            currentVersion: String,
            hasAndroidApk: Boolean,
        ): Boolean {
            if (!hasAndroidApk) return false
            val trimmedRemote = remoteVersion?.trim().orEmpty()
            if (trimmedRemote.isEmpty()) return false
            val strippedRemote = stripVersionPrefix(trimmedRemote)
            if (strippedRemote.firstOrNull()?.isDigit() != true) return false
            return compareSemver(trimmedRemote, currentVersion) > 0
        }

        fun parseRemoteUpdateInfo(statusCode: Int, responseBody: String): Result<RemoteUpdateInfo> {
            if (statusCode !in 200..299) {
                return Result.failure(IOException("获取版本信息失败 (HTTP $statusCode)"))
            }
            val json = try {
                if (responseBody.isNotBlank()) JSONObject(responseBody) else null
            } catch (_: Throwable) {
                null
            } ?: return Result.failure(IllegalStateException("服务器版本信息格式异常"))

            val version = optNullableString(json, "version").orEmpty()
            val hasAndroidApk = json.optBoolean("hasAndroidApk", false)
            val apkSha256 = optNullableString(json, "apkSha256")
            return Result.success(
                RemoteUpdateInfo(
                    version = version,
                    hasAndroidApk = hasAndroidApk,
                    apkSha256 = apkSha256,
                ),
            )
        }

        fun formatMegabytes(bytes: Long): String {
            val mb = bytes.coerceAtLeast(0L) / (1024.0 * 1024.0)
            return String.format(Locale.US, "%.1f", mb)
        }

        private data class ParsedSemver(
            val core: List<Long>,
            val prerelease: List<String>?,
        )

        private fun stripVersionPrefix(raw: String): String {
            val trimmed = raw.trim()
            return if (trimmed.startsWith("v", ignoreCase = true)) {
                trimmed.substring(1).trimStart()
            } else {
                trimmed
            }
        }

        private fun parseSemver(raw: String): ParsedSemver {
            val noPrefix = stripVersionPrefix(raw)
            val noBuild = noPrefix.substringBefore("+")
            val dashIdx = noBuild.indexOf('-')
            val coreStr = if (dashIdx >= 0) noBuild.substring(0, dashIdx) else noBuild
            val preStr = if (dashIdx >= 0) noBuild.substring(dashIdx + 1).trim() else ""

            val coreParts = coreStr.split('.').map { segment ->
                val digits = segment.trim().takeWhile { it.isDigit() }
                digits.toLongOrNull() ?: 0L
            }
            val preParts = preStr.takeIf { it.isNotEmpty() }?.split('.')?.filter { it.isNotEmpty() }
            return ParsedSemver(core = coreParts, prerelease = preParts)
        }

        private fun comparePrerelease(a: List<String>, b: List<String>): Int {
            val minLen = minOf(a.size, b.size)
            for (i in 0 until minLen) {
                val idA = a[i]
                val idB = b[i]
                if (idA == idB) continue
                val numA = idA.toLongOrNull()
                val numB = idB.toLongOrNull()
                return when {
                    numA != null && numB != null -> if (numA > numB) 1 else -1
                    numA != null -> -1 // SemVer: numeric identifiers have lower precedence than non-numeric
                    numB != null -> 1
                    else -> idA.compareTo(idB).coerceIn(-1, 1)
                }
            }
            return a.size.compareTo(b.size).coerceIn(-1, 1)
        }

        private fun optNullableString(json: JSONObject, key: String): String? {
            if (!json.has(key) || json.isNull(key)) return null
            return json.optString(key).trim().takeIf { it.isNotEmpty() }
        }
    }
}
