package com.velodeck.agent.ui

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings

data class RomGuideInfo(
    val brandLabel: String,
    val steps: String,
    val accessibilityPathHint: String,
    val deepLinks: List<Intent>,
)

/**
 * Tailored 7x24 background keep-alive & AutoStart instructions and deep-link intents
 * for major Chinese & global Android OEM ROMs (Xiaomi/HyperOS, Huawei/Honor, OPPO/ColorOS,
 * vivo/OriginOS, Samsung/OneUI, and stock Android).
 */
object RomKeepAliveHelper {

    fun getGuide(context: Context): RomGuideInfo {
        val m = Build.MANUFACTURER.lowercase()
        val pkg = context.packageName

        return when {
            m.contains("xiaomi") || m.contains("redmi") || m.contains("poco") -> RomGuideInfo(
                brandLabel = "小米 / 红米 (MIUI / HyperOS)",
                steps = """
                    1. 点击下方按钮进入「自启动管理」，开启 极控 (VeloDeck) 自启动。
                    2. 进入「应用信息 → 省电策略」，选择「无限制」。
                    3. 打开多任务最近任务界面，长按 极控 (VeloDeck) 卡片并点击 🔒 锁定后台。
                    4. 回到应用完成 3 步向导，即可纯手机 7×24 无人值守运行，无需连接电脑。
                """.trimIndent(),
                accessibilityPathHint = """
                    点「前往无障碍」后按 2 步操作：
                    1. 点击「已下载的应用」
                    2. 找到「VeloDeck 极控无障碍控制」或「极控」并打开开关

                    若开关为灰色提示「受限设置」，请先点下方「允许受限设置」，在应用详情里开启后再回来打开。
                """.trimIndent(),
                deepLinks = listOf(
                    componentIntent("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity"),
                    componentIntent("com.miui.powerkeeper", "com.miui.powerkeeper.ui.HiddenAppsConfigActivity").apply {
                        putExtra("package_name", pkg)
                        putExtra("package_label", "极控")
                    },
                ),
            )

            m.contains("huawei") || m.contains("honor") -> RomGuideInfo(
                brandLabel = "华为 / 荣耀 (HarmonyOS / MagicOS)",
                steps = """
                    1. 进入「应用启动管理」，关闭 极控 (VeloDeck) 的「自动管理」。
                    2. 在弹出的手动管理中，同时开启：允许自启动、允许关联启动、允许后台活动。
                    3. 在电池设置中关闭「休眠时始终保持网络连接」的限制（保持常连）。
                    4. 在最近任务界面下滑 极控 (VeloDeck) 卡片并锁定。
                """.trimIndent(),
                accessibilityPathHint = """
                    点「前往无障碍」后按 2 步操作：
                    1. 点击「已安装的服务」
                    2. 找到「VeloDeck 极控无障碍控制」或「极控」并打开开关
                """.trimIndent(),
                deepLinks = listOf(
                    componentIntent("com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"),
                    componentIntent("com.huawei.systemmanager", "com.huawei.systemmanager.appcontrol.activity.StartupAppControlActivity"),
                    componentIntent("com.hihonor.systemmanager", "com.hihonor.systemmanager.startupmgr.ui.StartupNormalAppListActivity"),
                ),
            )

            m.contains("oppo") || m.contains("realme") || m.contains("oneplus") -> RomGuideInfo(
                brandLabel = "OPPO / 一加 / 真我 (ColorOS / OxygenOS)",
                steps = """
                    1. 进入「应用详情 → 耗电管理」，开启「允许完全后台行为」与「允许应用自启动」。
                    2. 在「电池 → 更多设置」中关闭睡眠待机优化。
                    3. 在最近任务界面点击 极控 (VeloDeck) 右上角菜单并选择「锁定」。
                """.trimIndent(),
                accessibilityPathHint = """
                    点「前往无障碍」后按 2 步操作：
                    1. 滑到页面底部「更多」，点「已下载的应用」
                    2. 点「VeloDeck 极控无障碍控制」→ 打开无障碍开关

                    若开关为灰色提示「受限设置」，点下方「允许受限设置」→ 点击右上角 ⋮ → 选择「允许受限设置」后再回来开启。
                """.trimIndent(),
                deepLinks = listOf(
                    componentIntent("com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity"),
                    componentIntent("com.oplus.battery", "com.oplus.powermanager.fuelgaue.PowerUsageModelActivity"),
                    componentIntent("com.coloros.safecenter", "com.coloros.safecenter.startupapp.StartupAppListActivity"),
                ),
            )

            m.contains("vivo") || m.contains("iqoo") -> RomGuideInfo(
                brandLabel = "vivo / iQOO (OriginOS / FuntouchOS)",
                steps = """
                    1. 进入「i管家 → 应用管理 → 权限管理 → 自启动」，开启 极控 (VeloDeck)。
                    2. 进入「电池 → 后台耗电管理」，将 极控 (VeloDeck) 设为「允许后台高耗电」。
                    3. 在最近任务下拉锁定 极控 (VeloDeck) 卡片。
                """.trimIndent(),
                accessibilityPathHint = """
                    点「前往无障碍」后按 2 步操作：
                    1. 滑到底部点「已下载的应用」
                    2. 找到「VeloDeck 极控无障碍控制」或「极控」并打开开关

                    若提示「受限设置」，请先点下方「允许受限设置」在应用详情右上角 ⋮ 开启。
                """.trimIndent(),
                deepLinks = listOf(
                    componentIntent("com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.AddWhiteListActivity"),
                    componentIntent("com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity"),
                    componentIntent("com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.BgStartUpManager"),
                ),
            )

            m.contains("samsung") -> RomGuideInfo(
                brandLabel = "三星 (One UI)",
                steps = """
                    1. 进入「应用信息 → 电池」，将电池使用设为「不受限制」。
                    2. 进入「设备维护 → 电池 → 后台使用限制」，将 极控 (VeloDeck) 加入「从不休眠的应用程序」。
                    3. 在最近任务中点击应用图标，选择「保持打开」。
                """.trimIndent(),
                accessibilityPathHint = """
                    点「前往无障碍」后按 2 步操作：
                    1. 点击「已安装的应用程序」
                    2. 找到「VeloDeck 极控无障碍控制」或「极控」并打开开关

                    若提示「受限设置」，点下方「允许受限设置」→ 右上角 ⋮ → 允许受限设置。
                """.trimIndent(),
                deepLinks = listOf(
                    componentIntent("com.samsung.android.lool", "com.samsung.android.sm.battery.ui.BatteryActivity"),
                    componentIntent("com.samsung.android.sm", "com.samsung.android.sm.ui.battery.BatteryActivity"),
                ),
            )

            else -> RomGuideInfo(
                brandLabel = "${Build.MANUFACTURER} (${Build.MODEL})",
                steps = """
                    1. 在「应用信息 → 电池」中选择「不受限制 (Unrestricted)」。
                    2. 确保已关闭系统省电模式或已将 极控 (VeloDeck) 加入后台白名单。
                    3. 回到应用完成 3 步开启向导，即可纯手机 7×24 无人值守运行。
                """.trimIndent(),
                accessibilityPathHint = """
                    点「前往无障碍」后按 2 步操作：
                    1. 点击「已下载的应用 / 已安装的应用」
                    2. 找到「VeloDeck 极控无障碍控制」或「极控」并打开开关

                    若提示「受限设置」，点下方「允许受限设置」→ 右上角 ⋮ → 允许受限设置。
                """.trimIndent(),
                deepLinks = emptyList(),
            )
        }
    }

    fun openVendorKeepAliveSettings(context: Context) {
        val guide = getGuide(context)
        for (intent in guide.deepLinks) {
            try {
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                context.startActivity(intent)
                return
            } catch (_: Throwable) {
            }
        }
        // Safe fallback: App Details Settings page
        val fallback = Intent(
            Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
            Uri.fromParts("package", context.packageName, null),
        ).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(fallback)
    }

    private fun componentIntent(pkg: String, cls: String): Intent =
        Intent().setComponent(ComponentName(pkg, cls))
}
