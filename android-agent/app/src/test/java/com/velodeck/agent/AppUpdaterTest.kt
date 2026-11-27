package com.velodeck.agent

import com.velodeck.agent.service.AppUpdater
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.security.MessageDigest

class AppUpdaterTest {

    @Test
    fun compareSemver_handlesNumericMultiDigitPrefixesAndPrerelease() {
        assertTrue(AppUpdater.compareSemver("1.0.10", "1.0.4") > 0)
        assertTrue(AppUpdater.compareSemver("1.0.4", "1.0.10") < 0)
        assertEquals(0, AppUpdater.compareSemver("v1.0.4", "1.0.4"))
        assertEquals(0, AppUpdater.compareSemver("V1.2", "1.2.0"))
        assertTrue(AppUpdater.compareSemver("1.0.10-beta", "1.0.4") > 0)
        assertTrue(AppUpdater.compareSemver("1.0.4-beta", "1.0.4") < 0)
        assertTrue(AppUpdater.compareSemver("1.0.4", "1.0.4-beta") > 0)
        assertTrue(AppUpdater.compareSemver("1.0.4-beta.10", "1.0.4-beta.2") > 0)
        assertTrue(AppUpdater.compareSemver("2.0.0", "1.99.99") > 0)
    }

    @Test
    fun isUpdateAvailable_requiresApkAndHigherRemoteVersion() {
        assertTrue(AppUpdater.isUpdateAvailable("1.0.5", "1.0.4", hasAndroidApk = true))
        assertTrue(AppUpdater.isUpdateAvailable("v1.0.10", "1.0.4", hasAndroidApk = true))
        assertFalse(AppUpdater.isUpdateAvailable("1.0.5", "1.0.4", hasAndroidApk = false))
        assertFalse(AppUpdater.isUpdateAvailable("1.0.4", "1.0.4", hasAndroidApk = true))
        assertFalse(AppUpdater.isUpdateAvailable("1.0.3", "1.0.4", hasAndroidApk = true))
        assertFalse(AppUpdater.isUpdateAvailable(null, "1.0.4", hasAndroidApk = true))
        assertFalse(AppUpdater.isUpdateAvailable("   ", "1.0.4", hasAndroidApk = true))
        assertFalse(AppUpdater.isUpdateAvailable("unknown", "1.0.4", hasAndroidApk = true))
    }

    @Test
    fun normalizeBaseUrl_stripsWhitespaceAndTrailingSlashes() {
        assertEquals("https://relay.example.com", AppUpdater.normalizeBaseUrl("https://relay.example.com///"))
        assertEquals("http://192.168.1.10:8080", AppUpdater.normalizeBaseUrl("  http://192.168.1.10:8080/  "))
        assertEquals("https://relay.example.com/sub", AppUpdater.normalizeBaseUrl("https://relay.example.com/sub/"))
    }

    @Test
    fun parseRemoteUpdateInfo_handlesJsonNullSafely() {
        val noApkRes = AppUpdater.parseRemoteUpdateInfo(
            statusCode = 200,
            responseBody = """{"ok":true,"version":"1.0.4","hasAndroidApk":false,"apkSha256":null}""",
        )
        assertTrue(noApkRes.isSuccess)
        val noApk = noApkRes.getOrThrow()
        assertEquals("1.0.4", noApk.version)
        assertFalse(noApk.hasAndroidApk)
        assertNull(noApk.apkSha256)

        val withApkRes = AppUpdater.parseRemoteUpdateInfo(
            statusCode = 200,
            responseBody = """{"ok":true,"version":"1.0.5","hasAndroidApk":true,"apkSha256":"abcdef123456"}""",
        )
        assertTrue(withApkRes.isSuccess)
        val withApk = withApkRes.getOrThrow()
        assertEquals("1.0.5", withApk.version)
        assertTrue(withApk.hasAndroidApk)
        assertEquals("abcdef123456", withApk.apkSha256)

        val nullVersionRes = AppUpdater.parseRemoteUpdateInfo(
            statusCode = 200,
            responseBody = """{"ok":true,"version":null,"hasAndroidApk":true,"apkSha256":null}""",
        )
        assertTrue(nullVersionRes.isSuccess)
        assertEquals("", nullVersionRes.getOrThrow().version)
        assertNull(nullVersionRes.getOrThrow().apkSha256)

        assertTrue(AppUpdater.parseRemoteUpdateInfo(500, "error").isFailure)
        assertTrue(AppUpdater.parseRemoteUpdateInfo(200, "not-json").isFailure)
    }

