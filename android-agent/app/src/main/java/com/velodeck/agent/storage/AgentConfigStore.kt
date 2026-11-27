package com.velodeck.agent.storage

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import com.velodeck.agent.BuildConfig
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.net.URI
import java.security.KeyStore
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class KeyStoreUnavailableException(message: String, cause: Throwable? = null) :
    IllegalStateException(message, cause)

data class AgentConfig(
    val deviceId: String,
    val deviceSecret: String,
    val accessToken: String,
    val controlPassword: String,
    val controlCode: String,
    val authToken: String,
    val ownerUsername: String,
    val pendingUnbindOwner: Boolean = false,
    val apiBaseUrl: String,
    val deviceName: String,
    val relayEnabled: Boolean,
    val relayUrl: String,
    val directEnabled: Boolean,
    val directPort: Int,
    val autoStart: Boolean,
    val autoAcceptProjection: Boolean,
    val blackScreenMode: Boolean = false,
    val forcePortrait: Boolean = true,
    val unlockPin: String,
) {
    /**
     * Derives the effective HTTP(S) API base URL from [relayUrl] when configured,
     * falling back to [apiBaseUrl] / [BuildConfig.DEFAULT_API_BASE_URL].
     */
    fun effectiveApiBaseUrl(): String {
        val fallback = apiBaseUrl.trim().ifEmpty { BuildConfig.DEFAULT_API_BASE_URL }
        return if (relayUrl.isNotBlank()) {
            AgentConfigStore.deriveApiBaseFromRelayUrl(relayUrl, fallback)
        } else {
            fallback.trimEnd('/')
        }
    }
}

class AgentConfigStore(context: Context) {

    private sealed interface SecretReadResult {
        data object Missing : SecretReadResult
        data object Empty : SecretReadResult
        data class Decrypted(val value: String, val needsMigration: Boolean) : SecretReadResult
    }

    private val appContext = context.applicationContext
    private val prefs = appContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    private val random = SecureRandom()

    private val _configFlow = MutableStateFlow(loadOrInitConfig())
    val configFlow: StateFlow<AgentConfig> = _configFlow.asStateFlow()

    val current: AgentConfig
        get() = _configFlow.value

    fun update(transform: (AgentConfig) -> AgentConfig): AgentConfig {
        val next = transform(_configFlow.value)
        saveConfig(next)
        _configFlow.value = next
        return next
    }

    fun regenerateAccessToken(): String {
        val token = generateRandomToken(24)
        update { it.copy(accessToken = token) }
        return token
    }

    fun generateRandomControlPassword(length: Int = DEFAULT_CONTROL_PASSWORD_LENGTH): String =
        generateControlPassword(length, random)

    fun verifyAccessToken(candidate: String): Boolean {
        val expected = _configFlow.value.accessToken
        if (expected.isEmpty() || candidate.isEmpty()) return false
        return constantTimeEquals(expected, candidate)
    }

    fun verifyControlPassword(candidate: String): Boolean {
        val expected = _configFlow.value.controlPassword
        if (expected.isEmpty() || candidate.isEmpty()) return false
        return constantTimeEquals(expected, candidate)
    }

