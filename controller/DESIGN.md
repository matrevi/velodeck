# VeloDeck Controller Design System (`DESIGN.md`)

## Direction: Daylight Hardware Console (Operate Mode)

VeloDeck（极控） is a self-hosted, 7×24 unattended mobile remote-control console. The UI treats remote device control as a serious, reliable engineering utility — inspired by Tailscale's daylight fleet console, Stripe's tabular clarity, and physical industrial instrumentation — rather than a dark-glass marketing template.

### Aesthetic Commitments
- **Daylight workspace, pitch-black live canvas**: Launch, Account, Fleet Dashboard, and Settings modals live on a daylight chalk surface (`#F4F5F7`) anchored by a solid deep-ink top bar (`#111318`). Entering `RemoteViewport` switches cleanly to pitch-black (`#000000`) OLED framing so the live phone screen has zero visual competition.
- **Hairline geometry over shadows and blur**: Containers use `1px solid var(--border-hairline)` on solid `#FFFFFF` paper panels with a minimal downward shadow (`0 1px 2px rgba(17, 19, 24, 0.045)`). No glassmorphism (`backdrop-blur`), dot-grids, radial ambient glows, gradient headline fills, or bouncing status indicators.
- **Flat single-sheet information hierarchy**: Fleet devices and recent sessions render as dense horizontal rows separated by hairline dividers inside one unified sheet — never nested cards inside cards.
- **Signature craft detail**: The 9-digit remote control code uses a mechanical `3-3-3` segmented tabular-mono input (`XXX – XXX – XXX`) backed by a single real accessible input for seamless paste, autofill, keyboard focus, and mobile numeric keypad entry.

## Color Tokens (`src/index.css`)

| Token | Value (OKLCH) | Approximate Hex | Role |
|---|---|---|---|
| `--bg-ground` | `oklch(0.966 0.003 255)` | `#F4F5F7` | Page canvas |
| `--bg-surface` | `oklch(1 0 0)` | `#FFFFFF` | Panels, inputs, modals |
| `--bg-subtle` | `oklch(0.978 0.003 255)` | `#F8F9FB` | Table headers, secondary bands |
| `--shell-bg` | `oklch(0.185 0.01 262)` | `#111318` | Committed top chrome & viewport HUD |
| `--shell-border` | `oklch(0.28 0.012 262)` | `#262A34` | Top bar bottom border |
| `--ink-primary` | `oklch(0.18 0.012 262)` | `#111318` | Primary headings & data |
| `--ink-secondary` | `oklch(0.41 0.016 260)` | `#4B5563` | Supporting copy |
| `--ink-muted` | `oklch(0.51 0.015 260)` | `#6B7280` | Metadata & placeholders |
| `--border-hairline` | `oklch(0.905 0.006 258)` | `#E2E6EC` | Panel edges & row dividers |
| `--border-strong` | `oklch(0.835 0.01 258)` | `#CBD2DC` | Input & outline button borders |
| `--accent` | `oklch(0.546 0.215 262.88)` | `#2563EB` | Primary CTA, active tab, focus ring |
| `--accent-hover` | `oklch(0.488 0.217 264.38)` | `#1D4ED8` | Primary CTA hover |
| `--accent-tint` | `oklch(0.96 0.025 260)` | `#EFF6FF` | Subtle active highlights |
| `--status-ok` / `ok-bg` | `oklch(0.52 0.15 152)` / `0.965` | `#15803D` / `#ECFDF3` | Online / connected state |
| `--status-warn` / `warn-bg` | `oklch(0.55 0.15 65)` / `0.975` | `#B45309` / `#FFFBEB` | Reconnecting / attention state |
| `--status-danger` / `danger-bg` | `oklch(0.54 0.205 26)` / `0.968` | `#DC2626` / `#FEF2F2` | Destructive / error state |

## Typography & Offline CSP Compliance

- **No external web fonts**: Server enforces strict `Content-Security-Policy` (`default-src 'self'`). All typography relies on native system sans (`-apple-system`, `SF Pro Text`, `PingFang SC`, `Hiragino Sans GB`, `Microsoft YaHei`) and native monospace (`SF Mono`, `ui-monospace`, `Menlo`, `Consolas`).
- **Tabular numerals**: `.font-mono` enforces `font-variant-numeric: tabular-nums` for control codes, RTT telemetry, frame counters, battery percentages, timestamps, and SHA-256 digests.

## Motion & Accessibility

- Transitions use crisp hardware easing (`150ms–180ms cubic-bezier(0.2, 0, 0, 1)`).
- Touch feedback uses a single `.animate-touch-ripple` expansion; bottom sheets use `.animate-sheet-up`.
- `@media (prefers-reduced-motion: reduce)` disables animations and transitions globally.
- Interactive controls meet minimum touch targets (`>= 40px` desktop / `>= 44px` mobile), use explicit `focus-visible` outlines, and maintain WCAG AA contrast on both `#FFFFFF` and `#111318` surfaces.
