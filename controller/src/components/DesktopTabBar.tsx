import { memo, useSyncExternalStore } from "react";
import {
  ExternalLink,
  LayoutGrid,
  Monitor,
  Smartphone,
  X,
} from "lucide-react";
import { isDesktopApp, isMacDesktop } from "../desktop/bridge";
import type { RemoteClient, RemoteClientState } from "../transport/RemoteClient";

export interface OpenSessionTab {
  deviceId: string;
  label: string;
  deviceType: "android" | "desktop";
}

export interface DesktopTabBarProps {
  tabs: OpenSessionTab[];
  activeTabId: "dashboard" | string;
  maxTabs?: number;
  getTabClient: (deviceId: string) => RemoteClient | undefined;
  tabStates: Record<string, RemoteClientState | undefined>;
  tabRecordingMap?: Record<string, boolean | undefined>;
  hostPendingApproval?: boolean;
  onSelectTab: (tabId: "dashboard" | string) => void;
  onCloseTab: (deviceId: string) => void;
  onOpenNewWindow?: () => void;
}

export const DesktopTabBar = memo(function DesktopTabBar({
  tabs,
  activeTabId,
  maxTabs = 4,
  getTabClient,
  tabStates,
  tabRecordingMap,
  hostPendingApproval = false,
  onSelectTab,
  onCloseTab,
  onOpenNewWindow,
}: DesktopTabBarProps) {
  const desktopApp = isDesktopApp();
  const macDesktop = isMacDesktop();

  if (tabs.length === 0) {
    return null;
  }

  return (
    <nav
      aria-label="多设备远控标签页"
      className={`${
        desktopApp ? "desktop-drag-region" : "safe-top"
      } relative z-50 flex h-10 shrink-0 items-center justify-between gap-2 border-b border-[#262A34] bg-[#111318] text-zinc-200 select-none ${
        macDesktop ? "pl-[80px] pr-2.5" : "px-2.5"
      }`}
    >
      <div className="desktop-no-drag flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-1">
        {/* Pinned Fleet Dashboard Tab */}
        <button
          type="button"
          onClick={() => onSelectTab("dashboard")}
          aria-current={activeTabId === "dashboard" ? "page" : undefined}
          className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition ${
            activeTabId === "dashboard"
              ? "border-[#3B82F6] bg-[#2563EB] text-white"
              : "border-[#262A34] bg-[#181C24] text-zinc-300 hover:border-[#3A4152] hover:bg-[#202531] hover:text-white"
          }`}
        >
          <LayoutGrid className="h-3.5 w-3.5 shrink-0" />
          <span>设备总览</span>
          {hostPendingApproval && (
            <span
              className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-amber-400"
              title="本机有待审批的远程接入请求"
            />
          )}
        </button>

        <span
          aria-hidden="true"
          className="mx-0.5 h-4 w-px shrink-0 bg-[#262A34]"
        />

        {/* Active Remote Session Tabs */}
        <div
          role="tablist"
          aria-label="已打开远控会话"
          className="flex min-w-0 items-center gap-1"
        >
          {tabs.map((tab) => {
            const isActive = activeTabId === tab.deviceId;
            const tabClient = getTabClient(tab.deviceId);
            const tabState = tabStates[tab.deviceId];
            const isRecording = Boolean(tabRecordingMap?.[tab.deviceId]);
            const unreadChatCount = tabState?.unreadChatCount ?? 0;
            const statusDotClass = (() => {
              if (!tabState) return "bg-amber-400";
              if (
                tabState.socketStatus === "connected" &&
                tabState.sessionStatus === "streaming"
              ) {
                return "bg-emerald-400";
              }
              if (
                tabState.socketStatus === "error" ||
                tabState.sessionStatus === "error" ||
                tabState.sessionStatus === "ended"
              ) {
                return "bg-rose-400";
              }
              return "bg-amber-400";
            })();

            return (
              <div
                key={tab.deviceId}
                className={`group inline-flex h-7 max-w-[260px] shrink-0 items-center rounded-md border text-xs font-medium transition ${
                  isActive
                    ? "border-[#3B82F6] bg-[#1E293B] text-white"
                    : "border-[#262A34] bg-[#161A22] text-zinc-300 hover:border-[#3A4152] hover:bg-[#1E2330] hover:text-white"
                }`}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => onSelectTab(tab.deviceId)}
                  className="inline-flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-l-md pl-2 pr-1 text-left focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#60A5FA]"
                >
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDotClass}`}
                  />
                  {tab.deviceType === "desktop" ? (
                    <Monitor className="h-3.5 w-3.5 shrink-0 text-sky-400" />
                  ) : (
                    <Smartphone className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                  )}
                  <span className="truncate">{tab.label}</span>
                  {isRecording && (
                    <span
                      className="inline-flex shrink-0 items-center gap-1 rounded bg-rose-500/20 px-1 py-0.2 font-mono text-[9px] font-semibold text-rose-300"
                      title="正在本地录屏"
                    >
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-rose-500" />
                      REC
                    </span>
                  )}
                  {unreadChatCount > 0 && (
                    <span
                      className="shrink-0 rounded-full bg-blue-500 px-1.5 py-0.2 font-mono text-[9px] font-semibold text-white"
                      title={`${unreadChatCount} 条未读会话消息`}
                    >
                      {unreadChatCount > 99 ? "99+" : unreadChatCount}
                    </span>
                  )}
                  {tabClient && (
                    <TabRttBadge client={tabClient} active={isActive} />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => onCloseTab(tab.deviceId)}
                  title={`断开并关闭「${tab.label}」`}
                  aria-label={`关闭标签页 ${tab.label}`}
                  className="mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded text-zinc-400 transition hover:bg-white/15 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#60A5FA]"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* Right-side Slot Counter & Open-in-New-Window */}
      <div className="desktop-no-drag flex shrink-0 items-center gap-1.5">
        <span
          className="hidden rounded border border-[#262A34] bg-[#0B0D12] px-1.5 py-0.5 font-mono text-[10px] text-zinc-400 sm:inline-block"
          title={`当前已打开 ${tabs.length} 个远控会话（上限 ${maxTabs} 个）`}
        >
          {tabs.length}/{maxTabs}
        </span>

        {desktopApp && onOpenNewWindow && (
          <button
            type="button"
            onClick={onOpenNewWindow}
            title="新窗口打开（多窗口并排远控）"
            aria-label="新窗口打开"
            className="btn-shell inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11px] font-medium"
          >
            <ExternalLink className="h-3 w-3 text-blue-400" />
            <span className="hidden md:inline">新窗口打开</span>
          </button>
        )}
      </div>
    </nav>
  );
});

const TabRttBadge = memo(function TabRttBadge({
  client,
  active,
}: {
  client: RemoteClient;
  active: boolean;
}) {
  const telemetry = useSyncExternalStore(
    client.subscribeTelemetry,
    client.getTelemetrySnapshot,
  );

  if (telemetry.rttMs === null) {
    return null;
  }

  return (
    <span
      className={`shrink-0 font-mono text-[10px] ${
        active ? "text-blue-200" : "text-zinc-400"
      }`}
    >
      {telemetry.rttMs}ms
    </span>
  );
});
