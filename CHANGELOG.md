# Changelog

All notable changes to **VeloDeck（极控）** are documented in this file.

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
