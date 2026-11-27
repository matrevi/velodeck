#!/usr/bin/env bash
set -euo pipefail

# VeloDeck Android Agent — One-Time 10-Second Unattended ADB Setup Script
# Grants persistent MediaProjection AppOp, background execution exemptions,
# battery optimization whitelist, notification permission, and safely appends
# VeloDeckAccessibilityService without clearing existing accessibility services.

PKG="com.velodeck.agent"
ACCESSIBILITY_COMPONENT="${PKG}/${PKG}.input.VeloDeckAccessibilityService"
MAIN_ACTIVITY="${PKG}/.ui.MainActivity"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
RELEASE_APK="${ROOT_DIR}/android-agent/app/build/outputs/apk/release/app-release.apk"
DEBUG_APK="${ROOT_DIR}/android-agent/app/build/outputs/apk/debug/app-debug.apk"

SKIP_INSTALL=0
USE_DEBUG_APK=0
CUSTOM_APK=""
SERIAL=""

usage() {
  cat <<'EOF'
Usage: setup-android.sh [options]

Options:
  --skip-install       Skip APK installation (only apply ADB unattended permissions)
  --debug              Install debug APK (app-debug.apk) instead of signed release APK
  --apk <path>         Specify custom APK path to install
  -s, --serial <id>    Target a specific ADB device serial
  -h, --help           Show this help message
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-install)
      SKIP_INSTALL=1
      shift
      ;;
    --debug)
      USE_DEBUG_APK=1
      shift
      ;;
    --apk)
      CUSTOM_APK="${2:-}"
      shift 2
      ;;
    -s|--serial)
      SERIAL="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "❌ 未知参数: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -n "${CUSTOM_APK}" ]]; then
  APK_PATH="${CUSTOM_APK}"
elif [[ "${USE_DEBUG_APK}" -eq 1 ]]; then
  APK_PATH="${DEBUG_APK}"
elif [[ -f "${RELEASE_APK}" ]]; then
  APK_PATH="${RELEASE_APK}"
else
  APK_PATH="${RELEASE_APK}"
fi

locate_adb() {
  if command -v adb >/dev/null 2>&1; then
    command -v adb
    return 0
  fi
  local candidates=(
    "${HOME}/Library/Android/sdk/platform-tools/adb"
    "${ANDROID_HOME:-}/platform-tools/adb"
    "${ANDROID_SDK_ROOT:-}/platform-tools/adb"
    "/usr/local/bin/adb"
    "/opt/homebrew/bin/adb"
  )
  for c in "${candidates[@]}"; do
    if [[ -n "$c" && -x "$c" ]]; then
      echo "$c"
      return 0
    fi
  done
  return 1
}

ADB_BIN="$(locate_adb || true)"
if [[ -z "${ADB_BIN}" ]]; then
  echo "❌ 未找到 adb！请先安装 Android platform-tools 或将 adb 加入 PATH。" >&2
  exit 1
fi

adb_cmd() {
  if [[ -n "${SERIAL}" ]]; then
    "${ADB_BIN}" -s "${SERIAL}" "$@"
  else
    "${ADB_BIN}" "$@"
  fi
}

echo "🔌 使用 ADB: ${ADB_BIN}"
READY_DEVICES=()
while IFS= read -r line; do
  [[ -n "${line}" ]] && READY_DEVICES+=("${line}")
done < <("${ADB_BIN}" devices | awk 'NR>1 && $2=="device" {print $1}')

if [[ -n "${SERIAL}" ]]; then
  echo "📱 目标设备序列号: ${SERIAL}"