    private fun loadOrInitConfig(): AgentConfig {
        var dirty = false

        val deviceId = prefs.getString(KEY_DEVICE_ID, null)?.takeIf { it.isNotBlank() } ?: run {
            dirty = true
            "android-${generateRandomHex(8)}"
        }

        // Fail-closed: if deviceSecret already exists in encrypted storage and KeyStore
        // throws a transient error, readSecret() throws instead of silently overwriting it!
        val deviceSecret = when (val res = readSecret(KEY_DEVICE_SECRET_ENC)) {
            is SecretReadResult.Decrypted -> {
                if (res.needsMigration) dirty = true
                if (res.value.isBlank()) {
                    dirty = true
                    generateRandomHex(32)
                } else {
                    res.value
                }
            }
            SecretReadResult.Missing, SecretReadResult.Empty -> {
                dirty = true
                generateRandomHex(32)
            }
        }

        val accessToken = when (val res = readSecret(KEY_ACCESS_TOKEN_ENC)) {
            is SecretReadResult.Decrypted -> {
                if (res.needsMigration) dirty = true
                if (res.value.isBlank()) {
                    dirty = true
                    generateRandomToken(24)
                } else {
                    res.value
                }
            }
            SecretReadResult.Missing, SecretReadResult.Empty -> {
                dirty = true
                generateRandomToken(24)
            }
        }

        val controlPassword = when (val res = readSecret(KEY_CONTROL_PASSWORD_ENC)) {
            is SecretReadResult.Decrypted -> {
                if (res.needsMigration) dirty = true
                if (res.value.isBlank()) {
                    dirty = true
                    generateControlPassword(DEFAULT_CONTROL_PASSWORD_LENGTH, random)
                } else {
                    res.value
                }
            }
            SecretReadResult.Missing, SecretReadResult.Empty -> {
                dirty = true
                generateControlPassword(DEFAULT_CONTROL_PASSWORD_LENGTH, random)
            }
        }

        val controlCode = prefs.getString(KEY_CONTROL_CODE, null).orEmpty().trim()
        val authToken = when (val res = readSecret(KEY_AUTH_TOKEN_ENC)) {
            is SecretReadResult.Decrypted -> {
                if (res.needsMigration) dirty = true
                res.value
            }
            SecretReadResult.Missing, SecretReadResult.Empty -> ""
        }
        val ownerUsername = prefs.getString(KEY_OWNER_USERNAME, null).orEmpty().trim()
        val pendingUnbindOwner = prefs.getBoolean(KEY_PENDING_UNBIND_OWNER, false)

        val defaultName = buildString {
            val brand = Build.MANUFACTURER?.replaceFirstChar { it.uppercase() }.orEmpty()
            val model = Build.MODEL.orEmpty()
            if (model.startsWith(brand, ignoreCase = true)) {
                append(model)
            } else {
                append(brand)
                if (brand.isNotEmpty() && model.isNotEmpty()) append(' ')
                append(model)
            }
        }.ifBlank { "Android Device" }

        val deviceName = prefs.getString(KEY_DEVICE_NAME, null)?.takeIf { it.isNotBlank() } ?: defaultName

        val storedRelayUrl = prefs.getString(KEY_RELAY_URL, null)?.trim()
        val isLegacyPlaceholder = storedRelayUrl == LEGACY_PLACEHOLDER_RELAY_URL
        val relayUrl = when {
            storedRelayUrl.isNullOrEmpty() || isLegacyPlaceholder -> {
                dirty = true
                DEFAULT_RELAY_URL
            }
            else -> storedRelayUrl
        }

        val relayEnabled = if (isLegacyPlaceholder) {
            dirty = true
            true
        } else {
            prefs.getBoolean(KEY_RELAY_ENABLED, true)
        }

        val storedApiBase = prefs.getString(KEY_API_BASE_URL, null)?.trim()
        val apiBaseUrl = if (storedApiBase.isNullOrEmpty() || isLegacyPlaceholder) {
            dirty = true
            deriveApiBaseFromRelayUrl(relayUrl, DEFAULT_API_BASE_URL)
        } else {
            storedApiBase
        }

        val directEnabled = prefs.getBoolean(KEY_DIRECT_ENABLED, false)
        val directPort = prefs.getInt(KEY_DIRECT_PORT, DEFAULT_DIRECT_PORT).coerceIn(1024, 65535)
        val autoStart = prefs.getBoolean(KEY_AUTO_START, true)
        val autoAcceptProjection = if (!prefs.getBoolean(KEY_AUTO_ACCEPT_MIGRATED_V2, false)) {
            dirty = true
            true
        } else {
            prefs.getBoolean(KEY_AUTO_ACCEPT_PROJECTION, true)
        }
        val blackScreenMode = prefs.getBoolean(KEY_BLACK_SCREEN_MODE, false)
        val forcePortrait = prefs.getBoolean(KEY_FORCE_PORTRAIT, true)
        val unlockPin = when (val res = readSecret(KEY_UNLOCK_PIN_ENC)) {
            is SecretReadResult.Decrypted -> {
                if (res.needsMigration) dirty = true
                res.value
            }
            SecretReadResult.Missing, SecretReadResult.Empty -> ""
        }

        val cfg = AgentConfig(
            deviceId = deviceId,
            deviceSecret = deviceSecret,
            accessToken = accessToken,
            controlPassword = controlPassword,
            controlCode = controlCode,
            authToken = authToken,
            ownerUsername = ownerUsername,
            pendingUnbindOwner = pendingUnbindOwner,
            apiBaseUrl = apiBaseUrl,
            deviceName = deviceName,
            relayEnabled = relayEnabled,
            relayUrl = relayUrl,
            directEnabled = directEnabled,
            directPort = directPort,
            autoStart = autoStart,
            autoAcceptProjection = autoAcceptProjection,
            blackScreenMode = blackScreenMode,
            forcePortrait = forcePortrait,
            unlockPin = unlockPin,
        )

        if (dirty) {
            saveConfig(cfg)
        }
        return cfg
    }

