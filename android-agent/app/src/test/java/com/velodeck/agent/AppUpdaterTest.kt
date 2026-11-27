package com.velodeck.agent

import com.velodeck.agent.service.AppUpdater
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

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
}
