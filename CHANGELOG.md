# Changelog

All notable changes to **VeloDeck（极控）** are documented in this file.

## [Unreleased / Desktop Pro & RustDesk-Grade Remote Suite] - 2026-11-28

### RustDesk-Grade Controller & Remote Desktop Enhancements
- **Cross-OS Smart Keymap (Mac ↔ Win)**: Automatic `Cmd`↔`Ctrl` shortcut translation (`Cmd+C/V/A/Z/F/S/W/T/...`) when controlling Windows/Linux from macOS or macOS from Windows, with mapped key-release tracking and 1-click `智能 / 原生 (Raw)` toggle.
- **4-Edge Collapsible Floating Toolbar**: Switchable `标准顶栏 / 悬浮条` chrome mode with draggable top/bottom/left/right edge snapping so full-screen remote control never obscures remote macOS menu bars or Windows taskbars.
- **View Styles & View-Only Mode**: Switch between `自适应` (`adaptive`), `1:1 原画` (`original` native DPR pixels with scrollbars), and `铺满` (`stretch`), plus 1-click **「只读观察」** lock that blocks accidental remote input.
- **Local Session Recording**: Zero-dependency `MediaRecorder` local `.webm`/`.mp4` video+audio recording (including WS-JPEG canvas fallback) with pulsing `REC mm:ss` HUD badge and instant file download.
- **Multi-Tab Concurrent Session Manager**: Keep up to **4 simultaneous live WebRTC sessions** warm inside a single window with instant tab switching (`DesktopTabBar`) and strict active-tab keyboard/shortcut isolation.
- **LAN Peer Discovery & Wake-on-LAN (WOL)**: Local UDP `:21119` LAN host discovery (metadata-only, zero secrets) plus 1-click 102-byte UDP `:9` WOL magic packets via local NIC or online `wolRelay` peer host.
- **Remote Interactive PTY Terminal**: Dedicated WebRTC `"terminal"` DataChannel launching remote interactive shells (macOS/Linux PTY + Windows PowerShell) with ANSI SGR color rendering, quick control keys (`Ctrl+C/D/Tab/↑/↓`), and resize sync.
- **Relative Mouse Lock (`Cmd/Ctrl+G`) & Real-Time Remote Cursor Shape Sync**: Pointer Lock relative `dx/dy` injection for 3D/CAD/FPS apps plus 140ms system cursor shape polling (`I-beam`, `pointer`, resize arrows, etc.) synced over `"pointer"` DataChannel.
- **Block Remote Physical Input**: Host-side physical keyboard/mouse lock (`CGEventTap` on macOS, Win32 `BlockInput` on Windows) while still accepting tagged VeloDeck remote input, with guaranteed `Cmd/Ctrl+Alt+Esc` emergency unlock.
- **Interactive Host Approval & Granular Permissions**: Optional `confirm`（「来访弹窗审批」）host access mode with 60s OS notification + per-session permission toggles (`keyboard`, `mouse`, `clipboard`, `fileTransfer`, `audio`, `terminal`) enforced on both host and controller.
- **Session Text Chat & Click-Through Screen Whiteboard**: Built-in real-time bidirectional session chat drawer (`chat.msg`) and normalized `[0..1]` multi-color screen annotation overlay (`whiteboard`) rendered transparently over the remote display with 8-second auto-fade.