    private fun saveConfig(config: AgentConfig) {
        val trimmedRelay = config.relayUrl.trim()
        val derivedApi = config.apiBaseUrl.trim().ifEmpty {
            deriveApiBaseFromRelayUrl(trimmedRelay, DEFAULT_API_BASE_URL)
        }

        // Encrypt all secrets up-front (fail-closed): if KeyStore fails, throw BEFORE mutating prefs.
        val encDeviceSecret = encryptSecret(KEY_DEVICE_SECRET_ENC, config.deviceSecret)
        val encAccessToken = encryptSecret(KEY_ACCESS_TOKEN_ENC, config.accessToken)
        val encControlPassword = if (config.controlPassword.isEmpty()) {
            ""
        } else {
            encryptSecret(KEY_CONTROL_PASSWORD_ENC, config.controlPassword)
        }
        val encAuthToken = if (config.authToken.isEmpty()) {
            ""
        } else {
            encryptSecret(KEY_AUTH_TOKEN_ENC, config.authToken)
        }
        val encUnlockPin = if (config.unlockPin.isEmpty()) {
            ""
        } else {
            encryptSecret(KEY_UNLOCK_PIN_ENC, config.unlockPin)
        }

        prefs.edit()
            .putString(KEY_DEVICE_ID, config.deviceId)
            .putString(KEY_DEVICE_NAME, config.deviceName)
            .putString(KEY_CONTROL_CODE, config.controlCode.trim())
            .putString(KEY_OWNER_USERNAME, config.ownerUsername.trim())
            .putBoolean(KEY_PENDING_UNBIND_OWNER, config.pendingUnbindOwner)
            .putString(KEY_API_BASE_URL, derivedApi)
            .putBoolean(KEY_RELAY_ENABLED, config.relayEnabled)
            .putString(KEY_RELAY_URL, trimmedRelay)
            .putBoolean(KEY_DIRECT_ENABLED, config.directEnabled)
            .putInt(KEY_DIRECT_PORT, config.directPort.coerceIn(1024, 65535))
            .putBoolean(KEY_AUTO_START, config.autoStart)
            .putBoolean(KEY_AUTO_ACCEPT_PROJECTION, config.autoAcceptProjection)
            .putBoolean(KEY_AUTO_ACCEPT_MIGRATED_V2, true)
            .putBoolean(KEY_BLACK_SCREEN_MODE, config.blackScreenMode)
            .putBoolean(KEY_FORCE_PORTRAIT, config.forcePortrait)
            .putString(KEY_DEVICE_SECRET_ENC, encDeviceSecret)
            .putString(KEY_ACCESS_TOKEN_ENC, encAccessToken)
            .putString(KEY_CONTROL_PASSWORD_ENC, encControlPassword)
            .putString(KEY_AUTH_TOKEN_ENC, encAuthToken)
            .putString(KEY_UNLOCK_PIN_ENC, encUnlockPin)
            .apply()
    }