    @Test
    fun hasValidApkZipMagic_validatesZipLocalFileHeaderBytes() {
        assertTrue(AppUpdater.hasValidApkZipMagic(byteArrayOf(0x50, 0x4B, 0x03, 0x04)))
        assertTrue(AppUpdater.hasValidApkZipMagic(byteArrayOf(0x50, 0x4B, 0x03, 0x04, 0x14, 0x00), length = 6))
        assertFalse(AppUpdater.hasValidApkZipMagic(byteArrayOf(0x50, 0x4B, 0x03, 0x04), length = 3))
        assertFalse(AppUpdater.hasValidApkZipMagic(byteArrayOf(0x50, 0x4B, 0x05, 0x06)))
        assertFalse(AppUpdater.hasValidApkZipMagic("<html>502 Bad Gateway</html>".toByteArray()))
        assertFalse(AppUpdater.hasValidApkZipMagic(byteArrayOf()))
    }

    @Test
    fun isCompleteDownload_enforcesKnownContentLengthAndNonEmptyPayload() {
        assertTrue(AppUpdater.isCompleteDownload(downloadedBytes = 1024L, totalBytes = 1024L))
        assertTrue(AppUpdater.isCompleteDownload(downloadedBytes = 1024L, totalBytes = -1L))
        assertTrue(AppUpdater.isCompleteDownload(downloadedBytes = 1024L, totalBytes = 0L))
        assertFalse(AppUpdater.isCompleteDownload(downloadedBytes = 0L, totalBytes = -1L))
        assertFalse(AppUpdater.isCompleteDownload(downloadedBytes = 0L, totalBytes = 0L))
        assertFalse(AppUpdater.isCompleteDownload(downloadedBytes = 512L, totalBytes = 1024L))
        assertFalse(AppUpdater.isCompleteDownload(downloadedBytes = 1025L, totalBytes = 1024L))
    }

    @Test
    fun findVerifiedCachedApkFile_reusesOnlyMatchingZipApkWithValidSha256() {
        val validApkBytes = byteArrayOf(0x50, 0x4B, 0x03, 0x04, 0x14, 0x00, 0x08, 0x08, 0x00, 0x00)
        val validSha = sha256Hex(validApkBytes)
        val validFile = File.createTempFile("velodeck-valid-", ".apk")

        val badMagicBytes = "<html>not an apk</html>".toByteArray()
        val badMagicSha = sha256Hex(badMagicBytes)
        val badMagicFile = File.createTempFile("velodeck-bad-", ".apk")

        try {
            validFile.writeBytes(validApkBytes)
            badMagicFile.writeBytes(badMagicBytes)

            val matched = AppUpdater.findVerifiedCachedApkFile(validFile, validSha)
            assertNotNull(matched)
            assertEquals(validFile, matched)
            // Case-insensitive SHA-256 comparison
            assertEquals(validFile, AppUpdater.findVerifiedCachedApkFile(validFile, validSha.uppercase()))

            // Missing, blank, or mismatched SHA-256 must not reuse cached APK
            assertNull(AppUpdater.findVerifiedCachedApkFile(validFile, null))
            assertNull(AppUpdater.findVerifiedCachedApkFile(validFile, "   "))
            assertNull(AppUpdater.findVerifiedCachedApkFile(validFile, "0".repeat(64)))

            // Non-ZIP payload must be rejected even if SHA-256 matches
            assertNull(AppUpdater.findVerifiedCachedApkFile(badMagicFile, badMagicSha))

            // Non-existent file must return null
            val missingFile = File(validFile.parentFile, "does-not-exist-${System.nanoTime()}.apk")
            assertNull(AppUpdater.findVerifiedCachedApkFile(missingFile, validSha))
        } finally {
            validFile.delete()
            badMagicFile.delete()
        }
    }

    private fun sha256Hex(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256")
            .digest(bytes)
            .joinToString("") { "%02x".format(it) }
}