### Bidirectional Desktop App (macOS & Windows · `desktop/`)
- **Native Desktop Controller**: Electron app (`app://velodeck`) with hardware H.264/HEVC WebRTC decode, `backgroundThrottling: false`, Always-on-Top PiP phone mode, window presets (`430×880` / `1100×760` / `360×740`), System Tray, right-click Back & middle-click Home for Android targets, 1-click HD screenshot copy/save, multi-window multi-device control, and built-in Self-Hosted Server Switcher (`Cmd/Ctrl+,`).
- **Pro Desktop Host（「本机被控」）**:
  - **High-Refresh & 2K/4K + Multi-Codec**: 30/60/90/120 fps capture up to 3840×2160, codec selection (`auto | h264 | hevc | av1 | vp9`), up to 30 Mbps LAN P2P bitrate while preserving tight anti-bufferbloat ceilings on 3 Mbps TURN relays.
  - **Real-Time Loopback System Audio**: Native macOS 13+ ScreenCaptureKit & Windows WASAPI loopback audio streaming over WebRTC Opus with zero virtual audio drivers, plus controller mute/volume HUD.
  - **7×24 Unattended & Privacy**: Auto-launch on login, `powerSaveBlocker` prevent-sleep, multi-display opaque `setContentProtection(true)` anti-peep Privacy Screen (`Cmd/Ctrl+Alt+Esc` emergency dismiss), and audited Remote Power Management (`lock` / `sleep` / `restart` / `shutdown` with 2-step confirmation).
  - **Native OS Input Injection**: Persistent zero-fork Swift CoreGraphics (`CGEvent`) daemon on macOS and inline C# Win32 `SendInput` daemon on Windows (full mouse hover/clicks/drag/scroll, keyboard chords, and Unicode/Chinese typing).
  - **Two-Way Remote File Manager**: Browse drives/folders, download files with chunked SHA-256 verification, upload into any remote folder, mkdir, and safe OS Trash deletion over encrypted WebRTC DataChannel.
  - **Pro Remote-PC UX**: Automatic two-way clipboard sync (loop-guarded), adaptive macOS/Windows Desktop Shortcut Pad with sticky modifiers, multi-monitor hot-switching, and mobile 1×–4× pinch-to-zoom with transform-accurate touch mapping & direct/trackpad modes.

## [v1.0.9] - 2026-11-27

### Core Platform & Streaming
- **60fps Hardware H.264 WebRTC Pipeline**: Low-latency `MediaCodec` H.264 (`ConstrainedHigh`, AVC Level 5.1/5.2) over WebRTC with automatic WebSocket binary fallback and `jitterBufferTarget = 0`.
- **RustDesk-Inspired Adaptive QoS & Default `auto`（「智能」）Preset**:
  - 20-sample sliding baseline RTT tracker with single-jitter immunity, Bitrate-First → FPS-Second congestion control, and 8-second hysteretic resolution scaling.
  - Anti-bufferbloat WebRTC pacing (`pacing_factor:1.25`, `CongestionWindow QueueSize:120`, `DropFrame:true`) tuned for both LAN P2P and bandwidth-capped 3 Mbps cloud TURN relays.
- **Scroll Mosquito-Noise Elimination**: Tightened Android 12+ hardware QP bounds (`QP_MIN=18`, `QP_I_MAX=34`, `QP_P_MAX=37`), `-4%` / 80ms micro VBV re-arm on real motion resume only, 2-frame post-scroll refinement polish, and BPP-optimal `720p@60 @ 2.2 Mbps` TURN tier.
- **NAT Traversal**: Co-located self-hosted STUN priority + UDP-first ephemeral HMAC-SHA1 `coturn` relay credentials (`3478/UDP+TCP`, `49152-65535/UDP`).

### Unattended Android Agent & Remote Control
- **System-Wide Force Portrait**: Zero-extra-permission `TYPE_ACCESSIBILITY_OVERLAY` portrait lock with remote toggle & live telemetry.
- **Zero-Disconnect Stealth Black Screen**: `1×1` dimmed overlay & black-curtain toggle without tearing down active relay sessions.
- **Low-Latency Input**: Ordered unreliable (`maxRetransmits: 0`) `"pointer"` DataChannel, `45ms` tap/swipe gesture threshold, monotonic `TouchMove` coalescing, bidirectional clipboard, and IME text input.

### Self-Hosting, OTA & Updates
- **Native In-App Self-Updater & WebRTC OTA Push**: SHA-256 verified APK downloads with content-addressed filenames (`velodeck-self-update-<sha12>.apk` / `velodeck-ota-<sha12>.apk`), `FLAG_ACTIVITY_CLEAR_TOP`, versioned server download route (`/api/download/velodeck-agent-v1.0.9.apk`), strict `Cache-Control: no-store`, and automatic controller `/api/info` refresh on reconnect.
- **Fork-Friendly Deployment**: Complete [Self-Hosting Guide](docs/SELF_HOSTING.md), Docker Compose templates (Domain+Caddy auto-HTTPS & Pure-IP), config examples (`server/.env.example`, `android-agent/local.properties.example`, `android-agent/keystore.properties.example`), and opt-in GitHub Actions cloud APK builder (`.github/workflows/build-custom-apk.yml`).