    private fun getOrCreateMasterKey(): SecretKey {
        return try {
            val ks = KeyStore.getInstance(KEYSTORE_PROVIDER).apply { load(null) }
            val existing = ks.getKey(KEY_ALIAS, null) as? SecretKey
            if (existing != null) return existing

            val keyGen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE_PROVIDER)
            val spec = KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
            keyGen.init(spec)
            keyGen.generateKey()
        } catch (t: Throwable) {
            Log.e(TAG, "AndroidKeyStore unavailable; failing closed instead of plaintext storage", t)
            throw KeyStoreUnavailableException("AndroidKeyStore unavailable", t)
        }
    }

    private fun encryptSecret(prefKey: String, plaintext: String): String {
        if (plaintext.isEmpty()) return ""
        val key = getOrCreateMasterKey()
        return try {
            val cipher = Cipher.getInstance(AES_GCM_TRANSFORMATION)
            cipher.init(Cipher.ENCRYPT_MODE, key)
            cipher.updateAAD(prefKey.toByteArray(Charsets.UTF_8))
            val iv = cipher.iv
            val ciphertext = cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))
            val ivB64 = Base64.encodeToString(iv, Base64.NO_WRAP)
            val ctB64 = Base64.encodeToString(ciphertext, Base64.NO_WRAP)
            "$ENC_V2_PREFIX$ivB64:$ctB64"
        } catch (t: Throwable) {
            Log.e(TAG, "AES-GCM encrypt failed for $prefKey; failing closed", t)
            throw KeyStoreUnavailableException("AES-GCM encrypt failed for $prefKey", t)
        }
    }

    private fun readSecret(prefKey: String): SecretReadResult {
        val raw = prefs.getString(prefKey, null) ?: return SecretReadResult.Missing
        if (raw.isEmpty()) return SecretReadResult.Empty

        return when {
            raw.startsWith(ENC_V2_PREFIX) -> {
                val body = raw.removePrefix(ENC_V2_PREFIX)
                val parts = body.split(":", limit = 2)
                if (parts.size != 2) {
                    throw KeyStoreUnavailableException("Corrupted ciphertext format for $prefKey")
                }
                val key = getOrCreateMasterKey()
                try {
                    val iv = Base64.decode(parts[0], Base64.NO_WRAP)
                    val ct = Base64.decode(parts[1], Base64.NO_WRAP)
                    val cipher = Cipher.getInstance(AES_GCM_TRANSFORMATION)
                    cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, iv))
                    cipher.updateAAD(prefKey.toByteArray(Charsets.UTF_8))
                    val plain = String(cipher.doFinal(ct), Charsets.UTF_8)
                    SecretReadResult.Decrypted(plain, needsMigration = false)
                } catch (t: Throwable) {
                    Log.e(TAG, "AES-GCM (AAD) decrypt failed for $prefKey; refusing to overwrite secret", t)
                    throw KeyStoreUnavailableException("AES-GCM decrypt failed for $prefKey", t)
                }
            }

            raw.startsWith(ENC_V1_PREFIX) -> {
                val body = raw.removePrefix(ENC_V1_PREFIX)
                val parts = body.split(":", limit = 2)
                if (parts.size != 2) {
                    throw KeyStoreUnavailableException("Corrupted legacy ciphertext format for $prefKey")
                }
                val key = getOrCreateMasterKey()
                try {
                    val iv = Base64.decode(parts[0], Base64.NO_WRAP)
                    val ct = Base64.decode(parts[1], Base64.NO_WRAP)
                    val cipher = Cipher.getInstance(AES_GCM_TRANSFORMATION)
                    cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, iv))
                    val plain = String(cipher.doFinal(ct), Charsets.UTF_8)
                    // Transparently migrate legacy v1 ciphertext to AAD-bound gcm2:
                    SecretReadResult.Decrypted(plain, needsMigration = true)
                } catch (t: Throwable) {
                    Log.e(TAG, "Legacy AES-GCM decrypt failed for $prefKey; refusing to overwrite secret", t)
                    throw KeyStoreUnavailableException("Legacy AES-GCM decrypt failed for $prefKey", t)
                }
            }

            raw.startsWith(PLAIN_PREFIX) -> {
                // One-time read + transparent migration to KeyStore AES-GCM (never written again)
                try {
                    val bytes = Base64.decode(raw.removePrefix(PLAIN_PREFIX), Base64.NO_WRAP)
                    SecretReadResult.Decrypted(String(bytes, Charsets.UTF_8), needsMigration = true)
                } catch (t: Throwable) {
                    throw KeyStoreUnavailableException("Failed to decode legacy b64 secret for $prefKey", t)
                }
            }

            else -> SecretReadResult.Decrypted(raw, needsMigration = true)
        }
    }

    private fun generateRandomHex(numBytes: Int): String {
        val bytes = ByteArray(numBytes)
        random.nextBytes(bytes)
        return bytes.joinToString("") { "%02x".format(it) }
    }

    private fun generateRandomToken(length: Int): String {
        val alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"
        return buildString(length) {
            repeat(length) {
                append(alphabet[random.nextInt(alphabet.length)])
            }
        }
    }

    companion object {
        private const val TAG = "AgentConfigStore"
        private const val PREFS_NAME = "velodeck_agent_prefs"
        private const val KEYSTORE_PROVIDER = "AndroidKeyStore"
        private const val KEY_ALIAS = "velodeck_agent_master_key_v1"
        private const val AES_GCM_TRANSFORMATION = "AES/GCM/NoPadding"
        private const val ENC_V2_PREFIX = "gcm2:"
        private const val ENC_V1_PREFIX = "gcm:"
        private const val PLAIN_PREFIX = "b64:"
        private const val LEGACY_PLACEHOLDER_RELAY_URL = "wss://your-relay.example.com/ws"

        /** 32-character unambiguous uppercase alphanumeric alphabet (excludes 0/O/1/I; ~50 bits at length 10). */
        const val UNAMBIGUOUS_PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
        const val DEFAULT_CONTROL_PASSWORD_LENGTH = 10
        const val MIN_CONTROL_PASSWORD_LENGTH = 8
        const val MAX_CONTROL_PASSWORD_LENGTH = 32

        const val DEFAULT_DIRECT_PORT = 8765
        val DEFAULT_RELAY_URL: String = BuildConfig.DEFAULT_RELAY_URL
        val DEFAULT_API_BASE_URL: String = BuildConfig.DEFAULT_API_BASE_URL

        private const val KEY_DEVICE_ID = "device_id"
        private const val KEY_DEVICE_SECRET_ENC = "device_secret_enc"
        private const val KEY_ACCESS_TOKEN_ENC = "access_token_enc"
        private const val KEY_CONTROL_PASSWORD_ENC = "control_password_enc"
        private const val KEY_CONTROL_CODE = "control_code"
        private const val KEY_AUTH_TOKEN_ENC = "auth_token_enc"
        private const val KEY_OWNER_USERNAME = "owner_username"
        private const val KEY_PENDING_UNBIND_OWNER = "pending_unbind_owner"
        private const val KEY_API_BASE_URL = "api_base_url"
        private const val KEY_DEVICE_NAME = "device_name"
        private const val KEY_RELAY_ENABLED = "relay_enabled"
        private const val KEY_RELAY_URL = "relay_url"
        private const val KEY_DIRECT_ENABLED = "direct_enabled"
        private const val KEY_DIRECT_PORT = "direct_port"
        private const val KEY_AUTO_START = "auto_start"
        private const val KEY_AUTO_ACCEPT_PROJECTION = "auto_accept_projection"
        private const val KEY_AUTO_ACCEPT_MIGRATED_V2 = "auto_accept_migrated_v2"
        private const val KEY_BLACK_SCREEN_MODE = "black_screen_mode"
        private const val KEY_FORCE_PORTRAIT = "force_portrait"
        private const val KEY_UNLOCK_PIN_ENC = "unlock_pin_enc"

        fun generateControlPassword(
            length: Int = DEFAULT_CONTROL_PASSWORD_LENGTH,
            random: SecureRandom = SecureRandom(),
        ): String {
            val safeLen = length.coerceIn(MIN_CONTROL_PASSWORD_LENGTH, MAX_CONTROL_PASSWORD_LENGTH)
            return buildString(safeLen) {
                repeat(safeLen) {
                    append(UNAMBIGUOUS_PASSWORD_ALPHABET[random.nextInt(UNAMBIGUOUS_PASSWORD_ALPHABET.length)])
                }
            }
        }

        fun isValidControlPassword(candidate: String): Boolean {
            val trimmed = candidate.trim()
            return trimmed.length in MIN_CONTROL_PASSWORD_LENGTH..MAX_CONTROL_PASSWORD_LENGTH
        }

        /**
         * Derives the HTTP(S) API base URL from a Relay WebSocket URL:
         * - `ws://203.0.113.10/ws` -> `http://203.0.113.10`
         * - `wss://remote.example.com/ws` -> `https://remote.example.com`
         * - `wss://remote.example.com:8443/sub/ws` -> `https://remote.example.com:8443/sub`
         */
        fun deriveApiBaseFromRelayUrl(
            relayUrl: String,
            fallback: String = DEFAULT_API_BASE_URL,
        ): String {
            val trimmed = relayUrl.trim()
            if (trimmed.isEmpty()) return fallback.trimEnd('/')
            return try {
                val uri = URI(trimmed)
                val rawScheme = uri.scheme?.lowercase() ?: return fallback.trimEnd('/')
                val httpScheme = when (rawScheme) {
                    "wss", "https" -> "https"
                    "ws", "http" -> "http"
                    else -> return fallback.trimEnd('/')
                }
                val authority = uri.rawAuthority?.takeIf { it.isNotBlank() } ?: return fallback.trimEnd('/')
                var path = uri.rawPath.orEmpty().trimEnd('/')
                if (path == "/ws") {
                    path = ""
                } else if (path.endsWith("/ws")) {
                    path = path.removeSuffix("/ws")
                }
                "$httpScheme://$authority$path"
            } catch (_: Throwable) {
                fallback.trimEnd('/')
            }
        }

        fun constantTimeEquals(a: String, b: String): Boolean {
            return MessageDigest.isEqual(
                a.toByteArray(Charsets.UTF_8),
                b.toByteArray(Charsets.UTF_8),
            )
        }

        @Volatile
        private var instance: AgentConfigStore? = null

        fun getInstance(context: Context): AgentConfigStore {
            return instance ?: synchronized(this) {
                instance ?: AgentConfigStore(context).also { instance = it }
            }
        }
    }
}
