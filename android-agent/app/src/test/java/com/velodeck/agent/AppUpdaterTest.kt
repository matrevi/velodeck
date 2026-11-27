package com.velodeck.agent

import com.velodeck.agent.service.AppUpdater
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files
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

    @Test
    fun selfUpdateApkFileName_producesUniqueShaBoundNamesAndSanitizesFallback() {
        val sha1 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        val sha2 = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"

        val name1 = AppUpdater.selfUpdateApkFileName(sha1)
        val name2 = AppUpdater.selfUpdateApkFileName(sha2)
        assertEquals("velodeck-self-update-e3b0c44298fc.apk", name1)
        assertEquals("velodeck-self-update-2cf24dba5fb0.apk", name2)
        assertNotEquals(name1, name2)

        // Uppercase + surrounding whitespace normalizes to lowercase 12-char prefix
        assertEquals(name1, AppUpdater.selfUpdateApkFileName("  ${sha1.uppercase()}  "))
        // Exact 12-char hex string is accepted
        assertEquals("velodeck-self-update-abcdef012345.apk", AppUpdater.selfUpdateApkFileName("ABCDEF012345"))

        // Short (<12), non-hex, null, or blank SHA falls back to sanitized fallbackSuffix
        assertEquals(
            "velodeck-self-update-fb_1-2.apk",
            AppUpdater.selfUpdateApkFileName("abcdef01234", fallbackSuffix = "fb_1-2"),
        )
        assertEquals(
            "velodeck-self-update-1700000000000.apk",
            AppUpdater.selfUpdateApkFileName("not-valid-hex-abcdef123456", fallbackSuffix = "1700000000000"),
        )
        assertEquals(
            "velodeck-self-update-badpath123.apk",
            AppUpdater.selfUpdateApkFileName(null, fallbackSuffix = "../bad/path!@#123"),
        )
        assertEquals(
            "velodeck-self-update-latest.apk",
            AppUpdater.selfUpdateApkFileName("   ", fallbackSuffix = "../..///!@#"),
        )
        assertEquals(
            "velodeck-self-update-latest.apk",
            AppUpdater.selfUpdateApkFileName(null, fallbackSuffix = "   "),
        )

        // Default fallbackSuffix produces a numeric timestamp suffix
        val defaultName = AppUpdater.selfUpdateApkFileName(null)
        assertTrue(
            "Unexpected default name: $defaultName",
            Regex("^velodeck-self-update-[0-9]+\\.apk$").matches(defaultName),
        )
    }

    @Test
    fun buildDownloadUrl_appendsCacheBustingQuery() {
        val sha = "ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
        assertEquals(
            "https://relay.example.com/api/download/velodeck-agent.apk?sha=abcdef012345",
            AppUpdater.buildDownloadUrl("https://relay.example.com/", sha, nowMs = 999L),
        )
        assertEquals(
            "https://relay.example.com/api/download/velodeck-agent.apk?t=1700000000123",
            AppUpdater.buildDownloadUrl("https://relay.example.com", null, nowMs = 1700000000123L),
        )
        assertEquals(
            "https://relay.example.com/api/download/velodeck-agent.apk?t=1700000000456",
            AppUpdater.buildDownloadUrl("https://relay.example.com", "invalid-sha", nowMs = 1700000000456L),
        )
    }

    @Test
    fun findVerifiedCachedApkInDir_matchesOnlyUniqueShaFilenameAndRejectsInvalidSha() {
        val otaDir = Files.createTempDirectory("velodeck-ota-cache-test").toFile()
        try {
            val apkV108 = byteArrayOf(0x50, 0x4B, 0x03, 0x04, 0x01, 0x00, 0x08, 0x00)
            val shaV108 = sha256Hex(apkV108)
            val apkV109 = byteArrayOf(0x50, 0x4B, 0x03, 0x04, 0x01, 0x00, 0x09, 0x00)
            val shaV109 = sha256Hex(apkV109)

            // Legacy static filename with v1.0.9 bytes must NOT be matched by SHA-named lookup
            val legacyFile = File(otaDir, "velodeck-self-update.apk").apply { writeBytes(apkV109) }
            assertNull(AppUpdater.findVerifiedCachedApkInDir(otaDir, shaV109))
            legacyFile.delete()

            // Unique SHA-named file for v1.0.8 matches v1.0.8 but NOT v1.0.9
            val v108File = File(otaDir, AppUpdater.selfUpdateApkFileName(shaV108)).apply { writeBytes(apkV108) }
            assertEquals(v108File, AppUpdater.findVerifiedCachedApkInDir(otaDir, shaV108))
            assertEquals(v108File, AppUpdater.findVerifiedCachedApkInDir(otaDir, shaV108.uppercase()))
            assertNull(AppUpdater.findVerifiedCachedApkInDir(otaDir, shaV109))

            // Invalid/null/blank/short SHA returns null early
            assertNull(AppUpdater.findVerifiedCachedApkInDir(otaDir, null))
            assertNull(AppUpdater.findVerifiedCachedApkInDir(otaDir, "   "))
            assertNull(AppUpdater.findVerifiedCachedApkInDir(otaDir, "shorthex"))
            assertNull(AppUpdater.findVerifiedCachedApkInDir(otaDir, "not-valid-hex-0123456789ab"))
        } finally {
            otaDir.deleteRecursively()
        }
    }

    @Test
    fun pruneStaleSelfUpdateFiles_removesLegacyAndOldApksAndPartsOnly() {
        val otaDir = Files.createTempDirectory("velodeck-ota-prune-test").toFile()
        try {
            val currentApk = File(otaDir, "velodeck-self-update-111122223333.apk").apply { writeText("new") }
            val oldShaApk = File(otaDir, "velodeck-self-update-aaaabbbbcccc.apk").apply { writeText("old") }
            val legacyApk = File(otaDir, "velodeck-self-update.apk").apply { writeText("legacy") }
            val stalePart = File(otaDir, "velodeck-self-update-1700000000000.apk.part").apply { writeText("part") }
            val legacyPart = File(otaDir, "velodeck-self-update.apk.part").apply { writeText("part2") }
            val p2pOtaApk = File(otaDir, "velodeck-ota-dddddddddddd.apk").apply { writeText("p2p") }
            val incomingTmp = File(otaDir, "incoming_t1.tmp").apply { writeText("tmp") }

            AppUpdater.pruneStaleSelfUpdateFiles(otaDir, keepFileName = currentApk.name)

            assertTrue(currentApk.exists())
            assertFalse(oldShaApk.exists())
            assertFalse(legacyApk.exists())
            assertFalse(stalePart.exists())
            assertFalse(legacyPart.exists())
            assertTrue(p2pOtaApk.exists())
            assertTrue(incomingTmp.exists())
        } finally {
            otaDir.deleteRecursively()
        }
    }

    private fun sha256Hex(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256")
            .digest(bytes)
            .joinToString("") { "%02x".format(it) }
}
