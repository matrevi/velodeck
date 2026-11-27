package com.velodeck.agent.ui

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.ComponentName
import android.content.Context
import android.content.DialogInterface
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PersistableBundle
import android.provider.Settings
import android.text.InputType
import android.view.LayoutInflater
import android.view.View
import android.view.WindowManager
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.google.android.material.button.MaterialButton
import com.google.android.material.button.MaterialButtonToggleGroup
import com.velodeck.agent.R
import com.velodeck.agent.capture.ProjectionConsentActivity
import com.velodeck.agent.databinding.ActivityMainBinding
import com.velodeck.agent.input.VeloDeckAccessibilityService
import com.velodeck.agent.network.AccountApiClient
import com.velodeck.agent.network.NetworkUtils
import com.velodeck.agent.network.RelayConnectionState
import com.velodeck.agent.protocol.ProtocolCodec
import com.velodeck.agent.service.AgentForegroundService
import com.velodeck.agent.service.AgentRuntimeState
import com.velodeck.agent.service.PersistenceGuard
import com.velodeck.agent.service.PowerHelper
import com.velodeck.agent.storage.AgentConfig
import com.velodeck.agent.storage.AgentConfigStore
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private lateinit var configStore: AgentConfigStore
    private val accountApiClient = AccountApiClient()

    private var advancedExpanded = false
    private var controlPasswordVisible = false
    private var pendingProjectionAfterNotif = false
    private var guidedSetupActive = false
    private var guidedNotifPrompted = false
    private var guidedBatteryPrompted = false
    private var guidedProjectionPrompted = false
    private var clipboardClearJob: Job? = null

    private val notifPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        refreshWizardState()
        if (!granted) {
            Toast.makeText(this, "未授予通知权限，前台保活状态栏将不可见", Toast.LENGTH_SHORT).show()
        }
        if (guidedSetupActive) {
            guidedNotifPrompted = true
            advanceGuidedSetup()
            return@registerForActivityResult
        }
        if (pendingProjectionAfterNotif) {
            pendingProjectionAfterNotif = false
            launchProjectionConsent()
        }
    }

    private val batteryOptLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) {
        refreshWizardState()
        if (guidedSetupActive) {
            guidedBatteryPrompted = true
            advanceGuidedSetup()
        }
    }

    private val projectionConsentLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        refreshWizardState()
        if (guidedSetupActive) {
            guidedProjectionPrompted = true
            if (result.resultCode == Activity.RESULT_OK) {
                // Give service a brief moment to flip hasProjection before next step
                lifecycleScope.launch {
                    delay(200L)
                    refreshWizardState()
                    advanceGuidedSetup()
                }
            } else {
                guidedSetupActive = false
                Toast.makeText(this, "已取消录屏授权，可随时再次点击一键开启", Toast.LENGTH_SHORT).show()
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)
        updateWindowSecurityFlag()

        WindowInsetsControllerCompat(window, window.decorView).apply {
            isAppearanceLightStatusBars = true
            isAppearanceLightNavigationBars = true
        }
        val shellBaseTop = binding.topShellBar.paddingTop
        val baseLeft = binding.mainContent.paddingLeft
        val baseTop = binding.mainContent.paddingTop
        val baseRight = binding.mainContent.paddingRight
        val baseBottom = binding.mainContent.paddingBottom
        ViewCompat.setOnApplyWindowInsetsListener(binding.rootContainer) { _, windowInsets ->
            val topBars = windowInsets.getInsets(
                WindowInsetsCompat.Type.statusBars() or WindowInsetsCompat.Type.displayCutout(),
            )
            val bottomBars = windowInsets.getInsets(
                WindowInsetsCompat.Type.navigationBars() or WindowInsetsCompat.Type.ime(),
            )
            binding.topShellBar.setPadding(
                binding.topShellBar.paddingLeft,
                shellBaseTop + topBars.top,
                binding.topShellBar.paddingRight,
                binding.topShellBar.paddingBottom,
            )
            binding.mainContent.setPadding(
                baseLeft + topBars.left,
                baseTop,
                baseRight + topBars.right,
                baseBottom + bottomBars.bottom,
            )
            windowInsets
        }

        configStore = AgentConfigStore.getInstance(this)
        PersistenceGuard.ensureAccessibilityEnabledIfPermitted(this)
        populateAdvancedFormFromConfig()
        bindInteractions()

        // Auto-start background service immediately on launch so the phone connects to the
        // built-in cloud server and obtains its 9-digit control code with zero extra clicks.
        if (!AgentForegroundService.isRunning.value) {
            try {
                AgentForegroundService.start(this)
            } catch (_: Throwable) {
            }
        }

        renderIdentityAndAccount(configStore.current, AgentForegroundService.runtimeState.value)
        refreshWizardState()

        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                launch {
                    AgentForegroundService.runtimeState.collect { state ->
                        renderRuntimeState(state)
                    }
                }
                launch {
                    configStore.configFlow.collect { cfg ->
                        renderIdentityAndAccount(cfg, AgentForegroundService.runtimeState.value)
                    }
                }
                launch {
                    VeloDeckAccessibilityService.connectedFlow.collect {
                        refreshWizardState()
                    }
                }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        refreshWizardState()
        renderEndpoints(AgentForegroundService.runtimeState.value)
    }

    private fun populateAdvancedFormFromConfig() {
        val cfg = configStore.current
        binding.tvDeviceId.text = "设备 ID: ${cfg.deviceId}"
        binding.etDeviceName.setText(cfg.deviceName)
        binding.etAccessToken.setText(cfg.accessToken)
        binding.switchRelayEnabled.isChecked = cfg.relayEnabled
        binding.etRelayUrl.setText(cfg.relayUrl)
        binding.switchDirectEnabled.isChecked = cfg.directEnabled
        binding.etDirectPort.setText(cfg.directPort.toString())
        binding.etUnlockPin.setText(cfg.unlockPin)
        binding.switchAutoStart.isChecked = cfg.autoStart
        binding.switchAutoAccept.isChecked = cfg.autoAcceptProjection
        binding.switchBlackScreenMode.isChecked = cfg.blackScreenMode
        binding.switchForcePortrait.isChecked = cfg.forcePortrait

        val guide = RomKeepAliveHelper.getGuide(this)
        val shortBrand = guide.brandLabel.substringBefore(" (").substringBefore(" /")
        binding.tvRomGuideLabel.text = "${shortBrand} 自启动与后台保活设置"
    }

    private fun bindInteractions() {
        // Card 1: Control code (both code text and button copy cleanly), password icons, account row
        val copyCodeAction = View.OnClickListener {
            val rawCode = AgentForegroundService.runtimeState.value.controlCode
                .ifBlank { configStore.current.controlCode }
            val clean = ProtocolCodec.normalizeControlCode(rawCode)
            if (clean.isEmpty()) {
                Toast.makeText(this, "正在从云端获取控制码，请稍候...", Toast.LENGTH_SHORT).show()
                if (!AgentForegroundService.isRunning.value) {
                    AgentForegroundService.start(this)
                }
            } else {
                copyToClipboard("VeloDeck Control Code", clean, sensitive = false)
                Toast.makeText(
                    this,
                    "已复制设备代码：${ProtocolCodec.formatControlCode(clean)}",
                    Toast.LENGTH_SHORT,
                ).show()
            }
        }
        binding.btnCopyControlCode.setOnClickListener(copyCodeAction)
        binding.tvControlCode.setOnClickListener(copyCodeAction)

        binding.btnTogglePasswordVisibility.setOnClickListener {
            controlPasswordVisible = !controlPasswordVisible
            updateWindowSecurityFlag()
            renderControlPassword(configStore.current)
        }

        binding.btnCopyPassword.setOnClickListener {
            val pwd = configStore.current.controlPassword
            copyToClipboard("VeloDeck Control Password", pwd, sensitive = true)
            Toast.makeText(this, "已复制无人值守密码（30 秒后自动清除剪贴板）", Toast.LENGTH_SHORT).show()
        }

        binding.btnEditPassword.setOnClickListener {
            showEditPasswordDialog()
        }

        binding.accountUnboundContainer.setOnClickListener {
            showAccountAuthDialog()
        }
        binding.btnLoginRegister.setOnClickListener {
            showAccountAuthDialog()
        }

        binding.btnReloginAccount.setOnClickListener {
            showAccountAuthDialog()
        }

        binding.btnLogoutAccount.setOnClickListener {
            performAccountLogoutAndUnbind()
        }

        // Card 2: 3-Step Zero-PC Unattended Wizard
        binding.btnOneTapSetup.setOnClickListener {
            startOneTapGuidedSetup()
        }

        binding.rowStepAccessibility.setOnClickListener {
            if (VeloDeckAccessibilityService.connectedFlow.value) {
                Toast.makeText(this, "无障碍远程触控已开启", Toast.LENGTH_SHORT).show()
            } else {
                showAccessibilityGuideAndOpen()
            }
        }

        binding.rowStepBattery.setOnClickListener {
            requestBatteryOptimizationExemption()
        }

        binding.btnRomGuide.setOnClickListener {
            showRomKeepAliveDialog()
        }

        binding.btnGrantNotification.setOnClickListener {
            pendingProjectionAfterNotif = false
            requestNotificationsPermission()
        }

        binding.rowStepProjection.setOnClickListener {
            if (!AgentForegroundService.isRunning.value) {
                AgentForegroundService.start(this)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !isNotificationPermissionGranted()) {
                pendingProjectionAfterNotif = true
                notifPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
            } else {
                launchProjectionConsent()
            }
        }

        // Card 3: Black-Screen Running Mode (Disguised OLED Black Curtain + Power-Key Wake)
        binding.switchBlackScreenMode.setOnCheckedChangeListener { buttonView, isChecked ->
            if (!buttonView.isPressed) return@setOnCheckedChangeListener
            configStore.update { it.copy(blackScreenMode = isChecked) }
            if (isChecked) {
                applyOrStartService()
                Toast.makeText(
                    this,
                    "已启用伪装黑屏选项：点击「立即进入伪装黑屏」生效，按锁屏键随时打开",
                    Toast.LENGTH_LONG,
                ).show()
            } else {
                AgentForegroundService.exitBlackScreen(this)
                applyOrStartService()
                Toast.makeText(this, "已关闭伪装黑屏运行模式", Toast.LENGTH_SHORT).show()
            }
        }

        binding.btnEnterBlackScreenNow.setOnClickListener {
            val isCurrentlyBlack = AgentForegroundService.runtimeState.value.blackScreenActive
            if (isCurrentlyBlack) {
                AgentForegroundService.exitBlackScreen(this)
                Toast.makeText(this, "已退出伪装黑屏", Toast.LENGTH_SHORT).show()
            } else {
                if (!configStore.current.blackScreenMode) {
                    configStore.update { it.copy(blackScreenMode = true) }
                    binding.switchBlackScreenMode.isChecked = true
                }
                if (!AgentForegroundService.isRunning.value) {
                    AgentForegroundService.start(this)
                }
                Toast.makeText(this, "已进入伪装黑屏运行 · 按锁屏键立即打开", Toast.LENGTH_SHORT).show()
                AgentForegroundService.enterBlackScreen(this)
            }
        }

        binding.switchForcePortrait.setOnCheckedChangeListener { buttonView, isChecked ->
            if (!buttonView.isPressed) return@setOnCheckedChangeListener
            AgentForegroundService.setForcePortraitEnabled(this, isChecked)
            if (isChecked) {
                val msg = if (VeloDeckAccessibilityService.connectedFlow.value) {
                    "已开启全局强制竖屏锁定"
                } else {
                    "已开启强制竖屏（开启无障碍服务后全局生效）"
                }
                Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
            } else {
                Toast.makeText(this, "已关闭强制竖屏锁定", Toast.LENGTH_SHORT).show()
            }
        }

        // Card 4: Collapsible Advanced Settings
        binding.headerAdvanced.setOnClickListener {
            advancedExpanded = !advancedExpanded
            updateWindowSecurityFlag()
            binding.advancedContainer.visibility = if (advancedExpanded) View.VISIBLE else View.GONE
            binding.tvAdvancedToggle.text = if (advancedExpanded) "收起" else "展开"
            binding.ivAdvancedChevron.rotation = if (advancedExpanded) 90f else 0f
        }

        binding.btnResetRelayUrl.setOnClickListener {
            binding.etRelayUrl.setText(AgentConfigStore.DEFAULT_RELAY_URL)
            binding.switchRelayEnabled.isChecked = true
            Toast.makeText(this, "已恢复默认内置云端服务器，点击「保存并应用」生效", Toast.LENGTH_SHORT).show()
        }

        binding.btnRegenToken.setOnClickListener {
            val next = configStore.regenerateAccessToken()
            binding.etAccessToken.setText(next)
            applyOrStartService()
            Toast.makeText(this, "已重置直连 Access Token 并断开旧连接", Toast.LENGTH_SHORT).show()
        }

        binding.btnCopyToken.setOnClickListener {
            val token = binding.etAccessToken.text.toString().trim()
            copyToClipboard("VeloDeck Access Token", token, sensitive = true)
            Toast.makeText(this, "已复制直连 Access Token（30 秒后自动清除剪贴板）", Toast.LENGTH_SHORT).show()
        }

        binding.btnCopyDirectLink.setOnClickListener {
            val cfg = configStore.current
            val endpoints = NetworkUtils.detectEndpoints(cfg.directPort)
            val ip = endpoints.preferredIp
            if (ip == null) {
                Toast.makeText(this, "未检测到局域网或虚拟组网 IP 地址", Toast.LENGTH_SHORT).show()
            } else {
                val quickUrl = endpoints.buildQuickConnectWebUrl(ip, cfg.accessToken)
                copyToClipboard("VeloDeck Direct Link", quickUrl, sensitive = true)
                Toast.makeText(this, "已复制直连链接（30 秒后自动清除剪贴板）", Toast.LENGTH_SHORT).show()
            }
        }

        binding.btnSaveConfig.setOnClickListener {
            saveAdvancedFormToStore(applyRunning = true)
            Toast.makeText(this, "高级设置已保存并生效", Toast.LENGTH_SHORT).show()
        }

        binding.btnRestartService.setOnClickListener {
            saveAdvancedFormToStore(applyRunning = false)
            AgentForegroundService.stop(this)
            lifecycleScope.launch {
                delay(350L)
                AgentForegroundService.start(this@MainActivity)
            }
            Toast.makeText(this, "正在重启后台服务...", Toast.LENGTH_SHORT).show()
        }

        binding.btnToggleService.setOnClickListener {
            if (AgentForegroundService.isRunning.value) {
                AgentForegroundService.stop(this)
                Toast.makeText(this, "后台服务已停止", Toast.LENGTH_SHORT).show()
            } else {
                saveAdvancedFormToStore(applyRunning = false)
                AgentForegroundService.start(this)
                Toast.makeText(this, "后台服务已启动", Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun performAccountLogoutAndUnbind() {
        val cfg = configStore.current
        val oldAuthToken = cfg.authToken
        val deviceId = cfg.deviceId
        val apiBaseUrl = cfg.effectiveApiBaseUrl()

        binding.btnLogoutAccount.isEnabled = false
        lifecycleScope.launch {
            if (oldAuthToken.isNotBlank()) {
                // Best-effort HTTP unbind before clearing local token
                runCatching {
                    accountApiClient.unbindDevice(apiBaseUrl, oldAuthToken, deviceId)
                }
            }

            configStore.update {
                it.copy(
                    authToken = "",
                    ownerUsername = "",
                    pendingUnbindOwner = true,
                )
            }
            applyOrStartService()
            binding.btnLogoutAccount.isEnabled = true
            Toast.makeText(
                this@MainActivity,
                "已退出并解绑账号，仍可通过 9 位控制码与密码连接",
                Toast.LENGTH_SHORT,
            ).show()
        }
    }

    private fun updateWindowSecurityFlag() {
        // Only apply FLAG_SECURE when plaintext credentials are actively revealed on screen,
        // so normal remote-control connections while viewing the masked home screen aren't blacked out.
        if (controlPasswordVisible || advancedExpanded) {
            window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        } else {
            window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
        }
    }

    private fun launchProjectionConsent() {
        val intent = Intent(this, ProjectionConsentActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NO_ANIMATION)
        }
        projectionConsentLauncher.launch(intent)
    }

    private fun startOneTapGuidedSetup() {
        if (!AgentForegroundService.isRunning.value) {
            try {
                AgentForegroundService.start(this)
            } catch (_: Throwable) {
            }
        }
        guidedSetupActive = true
        guidedNotifPrompted = false
        guidedBatteryPrompted = false
        guidedProjectionPrompted = false
        advanceGuidedSetup()
    }

    private fun advanceGuidedSetup() {
        if (!guidedSetupActive) return

        // 1. Notification permission (direct 1-tap system dialog on Android 13+)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            !isNotificationPermissionGranted() &&
            !guidedNotifPrompted
        ) {
            guidedNotifPrompted = true
            notifPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
            return
        }

        // 2. Battery optimization exemption (direct 1-tap system dialog)
        if (!PowerHelper.isIgnoringBatteryOptimizations(this) && !guidedBatteryPrompted) {
            guidedBatteryPrompted = true
            requestBatteryOptimizationExemption()
            return
        }

        // 3. Persistent MediaProjection consent (direct 1-tap system dialog)
        if (!AgentForegroundService.runtimeState.value.hasProjection && !guidedProjectionPrompted) {
            guidedProjectionPrompted = true
            launchProjectionConsent()
            return
        }

        // 4. Accessibility service (the ONLY step Android requires toggling in Settings)
        guidedSetupActive = false
        if (!VeloDeckAccessibilityService.connectedFlow.value) {
            showAccessibilityGuideAndOpen()
        } else {
            refreshWizardState()
            Toast.makeText(this, "全部权限已就绪，随时可免确认远程控制", Toast.LENGTH_LONG).show()
        }
    }

    private fun showAccessibilityGuideAndOpen() {
        val guide = RomKeepAliveHelper.getGuide(this)
        AlertDialog.Builder(this)
            .setTitle("最后一步：开启无障碍（${guide.brandLabel}）")
            .setMessage(guide.accessibilityPathHint)
            .setPositiveButton("前往无障碍") { _, _ ->
                openAccessibilitySettingsWithHighlight()
            }
            .setNeutralButton("允许受限设置") { _, _ ->
                openAppDetailsForRestrictedSettings()
            }
            .setNegativeButton("稍后", null)
            .show()
    }

    private fun openAccessibilitySettingsWithHighlight() {
        val componentName = ComponentName(
            packageName,
            VeloDeckAccessibilityService::class.java.name,
        ).flattenToString()
        val intent = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).apply {
            val bundle = Bundle().apply {
                putString(":settings:fragment_args_key", componentName)
            }
            putExtra(":settings:fragment_args_key", componentName)
            putExtra(":settings:show_fragment_args", bundle)
        }
        try {
            startActivity(intent)
        } catch (_: Throwable) {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        }
    }

    private fun openAppDetailsForRestrictedSettings() {
        val intent = Intent(
            Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
            Uri.fromParts("package", packageName, null),
        )
        startActivity(intent)
        Toast.makeText(this, "请点右上角 ⋮ → 允许受限设置，然后返回开启无障碍", Toast.LENGTH_LONG).show()
    }

    private fun applyOrStartService() {
        if (AgentForegroundService.isRunning.value) {
            AgentForegroundService.applyConfig(this)
        } else {
            AgentForegroundService.start(this)
        }
    }

    private fun saveAdvancedFormToStore(applyRunning: Boolean) {
        val port = binding.etDirectPort.text.toString().trim().toIntOrNull()
            ?.coerceIn(1024, 65535)
            ?: AgentConfigStore.DEFAULT_DIRECT_PORT
        val token = binding.etAccessToken.text.toString().trim().ifEmpty { configStore.current.accessToken }
        val name = binding.etDeviceName.text.toString().trim().ifEmpty { configStore.current.deviceName }
        val relayUrl = binding.etRelayUrl.text.toString().trim().ifEmpty { AgentConfigStore.DEFAULT_RELAY_URL }
        val derivedApi = AgentConfigStore.deriveApiBaseFromRelayUrl(relayUrl)
        val pin = binding.etUnlockPin.text.toString().trim()

        configStore.update {
            it.copy(
                deviceName = name,
                accessToken = token,
                relayEnabled = binding.switchRelayEnabled.isChecked,
                relayUrl = relayUrl,
                apiBaseUrl = derivedApi,
                directEnabled = binding.switchDirectEnabled.isChecked,
                directPort = port,
                unlockPin = pin,
                autoStart = binding.switchAutoStart.isChecked,
                autoAcceptProjection = binding.switchAutoAccept.isChecked,
            )
        }

        if (applyRunning) {
            applyOrStartService()
        }
        renderEndpoints(AgentForegroundService.runtimeState.value)
    }

    private fun renderRuntimeState(state: AgentRuntimeState) {
        renderIdentityAndAccount(configStore.current, state)
        refreshWizardState()
        renderEndpoints(state)

        // Update service controls inside Advanced Settings
        val svcText = if (state.serviceRunning) "运行中" else "已停止"
        val rtcText = if (state.webrtcSupported) "WebRTC+WS" else "WS-JPEG"
        binding.tvServiceLiveMeta.text =
            "后台服务：$svcText · 传输：$rtcText · 活跃会话：${state.activeSessions}"

        if (state.serviceRunning) {
            binding.btnToggleService.text = "停止后台服务"
            binding.btnToggleService.setTextColor(getColor(R.color.status_err))
        } else {
            binding.btnToggleService.text = "启动后台服务"
            binding.btnToggleService.setTextColor(getColor(R.color.status_ok))
        }
    }

    private fun renderControlPassword(cfg: AgentConfig) {
        val pwd = cfg.controlPassword
        binding.tvControlPassword.text = when {
            pwd.isBlank() -> "未设置"
            controlPasswordVisible -> pwd
            else -> "•".repeat(pwd.length.coerceAtLeast(AgentConfigStore.DEFAULT_CONTROL_PASSWORD_LENGTH))
        }
        binding.btnTogglePasswordVisibility.setImageResource(
            if (controlPasswordVisible) R.drawable.ic_eye_off else R.drawable.ic_eye,
        )
    }

    private fun renderIdentityAndAccount(cfg: AgentConfig, state: AgentRuntimeState) {
        // Cloud connection status pill with crisp vector dot (zero raw Unicode emojis!)
        when {
            !state.serviceRunning || state.relayState == RelayConnectionState.DISABLED -> {
                binding.tvCloudStatusBadge.text = "未连接"
                binding.tvCloudStatusBadge.setBackgroundResource(R.drawable.bg_pill_err)
                binding.tvCloudStatusBadge.setTextColor(getColor(R.color.status_err))
                binding.tvCloudStatusBadge.setCompoundDrawablesRelativeWithIntrinsicBounds(R.drawable.ic_dot_err, 0, 0, 0)
                binding.tvCloudSubStatus.visibility = View.GONE
            }

            state.relayState == RelayConnectionState.CONNECTED -> {
                binding.tvCloudStatusBadge.text = "云端在线"
                binding.tvCloudStatusBadge.setBackgroundResource(R.drawable.bg_pill_ok)
                binding.tvCloudStatusBadge.setTextColor(getColor(R.color.status_ok))
                binding.tvCloudStatusBadge.setCompoundDrawablesRelativeWithIntrinsicBounds(R.drawable.ic_dot_ok, 0, 0, 0)
                if (state.activeSessions > 0) {
                    binding.tvCloudSubStatus.visibility = View.VISIBLE
                    binding.tvCloudSubStatus.setBackgroundResource(R.drawable.bg_banner_ok)
                    binding.tvCloudSubStatus.setTextColor(getColor(R.color.status_ok))
                    binding.tvCloudSubStatus.text = "当前有 ${state.activeSessions} 个远程控制会话进行中"
                } else {
                    binding.tvCloudSubStatus.visibility = View.GONE
                }
            }

            state.relayState == RelayConnectionState.AUTH_ERROR -> {
                binding.tvCloudStatusBadge.text = "鉴权异常"
                binding.tvCloudStatusBadge.setBackgroundResource(R.drawable.bg_pill_err)
                binding.tvCloudStatusBadge.setTextColor(getColor(R.color.status_err))
                binding.tvCloudStatusBadge.setCompoundDrawablesRelativeWithIntrinsicBounds(R.drawable.ic_dot_err, 0, 0, 0)
                binding.tvCloudSubStatus.visibility = View.VISIBLE
                binding.tvCloudSubStatus.setBackgroundResource(R.drawable.bg_pill_err)
                binding.tvCloudSubStatus.setTextColor(getColor(R.color.status_err))
                binding.tvCloudSubStatus.text =
                    state.relayMessage?.takeIf { it.isNotBlank() } ?: "账号登录已失效，请重新登录"
            }

            else -> {
                binding.tvCloudStatusBadge.text = "连接中"
                binding.tvCloudStatusBadge.setBackgroundResource(R.drawable.bg_pill_warn)
                binding.tvCloudStatusBadge.setTextColor(getColor(R.color.status_warn))
                binding.tvCloudStatusBadge.setCompoundDrawablesRelativeWithIntrinsicBounds(R.drawable.ic_dot_warn, 0, 0, 0)
                val reason = state.relayMessage?.takeIf { it.isNotBlank() }
                if (reason != null && state.relayState == RelayConnectionState.DISCONNECTED) {
                    binding.tvCloudSubStatus.visibility = View.VISIBLE
                    binding.tvCloudSubStatus.setBackgroundResource(R.drawable.bg_banner_info)
                    binding.tvCloudSubStatus.setTextColor(getColor(R.color.text_secondary))
                    binding.tvCloudSubStatus.text = "自动重连中：$reason"
                } else {
                    binding.tvCloudSubStatus.visibility = View.GONE
                }
            }
        }

        // Black-Screen running mode & Force-Portrait card state
        if (binding.switchBlackScreenMode.isChecked != cfg.blackScreenMode) {
            binding.switchBlackScreenMode.isChecked = cfg.blackScreenMode
        }
        if (binding.switchForcePortrait.isChecked != cfg.forcePortrait) {
            binding.switchForcePortrait.isChecked = cfg.forcePortrait
        }
        when {
            state.blackScreenActive -> {
                binding.tvBlackScreenStatus.text = "黑屏运行中"
                binding.tvBlackScreenStatus.setTextColor(getColor(R.color.status_ok))
                binding.tvEnterBlackScreenLabel.text = "退出伪装黑屏"
                binding.tvEnterBlackScreenLabel.setTextColor(getColor(R.color.status_err))
            }

            cfg.blackScreenMode -> {
                binding.tvBlackScreenStatus.text = "已开启待命"
                binding.tvBlackScreenStatus.setTextColor(getColor(R.color.accent_blue))
                binding.tvEnterBlackScreenLabel.text = "立即进入伪装黑屏"
                binding.tvEnterBlackScreenLabel.setTextColor(getColor(R.color.accent_blue))
            }

            else -> {
                binding.tvBlackScreenStatus.text = "未启用"
                binding.tvBlackScreenStatus.setTextColor(getColor(R.color.text_muted))
                binding.tvEnterBlackScreenLabel.text = "立即进入伪装黑屏"
                binding.tvEnterBlackScreenLabel.setTextColor(getColor(R.color.accent_blue))
            }
        }

        // 9-digit control code
        val codeRaw = state.controlCode.ifBlank { cfg.controlCode }
        val formattedCode = ProtocolCodec.formatControlCode(codeRaw)
        binding.tvControlCode.text = formattedCode.ifBlank { "获取中..." }

        // Unattended password (masked by default)
        renderControlPassword(cfg)

        // Account binding section
        val loggedIn = cfg.authToken.isNotBlank()
        if (loggedIn) {
            binding.accountUnboundContainer.visibility = View.GONE
            binding.accountBoundContainer.visibility = View.VISIBLE
            val displayUser = state.ownerUsername.ifBlank { cfg.ownerUsername }.ifBlank { "当前账号" }
            if (state.relayState == RelayConnectionState.AUTH_ERROR) {
                binding.tvBoundAccountChip.setTextColor(getColor(R.color.status_err))
                binding.tvBoundAccountChip.text = "$displayUser（登录已失效）"
                binding.btnReloginAccount.visibility = View.VISIBLE
            } else {
                binding.tvBoundAccountChip.setTextColor(getColor(R.color.text_primary))
                binding.tvBoundAccountChip.text = "$displayUser · 同账号免密直连"
                binding.btnReloginAccount.visibility = View.GONE
            }
        } else {
            binding.accountUnboundContainer.visibility = View.VISIBLE
            binding.accountBoundContainer.visibility = View.GONE
        }
    }

    private fun refreshWizardState() {
        val a11yOk = VeloDeckAccessibilityService.connectedFlow.value
        val battOk = PowerHelper.isIgnoringBatteryOptimizations(this)
        val projOk = AgentForegroundService.runtimeState.value.hasProjection
        val doneCount = listOf(a11yOk, battOk, projOk).count { it }

        if (doneCount == 3) {
            binding.tvWizardBanner.setTextColor(getColor(R.color.status_ok))
            binding.tvWizardBanner.text = if (PersistenceGuard.hasWriteSecureSettings(this)) {
                "长效守护已激活 · 3 / 3"
            } else {
                "全部就绪 · 3 / 3"
            }
            binding.oneTapContainer.visibility = View.GONE
        } else {
            binding.tvWizardBanner.setTextColor(getColor(R.color.text_muted))
            binding.tvWizardBanner.text = "已完成 $doneCount / 3"
            binding.oneTapContainer.visibility = View.VISIBLE
            binding.btnOneTapSetup.text = if (doneCount == 0) {
                "一键开启全部权限"
            } else {
                "一键开启剩余 ${3 - doneCount} 项权限"
            }
        }

        setBadge(
            binding.badgeStepAccessibility,
            if (a11yOk) "已开启" else "去开启",
            if (a11yOk) BadgeStyle.OK else BadgeStyle.WARN,
        )
        setBadge(
            binding.badgeStepBattery,
            if (battOk) "已开启" else "去开启",
            if (battOk) BadgeStyle.OK else BadgeStyle.WARN,
        )
        setBadge(
            binding.badgeStepProjection,
            if (projOk) "已授权" else "去授权",
            if (projOk) BadgeStyle.OK else BadgeStyle.WARN,
        )

        // Show subtle Android 13+ notification row only when missing
        val needNotif = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !isNotificationPermissionGranted()
        binding.rowNotificationBanner.visibility = if (needNotif) View.VISIBLE else View.GONE
    }

    private fun renderEndpoints(state: AgentRuntimeState) {
        val port = configStore.current.directPort
        val ep = if (state.serviceRunning) state.endpoints else NetworkUtils.detectEndpoints(port)

        binding.tvDetectedVpnIps.text = if (ep.vpnEndpoints.isNotEmpty()) {
            val summary = ep.vpnEndpoints.joinToString("\n") { v ->
                "${v.label}: http://${v.ip}:$port (ws://${v.ip}:$port/ws)"
            }
            "虚拟组网已检测：\n$summary"
        } else if (ep.tailscaleIp != null) {
            "Tailscale: http://${ep.tailscaleIp}:$port (ws://${ep.tailscaleIp}:$port/ws)"
        } else {
            "虚拟组网 (Tailscale/蒲公英/EasyTier/ZeroTier): 未检测到"
        }

        binding.tvDetectedLanIps.text = if (ep.lanIps.isNotEmpty()) {
            val ip = ep.lanIps.first()
            "局域网 LAN: http://$ip:$port (ws://$ip:$port/ws)"
        } else {
            "局域网 LAN: 未检测到内网 Wi-Fi IP"
        }
    }

    private fun showEditPasswordDialog() {
        val container = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            val padH = (20 * resources.displayMetrics.density).toInt()
            val padV = (12 * resources.displayMetrics.density).toInt()
            setPadding(padH, padV, padH, padV)
        }

        val hintText = TextView(this).apply {
            text = "设置 ${AgentConfigStore.MIN_CONTROL_PASSWORD_LENGTH}–${AgentConfigStore.MAX_CONTROL_PASSWORD_LENGTH} 位无人值守密码，修改后立即同步云端并断开旧连接"
            setTextColor(getColor(R.color.text_secondary))
            textSize = 13f
        }
        val input = EditText(this).apply {
            setText(configStore.current.controlPassword)
            setSelection(text.length)
            hint = "例如：K9M4P7X2QA"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
            setBackgroundResource(R.drawable.bg_input)
            setTextColor(getColor(R.color.text_primary))
            setHintTextColor(getColor(R.color.text_secondary))
            val pad = (12 * resources.displayMetrics.density).toInt()
            setPadding(pad, pad, pad, pad)
            val lp = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            )
            lp.topMargin = (10 * resources.displayMetrics.density).toInt()
            layoutParams = lp
        }
        container.addView(hintText)
        container.addView(input)

        val dialog = AlertDialog.Builder(this)
            .setTitle("修改无人值守密码")
            .setView(container)
            .setNeutralButton("随机 10 位", null)
            .setNegativeButton("取消", null)
            .setPositiveButton("保存并生效", null)
            .create()
        dialog.window?.addFlags(WindowManager.LayoutParams.FLAG_SECURE)

        dialog.setOnShowListener {
            dialog.getButton(DialogInterface.BUTTON_NEUTRAL).setOnClickListener {
                val next = configStore.generateRandomControlPassword(
                    AgentConfigStore.DEFAULT_CONTROL_PASSWORD_LENGTH,
                )
                input.setText(next)
                input.setSelection(next.length)
            }
            dialog.getButton(DialogInterface.BUTTON_POSITIVE).setOnClickListener {
                val candidate = input.text.toString().trim()
                if (!AgentConfigStore.isValidControlPassword(candidate)) {
                    Toast.makeText(
                        this,
                        "密码长度需在 ${AgentConfigStore.MIN_CONTROL_PASSWORD_LENGTH} 到 ${AgentConfigStore.MAX_CONTROL_PASSWORD_LENGTH} 位之间",
                        Toast.LENGTH_SHORT,
                    ).show()
                    return@setOnClickListener
                }
                configStore.update { it.copy(controlPassword = candidate) }
                applyOrStartService()
                dialog.dismiss()
                Toast.makeText(this, "无人值守密码已更新并同步", Toast.LENGTH_SHORT).show()
            }
        }
        dialog.show()
    }

    private fun showAccountAuthDialog() {
        val view = LayoutInflater.from(this).inflate(R.layout.dialog_account_auth, null)
        val toggleMode = view.findViewById<MaterialButtonToggleGroup>(R.id.toggleAuthMode)
        val etUsername = view.findViewById<EditText>(R.id.etAuthUsername)
        val etPassword = view.findViewById<EditText>(R.id.etAuthPassword)
        val rowDisplayName = view.findViewById<LinearLayout>(R.id.rowDisplayName)
        val etDisplayName = view.findViewById<EditText>(R.id.etAuthDisplayName)
        val rowInviteCode = view.findViewById<LinearLayout>(R.id.rowInviteCode)
        val etInviteCode = view.findViewById<EditText>(R.id.etAuthInviteCode)
        val tvServerHint = view.findViewById<TextView>(R.id.tvAuthServerHint)
        val tvError = view.findViewById<TextView>(R.id.tvAuthError)
        val progress = view.findViewById<ProgressBar>(R.id.progressAuth)
        val btnCancel = view.findViewById<MaterialButton>(R.id.btnAuthCancel)
        val btnSubmit = view.findViewById<MaterialButton>(R.id.btnAuthSubmit)

        val cfg = configStore.current
        val apiBaseUrl = cfg.effectiveApiBaseUrl()
        tvServerHint.text = "云端服务器：$apiBaseUrl"
        if (cfg.ownerUsername.isNotBlank()) {
            etUsername.setText(cfg.ownerUsername)
        }

        var isRegisterMode = false
        var serverRequiresInviteCode = false

        fun updateRegisterFieldsVisibility() {
            rowDisplayName.visibility = if (isRegisterMode) View.VISIBLE else View.GONE
            rowInviteCode.visibility = if (isRegisterMode && serverRequiresInviteCode) View.VISIBLE else View.GONE
        }

        // Probe /api/info asynchronously to check whether server requires an invite code
        lifecycleScope.launch {
            accountApiClient.fetchServerInfo(apiBaseUrl).onSuccess { info ->
                serverRequiresInviteCode = info.requiresInviteCode
                updateRegisterFieldsVisibility()
            }
        }

        toggleMode.addOnButtonCheckedListener { _, checkedId, isChecked ->
            if (!isChecked) return@addOnButtonCheckedListener
            isRegisterMode = checkedId == R.id.btnModeRegister
            updateRegisterFieldsVisibility()
            btnSubmit.text = if (isRegisterMode) "注册并绑定" else "登录并绑定"
            tvError.visibility = View.GONE
        }

        val dialog = AlertDialog.Builder(this)
            .setView(view)
            .setCancelable(true)
            .create()
        dialog.window?.addFlags(WindowManager.LayoutParams.FLAG_SECURE)

        btnCancel.setOnClickListener { dialog.dismiss() }

        btnSubmit.setOnClickListener {
            val username = etUsername.text.toString().trim()
            val password = etPassword.text.toString()
            val displayName = etDisplayName.text.toString().trim().ifEmpty { null }
            val inviteCode = etInviteCode.text.toString().trim().ifEmpty { null }

            if (username.length !in AccountApiClient.MIN_USERNAME_LENGTH..AccountApiClient.MAX_USERNAME_LENGTH) {
                tvError.text = "用户名长度需为 ${AccountApiClient.MIN_USERNAME_LENGTH}–${AccountApiClient.MAX_USERNAME_LENGTH} 位"
                tvError.visibility = View.VISIBLE
                return@setOnClickListener
            }
            if (isRegisterMode && password.length < AccountApiClient.MIN_PASSWORD_LENGTH) {
                tvError.text = "密码至少需要 ${AccountApiClient.MIN_PASSWORD_LENGTH} 位"
                tvError.visibility = View.VISIBLE
                return@setOnClickListener
            }
            if (!isRegisterMode && password.isEmpty()) {
                tvError.text = "请输入密码"
                tvError.visibility = View.VISIBLE
                return@setOnClickListener
            }
            if (isRegisterMode && serverRequiresInviteCode && inviteCode.isNullOrBlank()) {
                tvError.text = "请输入服务器注册邀请码"
                tvError.visibility = View.VISIBLE
                return@setOnClickListener
            }

            tvError.visibility = View.GONE
            progress.visibility = View.VISIBLE
            btnSubmit.isEnabled = false
            btnCancel.isEnabled = false

            lifecycleScope.launch {
                val result = if (isRegisterMode) {
                    accountApiClient.register(apiBaseUrl, username, password, displayName, inviteCode)
                } else {
                    accountApiClient.login(apiBaseUrl, username, password)
                }

                progress.visibility = View.GONE
                btnSubmit.isEnabled = true
                btnCancel.isEnabled = true

                result.onSuccess { auth ->
                    configStore.update { cur ->
                        cur.copy(
                            authToken = auth.token,
                            ownerUsername = auth.username,
                            pendingUnbindOwner = false,
                        )
                    }
                    applyOrStartService()
                    dialog.dismiss()
                    Toast.makeText(
                        this@MainActivity,
                        "已绑定账号：${auth.username}（同账号免密直连）",
                        Toast.LENGTH_LONG,
                    ).show()
                }.onFailure { err ->
                    val msg = err.message ?: "认证失败，请重试"
                    if (isRegisterMode && (msg.contains("邀请码") || msg.contains("invite", ignoreCase = true))) {
                        serverRequiresInviteCode = true
                        updateRegisterFieldsVisibility()
                    }
                    tvError.text = msg
                    tvError.visibility = View.VISIBLE
                }
            }
        }

        dialog.show()
    }

    private enum class BadgeStyle { OK, WARN, ERR }

    private fun setBadge(view: TextView, label: String, style: BadgeStyle) {
        view.text = label
        when (style) {
            BadgeStyle.OK -> {
                view.setBackgroundResource(R.drawable.bg_pill_ok)
                view.setTextColor(getColor(R.color.status_ok))
                view.setCompoundDrawablesRelativeWithIntrinsicBounds(R.drawable.ic_check_small, 0, 0, 0)
            }

            BadgeStyle.WARN -> {
                view.setBackgroundResource(R.drawable.bg_pill_warn)
                view.setTextColor(getColor(R.color.status_warn))
                view.setCompoundDrawablesRelativeWithIntrinsicBounds(0, 0, 0, 0)
            }

            BadgeStyle.ERR -> {
                view.setBackgroundResource(R.drawable.bg_pill_err)
                view.setTextColor(getColor(R.color.status_err))
                view.setCompoundDrawablesRelativeWithIntrinsicBounds(0, 0, 0, 0)
            }
        }
    }

    private fun isNotificationPermissionGranted(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true
        return ContextCompat.checkSelfPermission(
            this,
            Manifest.permission.POST_NOTIFICATIONS,
        ) == PackageManager.PERMISSION_GRANTED
    }

    private fun requestNotificationsPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !isNotificationPermissionGranted()) {
            notifPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            val intent = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
                putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
            }
            startActivity(intent)
        }
    }

    @SuppressLint("BatteryLife")
    private fun requestBatteryOptimizationExemption() {
        if (PowerHelper.isIgnoringBatteryOptimizations(this)) {
            Toast.makeText(this, "已开启后台长期运行（电池优化白名单）", Toast.LENGTH_SHORT).show()
            return
        }
        try {
            val intent = Intent(
                Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                Uri.parse("package:$packageName"),
            )
            batteryOptLauncher.launch(intent)
        } catch (_: Throwable) {
            batteryOptLauncher.launch(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
        }
    }

    private fun showRomKeepAliveDialog() {
        val guide = RomKeepAliveHelper.getGuide(this)
        AlertDialog.Builder(this)
            .setTitle("国产手机自启动 / 锁后台指南 · ${guide.brandLabel}")
            .setMessage(guide.steps)
            .setPositiveButton("前往系统设置") { _, _ ->
                RomKeepAliveHelper.openVendorKeepAliveSettings(this)
            }
            .setNegativeButton("我知道了", null)
            .show()
    }

    private fun copyToClipboard(label: String, text: String, sensitive: Boolean = false) {
        val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val clip = ClipData.newPlainText(label, text)
        if (sensitive && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            clip.description.extras = PersistableBundle().apply {
                putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true)
            }
        }
        cm.setPrimaryClip(clip)

        if (sensitive) {
            clipboardClearJob?.cancel()
            clipboardClearJob = lifecycleScope.launch {
                delay(SENSITIVE_CLIPBOARD_TTL_MS)
                try {
                    val currentText = cm.primaryClip?.takeIf { it.itemCount > 0 }
                        ?.getItemAt(0)?.text?.toString()
                    if (currentText == text) {
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                            cm.clearPrimaryClip()
                        } else {
                            cm.setPrimaryClip(ClipData.newPlainText("", ""))
                        }
                    }
                } catch (_: Throwable) {
                }
            }
        }
    }

    companion object {
        private const val SENSITIVE_CLIPBOARD_TTL_MS = 30_000L
    }
}
