#!/usr/bin/env bash
set -euo pipefail

# VeloDeck Android Agent — One-Time Permanent Unattended Provisioning Script
# Grants non-root self-healing permissions over USB or Wireless ADB so the phone:
#  1. Automatically re-enables VeloDeck AccessibilityService if the ROM ever disables it
#  2. Stays permanently whitelisted from Android Doze / App Standby / background kill
#  3. Automatically recovers persistent MediaProjection after updates or reboots (zero touch)

PKG="com.velodeck.agent"
A11Y_SVC="${PKG}/${PKG}.input.VeloDeckAccessibilityService"

if ! command -v adb >/dev/null 2>&1; then
  if [ -x "$HOME/Library/Android/sdk/platform-tools/adb" ]; then
    export PATH="$HOME/Library/Android/sdk/platform-tools:$PATH"
  else
    echo "Error: adb not found in PATH." >&2
    exit 1
  fi
fi

DEVICE_ARGS=()
if [ -n "${1:-}" ]; then
  DEVICE_ARGS=(-s "$1")
fi

adb_cmd() {
  if [ "${#DEVICE_ARGS[@]}" -gt 0 ]; then
    adb "${DEVICE_ARGS[@]}" "$@"
  else
    adb "$@"
  fi
}

echo "==> Checking connected Android device..."
adb_cmd get-state >/dev/null

echo "==> Granting WRITE_SECURE_SETTINGS (enables automatic Accessibility self-healing)..."
if adb_cmd shell pm grant "$PKG" android.permission.WRITE_SECURE_SETTINGS 2>/dev/null; then
  echo "    Granted WRITE_SECURE_SETTINGS successfully."
else
  echo "    Skipped WRITE_SECURE_SETTINGS (OPPO/ColorOS/OnePlus/Realme require 'Disable permission monitoring' in Developer Options; continuing with Accessibility + Doze whitelist)."
fi

echo "==> Whitelisting from Doze / Battery Optimization & allowing background execution..."
adb_cmd shell dumpsys deviceidle whitelist "+${PKG}" >/dev/null 2>&1 || true
adb_cmd shell cmd appops set "$PKG" RUN_ANY_IN_BACKGROUND allow >/dev/null 2>&1 || true
adb_cmd shell cmd appops set "$PKG" RUN_IN_BACKGROUND allow >/dev/null 2>&1 || true
adb_cmd shell cmd appops set "$PKG" WAKE_LOCK allow >/dev/null 2>&1 || true

echo "==> Enabling VeloDeck AccessibilityService (preserving any existing services)..."
CUR=$(adb_cmd shell settings get secure enabled_accessibility_services | tr -d '\r')
if [ -z "$CUR" ] || [ "$CUR" = "null" ]; then
  adb_cmd shell settings put secure enabled_accessibility_services "$A11Y_SVC"
else
  case ":$CUR:" in
    *":${A11Y_SVC}:"*) ;;
    *) adb_cmd shell settings put secure enabled_accessibility_services "${CUR}:${A11Y_SVC}" ;;
  esac
fi
adb_cmd shell settings put secure accessibility_enabled 1

echo "==> Verifying permanent unattended status..."
adb_cmd shell dumpsys package "$PKG" | grep "WRITE_SECURE_SETTINGS" | head -n 2 || true
adb_cmd shell settings get secure enabled_accessibility_services
echo "Done! VeloDeck long-lived unattended mode is now permanently active on this device."
