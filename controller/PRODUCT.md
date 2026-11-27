# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Individual device owners who keep 1–5 spare Android phones running unattended at home or on cellular networks (Wi-Fi or 4G/5G in Mainland China) and control them remotely from their primary iPhone (Safari / Add-to-Home-Screen PWA) or desktop browser while away.

## Product Purpose

VeloDeck（极控） lets the owner remotely view, tap, swipe, wake, unlock, and type into their own Android phones at any time with zero per-session confirmation dialogs and 7×24 long-running auto-reconnect stability. Success means opening the web app on an iPhone or desktop, connecting in seconds via a 9-digit control code or shared account, and operating the remote phone as naturally as holding it.

## Positioning

Unlike generic remote-support tools that require per-session approval or overseas VPN relays, VeloDeck runs on the owner's own self-hosted relay server (zero overseas network dependency) with persistent MediaProjection capture, unattended password + account auto-lock, and an embedded Release APK download directly from the same server.

## Operating Context

- Primary controller device: iPhone Safari / iOS standalone PWA (one-handed thumb operation in daylight, commuting, office, or evening environments) plus desktop browsers.
- Controlled device: unattended Android phones running VeloDeck Agent on domestic Wi-Fi or 4G/5G.
- Core workflows:
  1. Connect quickly by entering a 9-digit control code + unattended password (or tapping a recent device).
  2. Sign in / register an account to view all bound Android devices with live online status, battery, lock/screen state, 1-tap Wake, and 1-tap Control.
  3. Operate the remote phone full-screen with touch gestures, back/home/recents/notifications keys, wake/PIN unlock, Chinese IME text + clipboard sync, and quality/transport switching.
  4. Manage account security (change password, revoke all sessions) and download the signed Android Release APK directly from the server.

## Capabilities and Constraints

- React 19 + TypeScript + Vite + Tailwind CSS v4 frontend served by Node.js relay server over self-hosted HTTP or HTTPS/WSS (`VITE_DEFAULT_API_BASE` / `VITE_DEFAULT_WS_URL` configurable for native shells).
- Strict Content-Security-Policy (`default-src 'self'; font-src 'self' data:`) — no third-party CDN fonts or external scripts; any custom fonts must be self-hosted locally in `controller/public/fonts/` or use carefully tuned local stacks.
- All existing security behaviors must be preserved verbatim: no plaintext control passwords in `localStorage`, session-only password caching, first-user-then-invite registration lock with invite code support, SHA-256 APK verification display, external quick-connect confirmation modal, DataChannel isolation, and password/logout-all controls.
- Remote viewport (`RemoteViewport.tsx`) must remain full-bleed (`100dvh`) with unobstructed touch interaction.

## Brand Commitments

- Name: **VeloDeck（极控）** (Chinese UI).
- Explicit user anti-reference: MUST NOT look "AI-generated" (reject generic dark-mode glassmorphism, glowing spotlights, dot-grid backgrounds, purple/indigo SaaS gradients, pulsing status kickers above headings, and 3-column icon feature boxes).

## Evidence on Hand

- Self-hosted relay server (e.g. `https://velodeck.example.com` or `http://203.0.113.10`) serving `/api/info`, `/api/auth/*`, `/api/download/velodeck-agent.apk`, and `/ws`.
- Signed Release Android APK (SHA-256 verified) hosted on the same server.
- Existing Vitest unit tests covering `GestureMapper`, `profiles`, `auth`, and `RemoteClient`.

## Product Principles

1. **Tool before theater**: Users open VeloDeck to connect to a phone immediately, not to read marketing copy or admire ambient dark glows.
2. **Daylight clarity & tactile precision**: Designed for real-world iPhone & desktop use in bright daylight as well as evening light, with crisp typographic hierarchy and unambiguous hardware status.
3. **Progressive disclosure**: Keep primary actions (connect via code, open online device, wake) effortless; tuck advanced LAN/self-hosted profiles, security settings, and SHA-256 details neatly out of the primary flow.
4. **Honest states**: Always surface real connection latency, lock/screen state, battery, and transport security plainly without fake hype or clutter.
