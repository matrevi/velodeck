package com.velodeck.agent.network

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.util.concurrent.TimeUnit

data class AuthResult(
    val token: String,
    val userId: String,
    val username: String,
    val displayName: String,
)

data class ServerInfo(
    val version: String,
    val hasAndroidApk: Boolean,
    val requiresInviteCode: Boolean,
)

/**
 * Lightweight OkHttp client for VeloDeck cloud account authentication (`/api/info`,
 * `/api/auth/login`, `/api/auth/register`, `/api/devices/unbind`).
 */
class AccountApiClient(
    private val httpClient: OkHttpClient = defaultHttpClient(),
) {

    suspend fun fetchServerInfo(apiBaseUrl: String): Result<ServerInfo> = withContext(Dispatchers.IO) {
        val base = apiBaseUrl.trim().trimEnd('/')
        if (!base.startsWith("http://") && !base.startsWith("https://")) {
            return@withContext Result.failure(IllegalArgumentException("服务器地址格式无效：$base"))
        }

        val request = Request.Builder()
            .url("$base/api/info")
            .get()
            .header("Accept", "application/json")
            .build()

        try {
            httpClient.newCall(request).execute().use { response ->
                val rawBody = response.body?.string().orEmpty()
                parseServerInfoResponse(response.code, rawBody)
            }
        } catch (e: IOException) {
            Result.failure(e)
        } catch (t: Throwable) {
            Result.failure(t)
        }
    }

    suspend fun login(
        apiBaseUrl: String,
        username: String,
        password: String,
    ): Result<AuthResult> {
        val cleanUser = username.trim()
        if (cleanUser.length !in MIN_USERNAME_LENGTH..MAX_USERNAME_LENGTH) {
            return Result.failure(IllegalArgumentException("用户名长度需为 $MIN_USERNAME_LENGTH–$MAX_USERNAME_LENGTH 位"))
        }
        if (password.isEmpty()) {
            return Result.failure(IllegalArgumentException("请输入密码"))
        }
        val payload = JSONObject().apply {
            put("username", cleanUser)
            put("password", password)
        }
        return postAuth(apiBaseUrl, "/api/auth/login", payload, cleanUser)
    }

    suspend fun register(
        apiBaseUrl: String,
        username: String,
        password: String,
        displayName: String? = null,
        inviteCode: String? = null,
    ): Result<AuthResult> {
        val cleanUser = username.trim()
        if (cleanUser.length !in MIN_USERNAME_LENGTH..MAX_USERNAME_LENGTH) {
            return Result.failure(IllegalArgumentException("用户名长度需为 $MIN_USERNAME_LENGTH–$MAX_USERNAME_LENGTH 个字符"))
        }
        if (password.length < MIN_PASSWORD_LENGTH) {
            return Result.failure(IllegalArgumentException("密码至少需要 $MIN_PASSWORD_LENGTH 位"))
        }
        val payload = JSONObject().apply {
            put("username", cleanUser)
            put("password", password)
            displayName?.trim()?.takeIf { it.isNotEmpty() }?.let { put("displayName", it) }
            inviteCode?.trim()?.takeIf { it.isNotEmpty() }?.let { put("inviteCode", it) }
        }
        return postAuth(apiBaseUrl, "/api/auth/register", payload, cleanUser)
    }

    suspend fun unbindDevice(
        apiBaseUrl: String,
        authToken: String,
        deviceId: String,
    ): Result<Unit> = withContext(Dispatchers.IO) {
        val base = apiBaseUrl.trim().trimEnd('/')
        if (!base.startsWith("http://") && !base.startsWith("https://")) {
            return@withContext Result.failure(IllegalArgumentException("服务器地址格式无效：$base"))
        }
        val cleanToken = authToken.trim()
        val cleanDeviceId = deviceId.trim()
        if (cleanToken.isEmpty() || cleanDeviceId.isEmpty()) {
            return@withContext Result.failure(IllegalArgumentException("缺少解绑所需凭证或设备 ID"))
        }

        val payload = JSONObject().apply {
            put("deviceId", cleanDeviceId)
        }
        val request = Request.Builder()
            .url("$base/api/devices/unbind")
            .post(payload.toString().toRequestBody(JSON_MEDIA_TYPE))
            .header("Accept", "application/json")
            .header("Authorization", "Bearer $cleanToken")
            .build()

        try {
            httpClient.newCall(request).execute().use { response ->
                if (response.code in 200..299 || response.code == 404) {
                    Result.success(Unit)
                } else {
                    Result.failure(IOException("解绑设备失败 (HTTP ${response.code})"))
                }
            }
        } catch (t: Throwable) {
            Result.failure(t)
        }
    }

    private suspend fun postAuth(
        apiBaseUrl: String,
        endpoint: String,
        payload: JSONObject,
        fallbackUsername: String,
    ): Result<AuthResult> = withContext(Dispatchers.IO) {
        val base = apiBaseUrl.trim().trimEnd('/')
        if (!base.startsWith("http://") && !base.startsWith("https://")) {
            return@withContext Result.failure(IllegalArgumentException("服务器地址格式无效：$base"))
        }

        val url = "$base$endpoint"
        val body = payload.toString().toRequestBody(JSON_MEDIA_TYPE)
        val request = Request.Builder()
            .url(url)
            .post(body)
            .header("Accept", "application/json")
            .build()

        try {
            httpClient.newCall(request).execute().use { response ->
                val rawBody = response.body?.string().orEmpty()
                parseAuthResponse(
                    statusCode = response.code,
                    responseBody = rawBody,
                    fallbackUsername = fallbackUsername,
                )
            }
        } catch (_: SocketTimeoutException) {
            Result.failure(IOException("连接服务器超时，请检查网络状态"))
        } catch (_: UnknownHostException) {
            Result.failure(IOException("无法解析服务器地址，请检查网络或中继设置"))
        } catch (_: ConnectException) {
            Result.failure(IOException("无法连接到服务器 ($base)，请确认服务器已启动"))
        } catch (e: IOException) {
            Result.failure(IOException("网络请求失败：${e.message ?: "请检查网络连接"}"))
        } catch (t: Throwable) {
            Result.failure(IllegalStateException("请求异常：${t.message ?: "未知错误"}"))
        }
    }

    companion object {
        const val MIN_USERNAME_LENGTH = 3
        const val MAX_USERNAME_LENGTH = 32
        const val MIN_PASSWORD_LENGTH = 8

        private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()

        private fun defaultHttpClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(15, TimeUnit.SECONDS)
            .writeTimeout(15, TimeUnit.SECONDS)
            .build()

        fun parseServerInfoResponse(statusCode: Int, responseBody: String): Result<ServerInfo> {
            if (statusCode !in 200..299) {
                return Result.failure(IOException("获取服务器信息失败 (HTTP $statusCode)"))
            }
            val json = try {
                if (responseBody.isNotBlank()) JSONObject(responseBody) else null
            } catch (_: Throwable) {
                null
            } ?: return Result.failure(IllegalStateException("服务器信息格式异常"))

            val requiresInvite = json.optBoolean("requiresInviteCode", false) ||
                json.optBoolean("requireInviteCode", false) ||
                json.optBoolean("inviteRequired", false) ||
                json.optBoolean("registrationInviteRequired", false) ||
                json.optString("registrationMode").equals("invite", ignoreCase = true)

            return Result.success(
                ServerInfo(
                    version = json.optString("version"),
                    hasAndroidApk = json.optBoolean("hasAndroidApk", false),
                    requiresInviteCode = requiresInvite,
                ),
            )
        }

        /**
         * Parses both nested (`{ ok, token, user: { userId, username, displayName } }`) and
         * flat (`{ token, userId, username, displayName }`) server responses and maps HTTP
         * error codes to clear Chinese user-facing messages.
         */
        fun parseAuthResponse(
            statusCode: Int,
            responseBody: String,
            fallbackUsername: String,
        ): Result<AuthResult> {
            val json = try {
                if (responseBody.isNotBlank()) JSONObject(responseBody) else null
            } catch (_: Throwable) {
                null
            }

            if (statusCode in 200..299) {
                if (json == null) {
                    return Result.failure(IllegalStateException("服务器返回数据格式异常"))
                }
                val token = json.optString("token").ifBlank { json.optString("authToken") }
                if (token.isBlank()) {
                    return Result.failure(IllegalStateException("服务器未返回有效的登录凭证"))
                }
                val userObj = json.optJSONObject("user")
                val userId = userObj?.optString("userId")?.ifBlank { userObj.optString("id") }
                    ?.ifBlank { null }
                    ?: json.optString("userId").ifBlank { json.optString("id") }
                val username = userObj?.optString("username")?.ifBlank { null }
                    ?: json.optString("username").ifBlank { fallbackUsername }
                val displayName = userObj?.optString("displayName")?.ifBlank { null }
                    ?: json.optString("displayName").ifBlank { username }
                return Result.success(
                    AuthResult(
                        token = token,
                        userId = userId,
                        username = username,
                        displayName = displayName,
                    ),
                )
            }

            val serverError = json?.let {
                it.optString("error").ifBlank { it.optString("message") }
            }.orEmpty().trim()

            val friendlyMessage = when (statusCode) {
                400 -> mapBadRequestError(serverError)
                401 -> mapUnauthorizedError(serverError)
                403 -> mapForbiddenError(serverError)
                409 -> "该用户名已被注册，请直接登录或更换用户名"
                429 -> "操作过于频繁，请稍后再试"
                in 500..599 -> "服务器暂时异常 (HTTP $statusCode)，请稍后重试"
                else -> serverError.ifEmpty { "请求失败 (HTTP $statusCode)" }
            }
            return Result.failure(IllegalStateException(friendlyMessage))
        }

        private fun mapBadRequestError(serverError: String): String {
            if (serverError.isEmpty()) return "输入格式有误，请检查用户名和密码"
            if (containsChinese(serverError)) return serverError
            val lower = serverError.lowercase()
            return when {
                lower.contains("invite") -> "需要有效的邀请码才能注册"
                lower.contains("username") -> "用户名格式无效（需为 3–32 位字母、数字或 . _ @ -）"
                lower.contains("password") -> "密码格式无效或长度不足（至少 8 位）"
                else -> "请求参数无效：$serverError"
            }
        }

        private fun mapUnauthorizedError(serverError: String): String {
            if (serverError.isNotEmpty() && containsChinese(serverError)) return serverError
            return "用户名或密码错误，请检查后重试"
        }

        private fun mapForbiddenError(serverError: String): String {
            if (serverError.isNotEmpty() && containsChinese(serverError)) return serverError
            return if (serverError.lowercase().contains("invite")) {
                "邀请码无效或已过期，请核对后重试"
            } else {
                "当前服务器暂未开放注册或邀请码无效"
            }
        }

        private fun containsChinese(text: String): Boolean =
            text.any { it in '\u4E00'..'\u9FFF' }
    }
}