else
  if [[ ${#READY_DEVICES[@]} -eq 0 ]]; then
    echo "❌ 未检测到已授权的 Android 设备。" >&2
    echo "   请开启手机「USB 调试」，用数据线连接电脑并在手机上点击「允许 USB 调试」。" >&2
    "${ADB_BIN}" devices
    exit 1
  elif [[ ${#READY_DEVICES[@]} -gt 1 ]]; then
    echo "⚠️  检测到多台设备，请使用 -s <serial> 指定设备:" >&2
    printf '   - %s\n' "${READY_DEVICES[@]}" >&2
    exit 1
  fi
  SERIAL="${READY_DEVICES[0]}"
fi

MANUFACTURER="$(adb_cmd shell getprop ro.product.manufacturer | tr -d '\r\n')"
MODEL="$(adb_cmd shell getprop ro.product.model | tr -d '\r\n')"
ANDROID_VER="$(adb_cmd shell getprop ro.build.version.release | tr -d '\r\n')"
API_LEVEL="$(adb_cmd shell getprop ro.build.version.sdk | tr -d '\r\n')"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📱 已连接设备: ${MANUFACTURER} ${MODEL}"
echo "🤖 系统版本:   Android ${ANDROID_VER} (API ${API_LEVEL}) | 序列号: ${SERIAL}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [[ "${SKIP_INSTALL}" -eq 0 ]]; then
  if [[ -f "${APK_PATH}" ]]; then
    echo "📦 正在安装 APK: ${APK_PATH}"
    adb_cmd install -r -g "${APK_PATH}" || adb_cmd install -r "${APK_PATH}"
  else
    echo "ℹ️  未找到目标 APK (${APK_PATH})，跳过安装步骤。"
    echo "   如需编译正式签名 Release APK，请先运行: cd android-agent && ./gradlew assembleRelease"
    if [[ "${USE_DEBUG_APK}" -eq 0 && -f "${DEBUG_APK}" ]]; then
      echo "   （检测到本地 Debug APK，如需安装调试包请追加 --debug 参数）"
    fi
  fi
else
  echo "⏭️  已按要求跳过 APK 安装 (--skip-install)"
fi

if ! adb_cmd shell pm path "${PKG}" >/dev/null 2>&1; then
  echo "❌ 设备上尚未安装 ${PKG}，无法授予权限。请先安装 APK 后再运行本脚本。" >&2
  exit 1
fi

echo "🔐 正在授予 7×24 无人值守核心权限..."

# 1. Persistent MediaProjection AppOp (bypasses repeated system consent prompts on supported ROMs)
adb_cmd shell appops set "${PKG}" PROJECT_MEDIA allow || echo "⚠️  PROJECT_MEDIA 设置失败（部分 ROM 需手动首次确认）"

# 2. Background execution exemptions
adb_cmd shell appops set "${PKG}" RUN_IN_BACKGROUND allow || true
adb_cmd shell appops set "${PKG}" RUN_ANY_IN_BACKGROUND allow || true

# 3. Battery optimization (Doze) whitelist
adb_cmd shell dumpsys deviceidle whitelist "+${PKG}" || true

# 4. Runtime notification permission (Android 13+)
adb_cmd shell pm grant "${PKG}" android.permission.POST_NOTIFICATIONS 2>/dev/null || true

# 5. Safely append VeloDeckAccessibilityService without erasing existing enabled services
CURRENT_SERVICES="$(adb_cmd shell settings get secure enabled_accessibility_services | tr -d '\r\n')"
if [[ -z "${CURRENT_SERVICES}" || "${CURRENT_SERVICES}" == "null" ]]; then
  NEW_SERVICES="${ACCESSIBILITY_COMPONENT}"
elif [[ ":${CURRENT_SERVICES}:" == *":${ACCESSIBILITY_COMPONENT}:"* ]]; then
  NEW_SERVICES="${CURRENT_SERVICES}"
else
  NEW_SERVICES="${CURRENT_SERVICES}:${ACCESSIBILITY_COMPONENT}"
fi

adb_cmd shell settings put secure enabled_accessibility_services "${NEW_SERVICES}"
adb_cmd shell settings put secure accessibility_enabled 1

echo "✅ 权限配置完成："
echo "   • PROJECT_MEDIA          -> allow"
echo "   • RUN_(ANY_)IN_BACKGROUND -> allow"
echo "   • Doze 电池白名单          -> +${PKG}"
echo "   • 无障碍服务               -> 已安全追加并启用"

echo "🚀 正在启动 VeloDeck Agent..."
adb_cmd shell am start -n "${MAIN_ACTIVITY}" >/dev/null

echo ""
echo "🎉 一次性 ADB 配置完成！接下来只需在手机上："
echo "   1. 点击「持久化录屏授权」完成首次确认（此后全程保活，无需再次弹窗）"
echo "   2. 核对中继地址或直接复制局域网 / Tailscale 直连地址与访问令牌"
echo "   3. 若为小米/华为/OPPO/vivo 手机，建议按界面提示开启「自启动」并在最近任务中锁定卡片"
echo "   4. 拔掉数据线即可 7×24 小时无人值守远程控制！"
